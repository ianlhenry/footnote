"""Load Pew Research Center articles listed in pew_manifest.csv.

Fetching, caching, chunking, embedding, and storing are shared with other
sources in articles.py. This module turns one Pew page into text blocks and
finds the surveys it cites.

The article body is the WordPress post content. Navigation, share buttons,
photos, and the footer are dropped. Each chart becomes its own passage with
its title, data table, note, and source.
"""

import bisect
import re
import urllib.parse
from collections import Counter

from lxml import html

from server.ingest.articles import (
    MONTH,
    SOURCED_FIELDS,
    clean,
    describe_sources,
    ingest_articles,
    is_pdf,
    iso_date,
    month_number,
    pdf_text,
    read_sources,
)

CHART_MAX_CHARS = 1600

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
# "a Pew Research Center survey of U.S. adults conducted Oct. 6-16",
# "panel of randomly selected U.S. adults".
POPULATION_ONLY = re.compile(
    rf"\b(?:survey of|randomly selected)\s+{POPULATION}\b", re.IGNORECASE
)
# Methodology pages: "A total of 3,554 panelists responded",
# "the full sample of 3,554 respondents".
RESPONDED = re.compile(
    r"\b(?:a total of\s+([\d,]{3,})\s+panelists responded"
    r"|full sample of\s+([\d,]{3,})\s+respondents)",
    re.IGNORECASE,
)
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
# Pages about Pew's methods in general rather than one survey.
METHODS_HUB = re.compile(r"/topic/|/our-methods/|american-trends-panel", re.IGNORECASE)


def ingest_pew(no_write=False, refetch=False):
    ingest_articles("pew", "Pew", read_page, no_write=no_write, refetch=refetch)


def read_page(row, fetch):
    page = fetch(row["url"]).decode("utf-8", "replace")
    blocks = read_article(page)
    text = "\n".join(block["text"] for block in blocks)
    surveys = find_surveys(text)
    for url in methodology_links(page, row["url"]):
        try:
            _add_methodology(surveys, find_surveys(_methodology_text(fetch(url))))
        except Exception as error:
            # Keep an error or challenge page out of the cache.
            fetch.forget(url)
            print(f"Pew methodology skipped: {url}: {error}")
    return {"blocks": blocks, "surveys": surveys}


def methodology_links(page, page_url):
    """Methodology pages and PDFs linked from the report's contents or the article body.

    Other links on the page, such as an old methodology cited in a footnote,
    describe something else.
    """
    tree = html.fromstring(page)
    anchors = tree.xpath(
        '//*[contains(@class, "table-of-contents")]//a[@href]'
        ' | //*[contains(concat(" ", normalize-space(@class), " "), " wp-block-post-content ")]'
        "//a[@href]"
    )
    here = urllib.parse.urldefrag(page_url)[0].rstrip("/")
    links = []
    for anchor in anchors:
        url = urllib.parse.urldefrag(urllib.parse.urljoin(page_url, anchor.get("href")))[0]
        parts = urllib.parse.urlparse(url)
        if (
            parts.netloc.endswith("pewresearch.org")
            and "methodology" in parts.path.lower()
            and not METHODS_HUB.search(parts.path)
            and url.rstrip("/") != here
            and url not in links
        ):
            links.append(url)
    return links


def _methodology_text(body):
    if is_pdf(body):
        text = pdf_text(body)
    else:
        blocks = read_article(body.decode("utf-8", "replace"))
        text = "\n".join(block["text"] for block in blocks)
    if not text.strip():
        raise RuntimeError("no methodology text")
    return text


def _add_methodology(surveys, found):
    """Fill each survey from the methodology survey with the same field dates.

    A methodology survey the article never dates is added, because the page
    belongs to the report that methodology describes.
    """
    by_dates = {(survey["field_start"], survey["field_end"]): survey for survey in surveys}
    for extra in found:
        dates = (extra["field_start"], extra["field_end"])
        survey = by_dates.get(dates)
        if survey is None:
            extra["metadata_source"] = "methodology"
            surveys.append(extra)
            by_dates[dates] = extra
            continue
        filled = [
            field for field in SOURCED_FIELDS if survey[field] is None and extra[field] is not None
        ]
        main, sources = read_sources(survey["metadata_source"])
        for field in filled:
            survey[field] = extra[field]
            sources[field] = "methodology"
        survey["metadata_source"] = describe_sources(main, sources)


