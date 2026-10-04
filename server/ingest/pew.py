"""Load Pew Research Center articles listed in pew_manifest.csv.

Each URL is fetched once and saved under data/ingestion/pew/cache/ after its
article text is found, so an error or challenge page is never cached. A later
run reads that file instead of the network.

Every run re-reads every page and rewrites its metadata and survey links. A
page is embedded again only when its passage text changes or its vectors
came from another model. Documents no longer in the manifest are deleted.

The article body is the WordPress post content. Navigation, share buttons,
photos, and the footer are dropped. Paragraphs and list items under one
heading are merged into passages of up to MAX_CHARS. Each chart becomes its
own passage with its title, data table, note, and source. Every passage
starts with the article title and its section heading so the chunk still
says what it is about.
"""

import bisect
import csv
import hashlib
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timezone

from lxml import html

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

PEW_DIR = REPO_ROOT / "data" / "ingestion" / "pew"
MANIFEST = PEW_DIR / "pew_manifest.csv"
CACHE_DIR = PEW_DIR / "cache"
SOURCE = "pew"
VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
USER_AGENT = "Mozilla/5.0 (compatible; Papertrail/1.0)"
MIN_CHARS = 40
MAX_CHARS = 800
CHART_MAX_CHARS = 1600
RETRY_STATUS = {429, 500, 502, 503, 504}

CHART_CLASS = "wp-block-prc-chart-builder-controller"
# Class fragments that wrap chrome rather than the article.
SKIP_CLASS = (
    "share-modal",
    "social-links",
    "table-of-contents",
    "wp-block-navigation",
    "related-posts",
    "report-pagination",
    "report-materials",
    "prc-block-logo",
    "newsletter",
    "masthead",
    "taxonomy",
)
SKIP_TAGS = {"script", "style", "noscript", "svg", "button", "form", "nav", "footer", "aside"}
SKIP_HEADINGS = {
    "share this chart",
    "report materials",
    "table of contents",
    "research topics",
    "follow us",
    "sign up for our newsletters",
    "more in this report",
    "related",
    "most popular",
}

