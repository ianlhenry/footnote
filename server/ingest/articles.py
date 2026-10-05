"""Load poll articles listed in a source's manifest into the corpus tables.

A source supplies one reader. It takes a manifest row and a fetch function
and returns the page's text blocks and the surveys it reports on. Everything
else is shared: the manifest, the fetch cache, chunking, embedding, survey
keys, and the writes.

Each URL is fetched once and saved under data/ingestion/<source>/cache/ after
the reader succeeds. A reader that skips a linked page it cannot read calls
fetch.forget(url), so an error or challenge page is never cached. A later
run reads that file instead of the network. Cached files never expire. With
refetch, every URL is downloaded again once per run, and a page that fails
to read keeps its old cached copy.

Every run re-reads every page and rewrites its metadata and survey links. A
page is embedded again only when its passage text changes or its vectors
came from another model. Documents no longer in the manifest are deleted.

Text blocks under one heading are merged into passages of up to MAX_CHARS.
Each chart stays its own passage. Every passage starts with the article title
and its section heading so the chunk still says what it is about.
"""

import csv
import hashlib
import io
import json
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

from pypdf import PdfReader

from server.db import REPO_ROOT, connect_vectors, load_env
from server.ingest.corpus import (
    EMBEDDING_DIMENSION,
    EMBEDDING_MODEL,
    IngestError,
    SchemaMismatch,
    connect_corpus,
    document_state,
    prune,
    rebuild,
    replace_document,
    schema_missing,
    schema_ready,
    stored_surveys,
    update_document,
)

# pypdf logs repairs to malformed cross-reference tables, which poll PDFs often have.
logging.getLogger("pypdf").setLevel(logging.ERROR)

INGESTION_DIR = REPO_ROOT / "data" / "ingestion"
VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
USER_AGENT = "Mozilla/5.0 (compatible; Footnote/1.0)"
MIN_CHARS = 40
MAX_CHARS = 800
RETRY_STATUS = {429, 500, 502, 503, 504}
# Survey values that can come from different places, and that the check at the
# end of a run expects. Field dates are always set, by the survey's main source.
SOURCED_FIELDS = ("geography", "sample_size", "population", "margin_of_error")
# A survey's geography is "US", a state's postal code, or "INTL" for several countries.
STATE_CODES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
    "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
    "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}

