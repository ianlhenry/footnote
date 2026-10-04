"""Load Marist Poll releases listed in marist_manifest.csv.

Fetching, caching, chunking, embedding, and storing are shared with other
sources in articles.py. This module turns one release into text blocks and
its survey.

The passages come from the release page: the lead, the chart, the bullet
points, and the sections under them, including the Methodology note.

The survey comes from the first page of the release's "Nature of the Sample
and Tables" PDF. That is the manifest's methodology_pdf, or else the page's
Survey Data link. Most first pages open with a methodology paragraph that
states the sample, population, field dates, and margin of error. Some open
with the sample table instead, which names only the population and field
dates. Facts the first page leaves out are taken from the page's own
Methodology note when it reports the same field dates, and metadata_source
names them, as in "pdf; page for sample_size, margin_of_error".
"""

import json
import re
import urllib.parse
from datetime import datetime

from lxml import html

from server.ingest.articles import (
    MONTH,
    STATE_CODES,
    clean,
    describe_sources,
    ingest_articles,
    iso_date,
    month_number,
    pdf_text,
)

SKIP_TAGS = {"script", "style", "noscript", "svg", "button", "form", "nav", "footer", "aside", "h1"}
SKIP_CLASS = {"hero", "basebuttons", "pdfs", "baseutils", "post-date", "poll-intro"}

DASH = r"(?:through|to|–|—|-)"
# "conducted September 14th through September 15th, 2026",
# "conducted September 17 - 20, 2026",
# "conducted December 29th, 2025, through January 2nd, 2026".
FIELD_DATES = re.compile(
    rf"\bconducted\s+{MONTH}\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?,?\s*{DASH}\s*"
    rf"(?:{MONTH}\.?\s+)?(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})",
    re.IGNORECASE,
)
# "This NPR/PBS News/Marist Poll national survey of 1,443 adults was conducted",
# "This Marist Poll survey of 1,139 Texas registered voters was conducted".
SURVEY_OF = re.compile(
    r"\b(national\s+)?survey of\s+([\d,]+)\s+([^.]{1,60}?)\s+was conducted", re.IGNORECASE
)
# "Marist Poll Iowa Registered Voters. Interviews conducted", under the sample table.
SAMPLE_OF = re.compile(r"\bPoll\s+([^.]{1,60}?)\.\s+Interviews conducted", re.IGNORECASE)
# "Results for all adults (n=1,443) are statistically significant within ±3.0".
RESULTS = re.compile(
    r"\(n=\s*([\d,]+)\)\s+are statistically significant within\s+±\s*([\d.]+)",
    re.IGNORECASE,
)
POPULATION = re.compile(r"(adults|registered voters|likely voters|residents)$", re.IGNORECASE)
STATES = {name.lower(): code for name, code in STATE_CODES.items()}


def ingest_marist(dry_run=False):
    ingest_articles("marist", "Marist", read_release, dry_run=dry_run)


def read_release(row, fetch):
    tree = html.fromstring(fetch(row["url"]).decode("utf-8", "replace"))
    mains = tree.xpath(
        '//*[contains(concat(" ", normalize-space(@class), " "), " poll-container ")]//main'
    )
    if not mains:
        raise RuntimeError("no release text")
    main = mains[0]
    reader = _Reader(_first_text(main, "subhead"))
    reader.walk(main)
    if not reader.blocks:
        raise RuntimeError("no release text")

    pdf_url = row.get("methodology_pdf") or _pdf_link(main, row["url"])
    if not pdf_url:
        raise RuntimeError("no Survey Data PDF")
    details = survey_details(pdf_text(fetch(pdf_url), pages=1))
    methodology = "\n".join(
        block["text"] for block in reader.blocks if block["section"] == "Methodology"
    )
    backup = survey_details(methodology)
    surveys = []
    if details["field_start"] is not None:
        from_page = []
        if (backup["field_start"], backup["field_end"]) == (
            details["field_start"],
            details["field_end"],
        ):
            for field, value in details.items():
                if value is None and backup[field] is not None:
                    details[field] = backup[field]
                    from_page.append(field)
        details["metadata_source"] = describe_sources(
            "pdf", {field: "page" for field in from_page}
        )
        surveys.append(details)
    return {
        "blocks": reader.blocks,
        "surveys": surveys,
        "published_on": _published_on(main),
    }