MONTH = (
    r"(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?"
    r"|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
DASH = r"(?:to|through|and|–|—|-)"
# "Dec. 28, 2025, to Jan. 3, 2026".
FULL_RANGE = re.compile(
    rf"\b{MONTH}\.?\s+(\d{{1,2}}),?\s+(\d{{4}}),?\s*{DASH}\s*"
    rf"{MONTH}\.?\s+(\d{{1,2}}),?\s+(\d{{4}})\b",
    re.IGNORECASE,
)
# "March 31-April 6, 2026" or "Jan. 27 to Feb. 2, 2026".
CROSS_RANGE = re.compile(
    rf"\b{MONTH}\.?\s+(\d{{1,2}})\s*{DASH}\s*{MONTH}\.?\s+(\d{{1,2}}),?\s+(\d{{4}})\b",
    re.IGNORECASE,
)
# "July 6 to 12, 2026" or "July 6-12, 2026".
SAME_RANGE = re.compile(
    rf"\b{MONTH}\.?\s+(\d{{1,2}})\s*(?:to|through|–|—|-)\s*(\d{{1,2}}),?\s+(\d{{4}})\b",
    re.IGNORECASE,
)
# A date range is a field period only when one of these words leads into it.
FIELD_HINT = re.compile(
    r"\b(?:surveys?|surveyed|conducted|fielded|interviews?|interviewed)\b",
    re.IGNORECASE,
)
HINT_REACH = 80
POPULATION = (
    r"((?:U\.S\.\s+)?(?:adults|registered voters|people)"
    r"(?:\s+across\s+\d+\s+countries)?)"
)
# "We surveyed 3,554 U.S. adults", "a survey of 5,103 adults",
# "conducted Oct. 6-16, 2025, among 8,046 U.S. adults".
SAMPLE = re.compile(
    rf"\b(?:surveyed|survey of|among|interviewed)\s+([\d,]{{3,}})\s+{POPULATION}",
    re.IGNORECASE,
)
# "a Pew Research Center survey of U.S. adults conducted Oct. 6-16".
POPULATION_ONLY = re.compile(rf"\bsurvey of\s+{POPULATION}\b", re.IGNORECASE)
SAMPLE_REACH = 600
# Only full-sample margins. Pew articles also quote subgroup margins, such as
# "plus or minus 10.1 percentage points" for Asian Republicans.
OVERALL_MARGIN = re.compile(
    r"overall margin of error of plus or minus\s+([\d.]+)\s+percentage points",
    re.IGNORECASE,
)
FULL_SAMPLE_MARGIN = re.compile(
    r"margin of sampling error for the full sample[^.]{0,120}?plus or minus\s+([\d.]+)",
    re.IGNORECASE,
)
MARGIN_REACH = 1500
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


def ingest_pew(dry_run=False):
    load_env()
    rows = _manifest()
    manifest_urls = {row["url"] for row in rows}
    conn = connect_corpus(readonly=dry_run)
    try:
        ready = conn is not None and schema_ready(conn)
        stored = document_state(conn, SOURCE) if ready else {}
        pages, failures = _read_pages(rows)
        _resolve_surveys(pages, stored_surveys(conn, SOURCE) if ready else [])
        for page in pages:
            page["action"] = _action(page, stored.get(page["url"]))
        removed = sorted(set(stored) - manifest_urls)
        if dry_run:
            if conn is not None and not ready:
                print("Pew would recreate the corpus tables. Their columns do not match.")
            _print_dry_run(pages, removed, failures)
            return
        _write(conn, pages, manifest_urls, failures)
    finally:
        if conn is not None:
            conn.close()


def _read_pages(rows):
    pages = []
    failures = []
    for row in rows:
        url = row["url"]
        try:
            page, cached = _page(url)
            passages, text = read_article(page, row["title"])
            if not passages:
                raise RuntimeError("no article text")
        except Exception as error:
            failures.append(f"{url}: {error}")
            continue
        if not cached:
            _cache_path(url).write_text(page, encoding="utf-8")
        pages.append(
            {
                "row": row,
                "url": url,
                "passages": passages,
                "content_hash": _content_hash(passages),
                "fetched_at": _fetched_at(url),
                "surveys": find_surveys(text),
            }
        )
    return pages, failures


def _action(page, known):
    if known is None:
        return "insert"
    if known["content_hash"] != page["content_hash"] or known["models"] != {EMBEDDING_MODEL}:
        return "replace"
    return "update"


def _write(conn, pages, manifest_urls, failures):
    to_embed = [page for page in pages if page["action"] != "update"]
    api_key = os.environ.get("VOYAGE_API_KEY")
    if to_embed and not api_key:
        passages = sum(len(page["passages"]) for page in to_embed)
        print(
            f"Pew: {len(to_embed)} articles ({passages} passages) need embedding. "
            "Set VOYAGE_API_KEY to embed and store them."
        )
        _print_failures(failures)
        raise SystemExit(1)

    embedded = 0
    updated = 0
    passage_count = 0
    for page in pages:
        document = _document(page)
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
        print(f"Pew stored {document['title']} ({len(page['passages'])} passages).")
    removed = prune(conn, SOURCE, manifest_urls)
    for url in removed:
        print(f"Pew deleted {url}")
    print(
        f"Pew: embedded {embedded} articles, {passage_count} passages. "
        f"Updated {updated} unchanged. Deleted {len(removed)}. Failed {len(failures)}."
    )
    _print_failures(failures)


def _document(page):
    row = page["row"]
    return {
        "source": SOURCE,
        "title": row["title"],
        "url": page["url"],
        "topic": row["topic"] or None,
        "published_on": row["published"] or None,
        "doc_type": row["doc_type"] or None,
        "fetched_at": page["fetched_at"],
        "content_hash": page["content_hash"],
    }


def _print_failures(failures):
    for failure in failures:
        print(f"Pew failed: {failure}")


def _print_dry_run(pages, removed, failures):
    to_embed = [page for page in pages if page["action"] != "update"]
    passage_count = sum(len(page["passages"]) for page in to_embed)
    print(
        f"Pew would embed {passage_count} passages with {EMBEDDING_MODEL} "
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
        print(f"  published_on: {row['published'] or 'none'}")
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


def read_article(page, title):
    """Return the passages of one Pew HTML page and the plain text they came from."""
    tree = html.fromstring(page)
    roots = tree.xpath(
        '//*[contains(concat(" ", normalize-space(@class), " "), " entry-content ")'
        ' and contains(concat(" ", normalize-space(@class), " "), " wp-block-post-content ")]'
    )
    if not roots:
        return [], ""
    root = roots[0]
    reader = _Reader(_opening_heading(tree, root))
    for child in root:
        reader.walk(child)
    blocks = _merge(reader.blocks)
    passages = [_passage(title, block) for block in blocks]
    text = "\n".join(block["text"] for block in reader.blocks)
    return passages, text


class _Reader:
    def __init__(self, section):
        self.section = section
        self.blocks = []

    def walk(self, node):
        if not isinstance(node.tag, str):
            return
        classes = node.get("class") or ""
        if CHART_CLASS in classes.split():
            for text in _chart_texts(node):
                self._add(text, "chart")
            return
        if _is_chrome(node, classes):
            return
        tag = node.tag
        if tag == "figure" and "wp-block-image" in classes.split():
            self._add(_image_text(node), "chart")
            return
        if tag in ("h2", "h3", "h4"):
            text = _clean(node.text_content())
            if text and text.casefold() not in SKIP_HEADINGS:
                self.section = text
            return
        if tag == "p":
            self._add(_clean(node.text_content()), "text")
            return
        if tag == "li" and node.find(".//p") is None:
            nested = [child for child in node if child.tag in ("ul", "ol")]
            self._add(_own_text(node), "text")
            for child in nested:
                self.walk(child)
            return
        # A heading inside "How did we do this?" only labels that disclosure.
        saved = self.section
        for child in node:
            self.walk(child)
        if tag == "details":
            self.section = saved

    def _add(self, text, kind):
        if not text or text.casefold() in SKIP_HEADINGS:
            return
        if text.startswith("Pew Research Center") and (
            "help the public, media and decision-makers" in text
        ):
            return
        if text.startswith("Jump to the sections"):
            return
        self.blocks.append({"section": self.section, "text": text, "kind": kind})


def _is_chrome(node, classes):
    return node.tag in SKIP_TAGS or any(part in classes for part in SKIP_CLASS)


def _inside_chrome(element):
    return any(
        _is_chrome(node, node.get("class") or "")
        for node in (element, *element.iterancestors())
    )


def _own_text(item):
    """List item text without the text of the lists nested in it."""
    parts = [item.text or ""]
    for child in item:
        if child.tag not in ("ul", "ol") and isinstance(child.tag, str):
            parts.append(child.text_content())
        parts.append(child.tail or "")
    return _clean("".join(parts))


def _chart_texts(chart):
    """One or more passages for a chart: title, subtitle, data rows, note, and source."""
    head = []
    for name in ("cb__title", "cb__subtitle"):
        found = chart.xpath(
            f'.//*[contains(concat(" ", normalize-space(@class), " "), " {name} ")]'
        )
        if found:
            text = _clean(found[0].text_content())
            if text:
                head.append(text)
    if head:
        head[0] = f"Chart: {head[0]}"
    notes = []
    for node in chart.xpath('.//*[contains(concat(" ", normalize-space(@class), " "), " cb__note ")]'):
        text = _clean(node.text_content())
        if text and text not in notes:
            notes.append(text)
    tables = chart.xpath(".//table")
    rows = _table_rows(tables[0]) if tables else []
    if not head and not rows:
        return []
    texts = []
    group = []
    for row in rows:
        candidate = "\n".join(head + group + [row] + notes)
        if group and len(candidate) > CHART_MAX_CHARS:
            texts.append("\n".join(head + group + notes))
            group = []
        group.append(row)
    texts.append("\n".join(head + group + notes))
    return texts


def _table_rows(table):
    def cells(row, tag):
        return [
            _clean(cell.text_content())
            for cell in row.findall(tag)
            if "is-column-hidden" not in (cell.get("class") or "")
        ]

    headers = []
    for row in table.xpath(".//thead/tr"):
        headers = cells(row, "th")
    lines = []
    for row in table.xpath(".//tbody/tr"):
        values = cells(row, "td") or cells(row, "th")
        if not values:
            continue
        label, rest = values[0], values[1:]
        names = headers[1:] if len(headers) == len(values) else [""] * len(rest)
        parts = []
        for name, value in zip(names, rest):
            if not value:
                continue
            if name == "%":
                parts.append(f"{value}%")
            elif name:
                parts.append(f"{name} {value}")
            else:
                parts.append(value)
        if parts:
            lines.append(f"{label}: {'; '.join(parts)}")
    return lines


def _image_text(figure):
    """A static chart's alt text. Photos are dropped."""
    image = figure.find(".//img")
    if image is None:
        return None
    alt = _clean(image.get("alt") or "")
    for kind in ("Chart", "Table"):
        if alt.startswith(f"{kind} shows "):
            return f"{kind}: {alt[len(kind) + 7:]}"
    return None


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


def _clean(text):
    return " ".join(text.split())


def _opening_heading(tree, root):
    """The deck under the title sits outside the post body."""
    for heading in tree.xpath(
        '//h2[contains(concat(" ", normalize-space(@class), " "), " wp-block-heading ")]'
    ):
        if root in heading.iterancestors() or _inside_chrome(heading):
            continue
        text = _clean(heading.text_content())
        if text and text.casefold() not in SKIP_HEADINGS:
            return text
    return None


def find_surveys(text):
    """Return each survey a page cites: field dates, sample size, population, margin."""
    ranges = _field_ranges(text)
    if not ranges:
        return []
    line_starts = [0] + [match.end() for match in re.finditer("\n", text)]
    found = {}
    for item in ranges:
        found.setdefault(
            item["dates"], {"sizes": [], "populations": [], "margins": []}
        )
    for match in SAMPLE.finditer(text):
        target = _nearest(ranges, match, line_starts, SAMPLE_REACH)
        if target is not None:
            size = int(match.group(1).replace(",", ""))
            found[target]["sizes"].append((size, _clean(match.group(2))))
    for match in POPULATION_ONLY.finditer(text):
        target = _nearest(ranges, match, line_starts, SAMPLE_REACH)
        if target is not None:
            found[target]["populations"].append(_clean(match.group(1)))
    for pattern in (OVERALL_MARGIN, FULL_SAMPLE_MARGIN):
        for match in pattern.finditer(text):
            target = _nearest(ranges, match, line_starts, MARGIN_REACH)
            if target is None and len(found) == 1:
                target = next(iter(found))
            if target is not None:
                found[target]["margins"].append(float(match.group(1)))

    surveys = []
    for (field_start, field_end), facts in found.items():
        size = None
        population = None
        if facts["sizes"]:
            counts = Counter(size for size, _ in facts["sizes"])
            size = max(counts, key=lambda value: counts[value])
            named = [name for value, name in facts["sizes"] if value == size]
            population = _best_population(named)
        if population is None and facts["populations"]:
            population = _best_population(facts["populations"])
        surveys.append(
            {
                "field_start": field_start,
                "field_end": field_end,
                "sample_size": size,
                "population": population,
                "margin_of_error": facts["margins"][0] if facts["margins"] else None,
            }
        )
    return surveys


def _field_ranges(text):
    found = []
    occupied = []
    for kind, pattern in (("full", FULL_RANGE), ("cross", CROSS_RANGE), ("same", SAME_RANGE)):
        for match in pattern.finditer(text):
            if any(match.start() < end and match.end() > start for start, end in occupied):
                continue
            occupied.append((match.start(), match.end()))
            lead = text[max(0, match.start() - HINT_REACH) : match.start()]
            lead = lead.rsplit("\n", 1)[-1]
            if not FIELD_HINT.search(lead):
                continue
            try:
                dates = _range_dates(kind, match)
            except ValueError:
                continue
            found.append({"start": match.start(), "end": match.end(), "dates": dates})
    found.sort(key=lambda item: item["start"])
    return found


def _nearest(ranges, match, line_starts, reach):
    """The dates of the closest range within reach, preferring one on the same line."""
    line = bisect.bisect_right(line_starts, match.start())
    best = None
    for item in ranges:
        if item["end"] <= match.start():
            gap = match.start() - item["end"]
        elif item["start"] >= match.end():
            gap = item["start"] - match.end()
        else:
            gap = 0
        if gap > reach:
            continue
        other_line = bisect.bisect_right(line_starts, item["start"]) != line
        rank = (other_line, gap)
        if best is None or rank < best[0]:
            best = (rank, item["dates"])
    return best[1] if best else None


def _best_population(names):
    for name in names:
        if name.lower().startswith("u.s."):
            return name
    return names[0]


def _range_dates(kind, match):
    if kind == "full":
        start_month, start_day, start_year, end_month, end_day, end_year = match.groups()
        return (
            _iso(int(start_year), start_month, int(start_day)),
            _iso(int(end_year), end_month, int(end_day)),
        )
    if kind == "cross":
        start_month, start_day, end_month, end_day, year = match.groups()
        end = _iso(int(year), end_month, int(end_day))
        start_year = int(year)
        if _month(end_month) < _month(start_month):
            start_year -= 1
        return _iso(start_year, start_month, int(start_day)), end
    month, start_day, end_day, year = match.groups()
    return _iso(int(year), month, int(start_day)), _iso(int(year), month, int(end_day))


def _iso(year, month, day):
    return date(year, _month(month), day).isoformat()


def _month(name):
    return MONTHS[name.lower()[:3]]


def _resolve_surveys(pages, stored):
    """Key each page's surveys and fill a chapter's missing sample from its siblings.

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
        key = _survey_key(survey["field_start"], survey["field_end"], size)
        entry = merged.setdefault(
            key,
            {
                "source": SOURCE,
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


def _survey_key(field_start, field_end, sample_size):
    key = f"{SOURCE}-{field_start}-{field_end}"
    if sample_size is not None:
        key += f"-n{sample_size}"
    return key


def _content_hash(passages):
    return hashlib.sha256("\n\n".join(passages).encode()).hexdigest()


def _cache_path(url):
    return CACHE_DIR / f"{hashlib.sha256(url.encode()).hexdigest()}.html"


def _fetched_at(url):
    stamp = datetime.fromtimestamp(_cache_path(url).stat().st_mtime, timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def _manifest():
    if not MANIFEST.exists():
        raise FileNotFoundError(f"missing {MANIFEST}")
    rows = []
    with MANIFEST.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            url = (row.get("url") or "").strip()
            title = (row.get("title") or "").strip()
            if not url or not title:
                continue
            rows.append(
                {
                    "title": title,
                    "url": url,
                    "topic": (row.get("topic") or "").strip(),
                    "published": (row.get("published") or "").strip(),
                    "doc_type": (row.get("type_guess") or "").strip(),
                }
            )
    if not rows:
        raise ValueError(f"{MANIFEST} has no articles")
    return rows


def _page(url):
    """Return the page HTML and whether it came from the cache.

    A fetched page is not written here. The caller caches it once the article
    text is found.
    """
    path = _cache_path(url)
    if path.exists() and path.stat().st_size > 0:
        return path.read_text(encoding="utf-8"), True
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        body = _request(request, 45, "page")
    except HTTPFailure as error:
        raise RuntimeError(f"HTTP {error.code}") from error
    time.sleep(0.4)
    return body.decode("utf-8", "replace"), False


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