MONTH = (
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?"
    r"|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


class HTTPFailure(RuntimeError):
    def __init__(self, label, code, detail=""):
        message = f"{label} HTTP {code}"
        if detail:
            message += f": {detail[:300]}"
        super().__init__(message)
        self.code = code


def ingest_articles(source, label, read, no_write=False, refetch=False):
    """Load every row of data/ingestion/<source>/<source>_manifest.csv.

    read(row, fetch) returns {"blocks": [...], "surveys": [...]} and may add
    "published_on". A block is {"section", "text", "kind"}, where kind is
    "text" or "chart". A survey has geography, field_start, field_end,
    sample_size, population, margin_of_error, and metadata_source.
    """
    load_env()
    directory = INGESTION_DIR / source
    rows = _manifest(directory / f"{source}_manifest.csv")
    manifest_urls = {row["url"] for row in rows}
    conn = connect_corpus(readonly=no_write)
    try:
        # A write connection has already refused a mismatch. Refuse it here
        # too, so --no-write does not preview a run that would fail.
        if conn is not None and not schema_ready(conn) and not schema_missing(conn):
            raise SchemaMismatch()
        ready = conn is not None and schema_ready(conn)
        stored = document_state(conn, source) if ready else {}
        pages, failures = _read_pages(rows, read, directory / "cache", refetch)
        _resolve_surveys(source, pages, stored_surveys(conn, source) if ready else [])
        for page in pages:
            page["action"] = _action(page, stored.get(page["url"]))
        removed = sorted(set(stored) - manifest_urls)
        if no_write:
            _print_preview(label, pages, removed, failures)
        else:
            _write(conn, source, label, pages, manifest_urls, failures)
        _print_gaps(label, pages)
    finally:
        if conn is not None:
            conn.close()


def rebuild_articles(sources, no_write=False, refetch=False):
    """Replace the corpus tables with every source's pages, embedded again.

    sources holds (source, label, read) for every corpus source, since the
    old tables go away for all of them. Pages are read and embedded first, and
    the tables are swapped in one transaction at the end, so a failure before
    then leaves the old tables in place. Any page that fails to read or embed
    stops the rebuild, since a Voyage outage or a fetch failure would
    otherwise swap in a partial or empty corpus. A page that always fails has
    to be fixed or removed from its manifest first.
    """
    load_env()
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not no_write and not api_key:
        raise IngestError("rebuilding the corpus embeds every passage. Set VOYAGE_API_KEY.")
    loads = []
    for source, label, read in sources:
        directory = INGESTION_DIR / source
        rows = _manifest(directory / f"{source}_manifest.csv")
        pages, failures = _read_pages(rows, read, directory / "cache", refetch)
        # The old surveys are in a layout this code cannot read.
        _resolve_surveys(source, pages, [])
        for page in pages:
            page["action"] = "insert"
        loads.append({"source": source, "label": label, "pages": pages, "failures": failures})

    if no_write:
        print("Would drop the corpus tables and recreate them with these documents.")
        for load in loads:
            _print_preview(load["label"], load["pages"], [], load["failures"])
            _print_gaps(load["label"], load["pages"])
        if any(load["failures"] for load in loads):
            print("The rebuild would stop: every page has to read cleanly.")
        return

    failed = 0
    for load in loads:
        _print_failures(load["label"], load["failures"])
        failed += len(load["failures"])
    if failed:
        raise IngestError(
            f"{failed} pages failed to read, so the corpus was not rebuilt. "
            "Fix them or remove them from the manifest."
        )
    documents = []
    for load in loads:
        for page in load["pages"]:
            try:
                vectors = _embed(page["passages"], api_key)
            except Exception as error:
                if isinstance(error, HTTPFailure) and error.code in (401, 403):
                    raise
                raise IngestError(
                    f"{page['url']} failed to embed, so the corpus was not rebuilt: {error}"
                ) from error
            documents.append(
                (_document(load["source"], page), page["passages"], vectors, page["surveys"])
            )
    conn = connect_vectors()
    try:
        rebuild(conn, documents)
    finally:
        conn.close()
    for load in loads:
        passages = sum(len(page["passages"]) for page in load["pages"])
        print(f"{load['label']}: rebuilt with {len(load['pages'])} articles, {passages} passages.")
        _print_gaps(load["label"], load["pages"])


def _read_pages(rows, read, cache_dir, refetch):
    pages = []
    failures = []
    # With refetch, URLs already downloaded this run, such as a methodology
    # page several articles link, are read from the cache.
    fresh = set() if refetch else None
    for row in rows:
        url = row["url"]
        cache = _Cache(cache_dir, fresh)
        try:
            found = read(row, cache)
            passages = chunk(row["title"], found["blocks"])
            if not passages:
                raise RuntimeError("no article text")
        except Exception as error:
            failures.append(f"{url}: {error}")
            continue
        cache.commit()
        pages.append(
            {
                "row": row,
                "url": url,
                "passages": passages,
                "content_hash": _content_hash(passages),
                "fetched_at": _fetched_at(cache_dir, url),
                "published_on": found.get("published_on") or row["published"] or None,
                "surveys": found["surveys"],
            }
        )
    return pages, failures


class _Cache:
    """Fetched bodies wait here until the page reads cleanly.

    Readers call the cache itself to fetch, and forget(url) to drop a body
    they could not read. A body this run downloaded is never saved. One read
    from a file cached by an earlier run is deleted. A failed download
    changes nothing, so an old copy survives a refetch that times out.
    fresh is None, or the set of paths downloaded this run when every URL is
    fetched again.
    """

    def __init__(self, directory, fresh=None):
        self.directory = directory
        self.fresh = fresh
        self.pending = {}
        self.from_disk = set()

    def __call__(self, url):
        path = _cache_path(self.directory, url)
        if path in self.pending:
            return self.pending[path]
        stale = self.fresh is not None and path not in self.fresh
        if not stale and path.exists() and path.stat().st_size > 0:
            self.from_disk.add(path)
            return path.read_bytes()
        body = _download(url)
        self.pending[path] = body
        return body

    def forget(self, url):
        path = _cache_path(self.directory, url)
        if self.pending.pop(path, None) is None and path in self.from_disk:
            path.unlink(missing_ok=True)

    def commit(self):
        if self.pending:
            self.directory.mkdir(parents=True, exist_ok=True)
        for path, body in self.pending.items():
            path.write_bytes(body)
            if self.fresh is not None:
                self.fresh.add(path)
        self.pending = {}


def chunk(title, blocks):
    """Merge text blocks under one heading and prefix each passage with its title and section."""
    return [_passage(title, block) for block in _merge(blocks)]


def _merge(blocks):
    merged = []
    for block in blocks:
        last = merged[-1] if merged else None
        if (
            last is not None
            and block["kind"] == "text"
            and last["kind"] == "text"
            and last["section"] == block["section"]
            and len(last["text"]) + len(block["text"]) + 2 <= MAX_CHARS
        ):
            last["text"] += "\n\n" + block["text"]
        else:
            merged.append(dict(block))
    return [block for block in merged if len(block["text"]) >= MIN_CHARS]


def _passage(title, block):
    head = title
    if block["section"] and block["section"] != title:
        head += "\n" + block["section"]
    return f"{head}\n\n{block['text']}"


def clean(text):
    return " ".join(text.split())


def describe_sources(main, fields):
    """metadata_source text. 'pdf' with {'sample_size': 'page'} gives 'pdf; page for sample_size'."""
    others = {}
    for field in SOURCED_FIELDS:
        source = fields.get(field, main)
        if source != main:
            others.setdefault(source, []).append(field)
    return "; ".join([main] + [f"{name} for {', '.join(names)}" for name, names in others.items()])


def read_sources(text):
    """The main source and the per-field exceptions in metadata_source text."""
    if not text:
        return None, {}
    main, *rest = text.split("; ")
    fields = {}
    for part in rest:
        name, _, names = part.partition(" for ")
        for field in names.split(", "):
            fields[field] = name
    return main, fields


def is_pdf(body):
    return body[:5] == b"%PDF-"


def pdf_text(body, pages=None):
    """The text of a PDF's first `pages` pages, or of every page."""
    reader = PdfReader(io.BytesIO(body))
    return "\n".join(page.extract_text() or "" for page in reader.pages[:pages])


def iso_date(year, month, day):
    return date(year, month_number(month), day).isoformat()


def month_number(name):
    return MONTHS[name.lower()[:3]]


def _action(page, known):
    if known is None:
        return "insert"
    if known["content_hash"] != page["content_hash"] or known["models"] != {EMBEDDING_MODEL}:
        return "replace"
    return "update"


def _write(conn, source, label, pages, manifest_urls, failures):
    to_embed = [page for page in pages if page["action"] != "update"]
    api_key = os.environ.get("VOYAGE_API_KEY")
    if to_embed and not api_key:
        passages = sum(len(page["passages"]) for page in to_embed)
        _print_failures(label, failures)
        raise IngestError(
            f"{len(to_embed)} articles ({passages} passages) need embedding. "
            "Set VOYAGE_API_KEY to embed and store them."
        )

    embedded = 0
    updated = 0
    passage_count = 0
    for page in pages:
        document = _document(source, page)
        try:
            if page["action"] == "update":
                update_document(conn, document, page["surveys"])
                updated += 1
                continue
            vectors = _embed(page["passages"], api_key)
            replace_document(conn, document, page["passages"], vectors, page["surveys"])
        except Exception as error:
            # A bad key fails every page the same way.
            if isinstance(error, HTTPFailure) and error.code in (401, 403):
                raise
            failures.append(f"{page['url']}: {error}")
            continue
        embedded += 1
        passage_count += len(page["passages"])
        print(f"{label} stored {document['title']} ({len(page['passages'])} passages).")
    removed = prune(conn, source, manifest_urls)
    for url in removed:
        print(f"{label} deleted {url}")
    print(
        f"{label}: embedded {embedded} articles, {passage_count} passages. "
        f"Updated {updated} unchanged. Deleted {len(removed)}. Failed {len(failures)}."
    )
    _print_failures(label, failures)


def _document(source, page):
    row = page["row"]
    return {
        "source": source,
        "title": row["title"],
        "url": page["url"],
        "topic": row["topic"] or None,
        "published_on": page["published_on"],
        "doc_type": row["doc_type"] or None,
        "fetched_at": page["fetched_at"],
        "content_hash": page["content_hash"],
    }


def _print_failures(label, failures):
    for failure in failures:
        print(f"{label} failed: {failure}")


def _print_preview(label, pages, removed, failures):
    to_embed = [page for page in pages if page["action"] != "update"]
    passage_count = sum(len(page["passages"]) for page in to_embed)
    print(
        f"{label} would embed {passage_count} passages with {EMBEDDING_MODEL} "
        f"for {len(to_embed)} documents, update metadata on "
        f"{len(pages) - len(to_embed)} unchanged, and delete {len(removed)}. "
        f"Failed {len(failures)}."
    )
    for url in removed:
        print(f"delete {url}")
    for failure in failures:
        print(f"fail {failure}")
    labels = {"insert": "insert", "replace": "embed again", "update": "update metadata"}
    for page in pages:
        row = page["row"]
        print(f"\ndocument {row['title']}")
        print(f"  action: {labels[page['action']]}")
        print(f"  url: {page['url']}")
        print(f"  doc_type: {row['doc_type'] or 'none'}")
        print(f"  topic: {row['topic'] or 'none'}")
        print(f"  published_on: {page['published_on'] or 'none'}")
        print(f"  fetched_at: {page['fetched_at']}")
        print(f"  content_hash: {page['content_hash']}")
        print(f"  passages: {len(page['passages'])}")
        if not page["surveys"]:
            print("  surveys: none")
        for survey in page["surveys"]:
            print(
                f"  survey {survey['survey_key']}: "
                f"geography {_or_none(survey['geography'])}, "
                f"field {survey['field_start']} to {survey['field_end']}, "
                f"sample_size {_or_none(survey['sample_size'])}, "
                f"population {_or_none(survey['population'])}, "
                f"margin_of_error {_or_none(survey['margin_of_error'])}, "
                f"metadata_source {_or_none(survey['metadata_source'])}"
            )
        if page["action"] == "update":
            continue
        for position, text in enumerate(page["passages"]):
            print(f"\n  [{position}] {text}")


def _print_gaps(label, pages):
    """List each survey still missing a value, and each page that cites no survey."""
    surveys = {}
    for page in pages:
        for survey in page["surveys"]:
            surveys[survey["survey_key"]] = survey
    gaps = []
    for key, survey in surveys.items():
        missing = [field for field in SOURCED_FIELDS if survey[field] is None]
        if missing:
            gaps.append(
                f"  {key}: missing {', '.join(missing)} "
                f"(metadata_source {_or_none(survey['metadata_source'])})"
            )
    unlinked = [page["url"] for page in pages if not page["surveys"]]
    print(
        f"\n{label} check: {len(gaps)} of {len(surveys)} surveys missing a field. "
        f"{len(unlinked)} pages cite no survey."
    )
    for line in gaps:
        print(line)
    for url in unlinked:
        print(f"  no survey: {url}")


def _or_none(value):
    return "none" if value is None else value


def _resolve_surveys(source, pages, stored):
    """Key each page's surveys and merge the values every page found for one survey.

    The key is the pollster, the geography, and the field dates, so two state
    polls fielded on the same dates stay apart. A survey found without a
    geography takes the one geography known for the same dates, when there is
    exactly one. Each other value comes from the first page that states it,
    or else from the stored survey, and metadata_source names where each
    value came from.
    """
    places = {}
    for survey in stored + [survey for page in pages for survey in page["surveys"]]:
        if survey["geography"] is not None:
            dates = (survey["field_start"], survey["field_end"])
            places.setdefault(dates, set()).add(survey["geography"])
    merged = {}
    # Per survey key: the main source, and where each value that was taken came from.
    origins = {}

    def absorb(survey, geography):
        key = _survey_key(source, geography, survey["field_start"], survey["field_end"])
        entry = merged.setdefault(
            key,
            {
                "source": source,
                "survey_key": key,
                "geography": geography,
                "field_start": survey["field_start"],
                "field_end": survey["field_end"],
                "sample_size": None,
                "population": None,
                "margin_of_error": None,
                "metadata_source": None,
            },
        )
        main, fields = read_sources(survey.get("metadata_source"))
        origin = origins.setdefault(key, [main, {}])
        if origin[0] is None:
            origin[0] = main
        if survey["geography"] is not None and "geography" not in origin[1]:
            origin[1]["geography"] = fields.get("geography", main)
        for field in ("sample_size", "population", "margin_of_error"):
            if entry[field] is None and survey.get(field) is not None:
                entry[field] = survey[field]
                origin[1][field] = fields.get(field, main)
        return key

    for page in pages:
        keys = []
        for survey in page["surveys"]:
            geography = survey["geography"]
            if geography is None:
                known = places.get((survey["field_start"], survey["field_end"]), set())
                if len(known) == 1:
                    geography = next(iter(known))
            key = absorb(survey, geography)
            if key not in keys:
                keys.append(key)
        page["survey_keys"] = keys
    # Stored values only fill what this run's pages left out.
    for survey in stored:
        absorb(survey, survey["geography"])
    for key, (main, fields) in origins.items():
        if main is not None:
            merged[key]["metadata_source"] = describe_sources(main, fields)
    for page in pages:
        page["surveys"] = [merged[key] for key in page.pop("survey_keys")]


def _survey_key(source, geography, field_start, field_end):
    return f"{source}-{geography or 'unknown'}-{field_start}-{field_end}"


def _content_hash(passages):
    return hashlib.sha256("\n\n".join(passages).encode()).hexdigest()


def _cache_path(directory, url):
    suffix = ".pdf" if urllib.parse.urlparse(url).path.lower().endswith(".pdf") else ".html"
    return directory / f"{hashlib.sha256(url.encode()).hexdigest()}{suffix}"


def _fetched_at(directory, url):
    stamp = datetime.fromtimestamp(_cache_path(directory, url).stat().st_mtime, timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def _manifest(path):
    """Rows with a url and a title. Every column is kept, stripped."""
    if not path.exists():
        raise IngestError(f"missing {path}")
    rows = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        for raw in csv.DictReader(handle):
            row = {key: (value or "").strip() for key, value in raw.items() if key}
            if not row.get("url") or not row.get("title"):
                continue
            row.setdefault("topic", "")
            row.setdefault("published", "")
            row["doc_type"] = row.get("type_guess", "")
            rows.append(row)
    if not rows:
        raise IngestError(f"{path} has no articles")
    return rows


def _download(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        body = _request(request, 45, "page")
    except HTTPFailure as error:
        raise RuntimeError(f"HTTP {error.code}") from error
    time.sleep(0.4)
    return body


def _request(request, timeout, label):
    """Return the response body. Throttling, server errors, and dropped connections are retried."""
    delay = 2
    for attempt in range(4):
        last = attempt == 3
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code not in RETRY_STATUS or last:
                raise HTTPFailure(label, error.code, detail) from error
        except (urllib.error.URLError, socket.timeout, ConnectionError) as error:
            if last:
                raise RuntimeError(f"{label} request failed: {error}") from error
        else:
            if status != 200:
                raise HTTPFailure(label, status)
            return body
        time.sleep(delay)
        delay *= 2
    raise RuntimeError(f"{label} request failed")


def _embed(texts, api_key):
    vectors = [None] * len(texts)
    for start in range(0, len(texts), 64):
        batch = texts[start : start + 64]
        payload = _voyage(batch, api_key)
        for item in payload["data"]:
            vector = item["embedding"]
            if len(vector) != EMBEDDING_DIMENSION:
                raise RuntimeError(
                    f"Voyage returned {len(vector)} dimensions, expected {EMBEDDING_DIMENSION}"
                )
            vectors[start + item["index"]] = vector
    if any(vector is None for vector in vectors):
        raise RuntimeError("Voyage left a passage without a vector")
    return vectors


def _voyage(texts, api_key):
    body = json.dumps(
        {
            "input": texts,
            "model": EMBEDDING_MODEL,
            "input_type": "document",
            "output_dimension": EMBEDDING_DIMENSION,
        }
    ).encode()
    request = urllib.request.Request(
        VOYAGE_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    return json.loads(_request(request, 90, "Voyage").decode())