def read_article(page):
    """Return the text blocks of one Pew HTML page."""
    tree = html.fromstring(page)
    roots = tree.xpath(
        '//*[contains(concat(" ", normalize-space(@class), " "), " entry-content ")'
        ' and contains(concat(" ", normalize-space(@class), " "), " wp-block-post-content ")]'
    )
    if not roots:
        return []
    root = roots[0]
    reader = _Reader(_opening_heading(tree, root))
    for child in root:
        reader.walk(child)
    return reader.blocks


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
            text = clean(node.text_content())
            if text and text.casefold() not in SKIP_HEADINGS:
                self.section = text
            return
        if tag == "p":
            self._add(clean(node.text_content()), "text")
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
    return clean("".join(parts))


def _chart_texts(chart):
    """One or more passages for a chart: title, subtitle, data rows, note, and source."""
    head = []
    for name in ("cb__title", "cb__subtitle"):
        found = chart.xpath(
            f'.//*[contains(concat(" ", normalize-space(@class), " "), " {name} ")]'
        )
        if found:
            text = clean(found[0].text_content())
            if text:
                head.append(text)
    if head:
        head[0] = f"Chart: {head[0]}"
    notes = []
    for node in chart.xpath('.//*[contains(concat(" ", normalize-space(@class), " "), " cb__note ")]'):
        text = clean(node.text_content())
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
            clean(cell.text_content())
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
    alt = clean(image.get("alt") or "")
    for kind in ("Chart", "Table"):
        if alt.startswith(f"{kind} shows "):
            return f"{kind}: {alt[len(kind) + 7:]}"
    return None


def _opening_heading(tree, root):
    """The deck under the title sits outside the post body."""
    for heading in tree.xpath(
        '//h2[contains(concat(" ", normalize-space(@class), " "), " wp-block-heading ")]'
    ):
        if root in heading.iterancestors() or _inside_chrome(heading):
            continue
        text = clean(heading.text_content())
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
            found[target]["sizes"].append((size, clean(match.group(2))))
    for match in RESPONDED.finditer(text):
        target = _nearest(ranges, match, line_starts, SAMPLE_REACH)
        if target is not None:
            size = int((match.group(1) or match.group(2)).replace(",", ""))
            found[target]["sizes"].append((size, None))
    for match in POPULATION_ONLY.finditer(text):
        target = _nearest(ranges, match, line_starts, SAMPLE_REACH)
        if target is not None:
            found[target]["populations"].append(clean(match.group(1)))
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
            named = [name for value, name in facts["sizes"] if value == size and name]
            if named:
                population = _best_population(named)
        if population is None and facts["populations"]:
            population = _best_population(facts["populations"])
        surveys.append(
            {
                "geography": _geography(population),
                "field_start": field_start,
                "field_end": field_end,
                "sample_size": size,
                "population": _without_place(population),
                "margin_of_error": facts["margins"][0] if facts["margins"] else None,
                "metadata_source": "page",
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


def _geography(population):
    """Pew's U.S. panel is sometimes just "adults". Only a multi-country survey names countries."""
    if population is None:
        return None
    return "INTL" if "countries" in population.lower() else "US"


def _without_place(population):
    """'U.S. adults' gives 'adults'. 'people across 36 countries' gives 'people'."""
    if population is None:
        return None
    population = re.sub(r"^U\.S\.\s+", "", population, flags=re.IGNORECASE)
    return re.sub(r"\s+across\s+\d+\s+countries$", "", population, flags=re.IGNORECASE)


def _best_population(names):
    for name in names:
        if name.lower().startswith("u.s."):
            return name
    return names[0]


def _range_dates(kind, match):
    if kind == "full":
        start_month, start_day, start_year, end_month, end_day, end_year = match.groups()
        return (
            iso_date(int(start_year), start_month, int(start_day)),
            iso_date(int(end_year), end_month, int(end_day)),
        )
    if kind == "cross":
        start_month, start_day, end_month, end_day, year = match.groups()
        end = iso_date(int(year), end_month, int(end_day))
        start_year = int(year)
        if month_number(end_month) < month_number(start_month):
            start_year -= 1
        return iso_date(start_year, start_month, int(start_day)), end
    month, start_day, end_day, year = match.groups()
    return iso_date(int(year), month, int(start_day)), iso_date(int(year), month, int(end_day))
