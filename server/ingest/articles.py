"""Load poll articles listed in a source's manifest into the corpus tables.

A source supplies one reader. It takes a manifest row and a fetch function
and returns the page's text blocks and the surveys it reports on. Everything
else is shared: the manifest, the fetch cache, chunking, embedding, survey
keys, and the writes.

Each URL is fetched once and saved under data/ingestion/<source>/cache/ after
the reader succeeds, so an error or challenge page is never cached. A later
run reads that file instead of the network.

Every run re-reads every page and rewrites its metadata and survey links. A
page is embedded again only when its passage text changes or its vectors
came from another model. Documents no longer in the manifest are deleted.

Text blocks under one heading are merged into passages of up to MAX_CHARS.
Each chart stays its own passage. Every passage starts with the article title
and its section heading so the chunk still says what it is about.
"""

import csv
import hashlib
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

from server.db import REPO_ROOT, load_env
from server.ingest.corpus import (
    EMBEDDING_DIMENSION,
    EMBEDDING_MODEL,
    connect_corpus,
    document_state,
    prune,
    replace_document,
    schema_ready,
    stored_surveys,
    update_document,
)

INGESTION_DIR = REPO_ROOT / "data" / "ingestion"
VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
USER_AGENT = "Mozilla/5.0 (compatible; Papertrail/1.0)"
MIN_CHARS = 40
MAX_CHARS = 800
RETRY_STATUS = {429, 500, 502, 503, 504}

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


def ingest_articles(source, label, read, dry_run=False):
    """Load every row of data/ingestion/<source>/<source>_manifest.csv.

    read(row, fetch) returns {"blocks": [...], "surveys": [...]} and may add
    "published_on". A block is {"section", "text", "kind"}, where kind is
    "text" or "chart". A survey has field_start, field_end, sample_size,
    population, and margin_of_error.
    """
    load_env()
    directory = INGESTION_DIR / source
    rows = _manifest(directory / f"{source}_manifest.csv")
    manifest_urls = {row["url"] for row in rows}
    conn = connect_corpus(readonly=dry_run)
    try:
        ready = conn is not None and schema_ready(conn)
        stored = document_state(conn, source) if ready else {}
        pages, failures = _read_pages(rows, read, directory / "cache")
        _resolve_surveys(source, pages, stored_surveys(conn, source) if ready else [])
        for page in pages:
            page["action"] = _action(page, stored.get(page["url"]))
        removed = sorted(set(stored) - manifest_urls)
        if dry_run:
            if conn is not None and not ready:
                print(f"{label} would recreate the corpus tables. Their columns do not match.")
            _print_dry_run(label, pages, removed, failures)
            return
        _write(conn, source, label, pages, manifest_urls, failures)
    finally:
        if conn is not None:
            conn.close()


def _read_pages(rows, read, cache_dir):
    pages = []
    failures = []
    for row in rows:
        url = row["url"]
        cache = _Cache(cache_dir)
        try:
            found = read(row, cache.fetch)
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
    """Fetched bodies wait here until the page reads cleanly."""

    def __init__(self, directory):
        self.directory = directory
        self.pending = {}

    def fetch(self, url):
        path = _cache_path(self.directory, url)
        if path.exists() and path.stat().st_size > 0:
            return path.read_bytes()
        body = _download(url)
        self.pending[path] = body
        return body

    def commit(self):
        if self.pending:
            self.directory.mkdir(parents=True, exist_ok=True)
        for path, body in self.pending.items():
            path.write_bytes(body)
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
        print(
            f"{label}: {len(to_embed)} articles ({passages} passages) need embedding. "
            "Set VOYAGE_API_KEY to embed and store them."
        )
        _print_failures(label, failures)
        raise SystemExit(1)

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


def _print_dry_run(label, pages, removed, failures):
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
                f"field {survey['field_start']} to {survey['field_end']}, "
                f"sample_size {_or_none(survey['sample_size'])}, "
                f"population {_or_none(survey['population'])}, "
                f"margin_of_error {_or_none(survey['margin_of_error'])}"
            )
        if page["action"] == "update":
            continue
        for position, text in enumerate(page["passages"]):
            print(f"\n  [{position}] {text}")


def _or_none(value):
    return "none" if value is None else value


def _resolve_surveys(source, pages, stored):
    """Key each page's surveys and fill a page's missing sample from its siblings.

    The key is the field dates plus the sample size, so two surveys fielded on
    the same dates stay apart. A survey found without a sample takes the size
    of the one sized survey with the same dates, when there is exactly one.
    """
    sizes = {}
    for survey in stored + [survey for page in pages for survey in page["surveys"]]:
        if survey["sample_size"] is not None:
            dates = (survey["field_start"], survey["field_end"])
            sizes.setdefault(dates, set()).add(survey["sample_size"])
    merged = {}

    def absorb(survey, size):
        key = _survey_key(source, survey["field_start"], survey["field_end"], size)
        entry = merged.setdefault(
            key,
            {
                "source": source,
                "survey_key": key,
                "field_start": survey["field_start"],
                "field_end": survey["field_end"],
                "sample_size": size,
                "population": None,
                "margin_of_error": None,
            },
        )
        population = survey["population"]
        if population and (
            entry["population"] is None
            or (
                population.lower().startswith("u.s.")
                and not entry["population"].lower().startswith("u.s.")
            )
        ):
            entry["population"] = population
        if entry["margin_of_error"] is None:
            entry["margin_of_error"] = survey["margin_of_error"]
        return key

    for survey in stored:
        absorb(survey, survey["sample_size"])
    for page in pages:
        keys = []
        for survey in page["surveys"]:
            size = survey["sample_size"]
            if size is None:
                known = sizes.get((survey["field_start"], survey["field_end"]), set())
                if len(known) == 1:
                    size = next(iter(known))
            key = absorb(survey, size)
            if key not in keys:
                keys.append(key)
        page["survey_keys"] = keys
    for page in pages:
        page["surveys"] = [merged[key] for key in page.pop("survey_keys")]


def _survey_key(source, field_start, field_end, sample_size):
    key = f"{source}-{field_start}-{field_end}"
    if sample_size is not None:
        key += f"-n{sample_size}"
    return key


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
        raise FileNotFoundError(f"missing {path}")
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
        raise ValueError(f"{path} has no articles")
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