class _Reader:
    def __init__(self, section):
        self.section = section
        self.blocks = []

    def walk(self, node):
        if not isinstance(node.tag, str) or node.tag in SKIP_TAGS:
            return
        classes = set((node.get("class") or "").split())
        if classes & SKIP_CLASS:
            return
        if "chart" in classes:
            self._add(_chart_text(node), "chart")
            return
        tag = node.tag
        if tag in ("h2", "h3", "h4"):
            text = clean(node.text_content())
            if text:
                self.section = text
            return
        if tag == "p" or (tag == "li" and node.find(".//p") is None):
            self._add(clean(node.text_content()), "text")
            return
        for child in node:
            self.walk(child)

    def _add(self, text, kind):
        if text:
            self.blocks.append({"section": self.section, "text": text, "kind": kind})


def _chart_text(chart):
    """The chart's title, question, one line per bar, and its source line."""
    lines = []
    for name in ("chart-title", "chart-sub"):
        text = _first_text(chart, name)
        if text:
            lines.append(text)
    if lines:
        lines[0] = f"Chart: {lines[0]}"
    for canvas in chart.xpath(".//canvas[@data-chart-attributes]"):
        lines.extend(_bars(canvas.get("data-chart-attributes")))
    source = _first_text(chart, "chart-source")
    if source:
        lines.append(source)
    return "\n".join(lines)


def _bars(attributes):
    """'Democrat: 53%' per label. Several series give 'Label: Series 53%; Series 41%'."""
    try:
        chart = json.loads(attributes)
        labels = json.loads(chart["labels"])
        series = json.loads(chart["datasets"])
    except (ValueError, KeyError, TypeError):
        return []
    lines = []
    for index, label in enumerate(labels):
        parts = []
        for item in series:
            data = item.get("data") or []
            if index >= len(data) or data[index] in ("", None):
                continue
            value = f"{data[index]}%"
            parts.append(f"{item.get('label')} {value}" if len(series) > 1 else value)
        if parts:
            lines.append(f"{clean(str(label))}: {'; '.join(parts)}")
    return lines


def _first_text(root, class_name):
    found = root.xpath(
        f'.//*[contains(concat(" ", normalize-space(@class), " "), " {class_name} ")]'
    )
    return clean(found[0].text_content()) if found else ""


def _pdf_link(main, page_url):
    links = [
        urllib.parse.urljoin(page_url, href)
        for href in main.xpath('.//*[contains(@class, "pdfs")]//a/@href')
        if urllib.parse.urlparse(href).path.lower().endswith(".pdf")
    ]
    tables = [link for link in links if "NOS" in link]
    return (tables or links or [None])[0]


def _published_on(main):
    text = _first_text(main, "post-date")
    try:
        return datetime.strptime(text, "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


def survey_details(text):
    """Field dates, sample size, population, and margin of error in a methodology passage."""
    text = clean(text)
    details = {
        "geography": None,
        "field_start": None,
        "field_end": None,
        "sample_size": None,
        "population": None,
        "margin_of_error": None,
    }
    dates = FIELD_DATES.search(text)
    if dates:
        try:
            details["field_start"], details["field_end"] = _field_dates(dates)
        except ValueError:
            pass
    survey = SURVEY_OF.search(text)
    sample = SAMPLE_OF.search(text)
    if survey:
        details["sample_size"] = int(survey.group(2).replace(",", ""))
        details["population"], details["geography"] = _population(
            survey.group(3), national=bool(survey.group(1))
        )
    elif sample:
        details["population"], details["geography"] = _population(sample.group(1))
    for match in RESULTS.finditer(text):
        if int(match.group(1).replace(",", "")) == details["sample_size"]:
            details["margin_of_error"] = float(match.group(2))
            break
    return details


def _field_dates(match):
    start_month, start_day, start_year, end_month, end_day, end_year = match.groups()
    end_month = end_month or start_month
    end_year = int(end_year)
    if start_year:
        start_year = int(start_year)
    elif month_number(start_month) > month_number(end_month):
        start_year = end_year - 1
    else:
        start_year = end_year
    return (
        iso_date(start_year, start_month, int(start_day)),
        iso_date(end_year, end_month, int(end_day)),
    )


def _population(name, national=False):
    """The population without its place, and the place as a geography.

    'National Adults' gives ('adults', 'US'). 'Iowa Registered Voters'
    gives ('registered voters', 'IA').
    """
    name = clean(name)
    match = POPULATION.search(name)
    if not match:
        return name, "US" if national else None
    place = name[: match.start()].strip().lower()
    geography = "US" if national or place == "national" else STATES.get(place)
    return match.group(1).lower(), geography
