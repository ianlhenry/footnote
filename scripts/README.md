# Scripts

## Dev

`scripts/dev.sh` starts the API and the frontend together. From the repo root:

```sh
npm run dev
```

`npm run dev:api` and `npm run dev:web` start one of them. See [server/README.md](../server/README.md) and [web/README.md](../web/README.md).

## Ingest

Python 3. From the repo root:

```sh
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
.venv/bin/python -m server.ingest
```

`--dry-run` prints the FEC rows and the Marist and Pew passages that would be written, including the text that would be embedded, the surveys found on each page, and any documents that would be deleted. It does not change the database or call Voyage. It does fetch Marist and Pew pages, and the PDFs and methodology pages they link, that are not cached yet and saves them to the cache.

```sh
.venv/bin/python -m server.ingest --dry-run
```

That command calls the FEC, Marist, and Pew loaders. The FEC loader replaces these tables from the files below:

| Table | File |
| --- | --- |
| `fec_candidate` | `cn.txt` |
| `fec_committee` | `cm.txt` |
| `fec_candidate_committee` | `ccl.txt` |
| `fec_candidate_summary` | `weball26.txt` |
| `fec_pac_summary` | `webk26.txt` |
| `fec_independent_expenditure` | `independent_expenditure_2026.csv` |

Raw downloads live under `data/ingestion/<source>/` and are not committed. The database is `data/papertrail.sqlite`.

```
data/
  papertrail.sqlite
  ingestion/
    fec/
      cn.txt
      cn_header_file.csv
      cm.txt
      cm_header_file.csv
      ccl.txt
      ccl_header_file.csv
      weball26.txt
      webk26.txt
      independent_expenditure_2026.csv
    marist/
      marist_manifest.csv
      cache/
    pew/
      pew_manifest.csv
      cache/
```

Files are from the [FEC bulk data page](https://www.fec.gov/data/browse-data/?tab=bulk-data). The `.txt` files are pipe-delimited and have no header row. `cn`, `cm`, and `ccl` each have a matching `*_header_file.csv`. `weball26.txt` uses the [all candidates file description](https://www.fec.gov/campaign-finance-data/all-candidates-file-description/). `webk26.txt` uses the [PAC and party summary file description](https://www.fec.gov/campaign-finance-data/pac-and-party-summary-file-description/). `independent_expenditure_2026.csv` is comma-separated and includes a header row.

A second FEC run replaces those tables. It does not append.

Pew reads `data/ingestion/pew/pew_manifest.csv`. Each article is fetched once and saved under `data/ingestion/pew/cache/`, but only after its article text is found, so an error page is never cached. A later run reads the cache. Fetches and Voyage calls retry throttling, server errors, and dropped connections.

The loader keeps the article text and the charts, with each chart's data table, note, and source. Paragraphs under one heading are merged into passages of up to 800 characters. Each passage starts with the article title and its section heading. Passages are embedded with Voyage `voyage-4` and written to `documents`, `passages`, and `passage_embeddings`.

Field dates, sample size, population, and margin of error are read from the text and written to `surveys`. `document_surveys` links each page to every survey it cites. A survey is keyed by its pollster, geography, and field dates, as in `marist-TX-2026-09-17-2026-09-20`. Geography is `US`, a state's postal code, or `INTL` for a multi-country survey. It comes from the population: Marist names the state or "national", and a Pew population counts as `US` unless it names countries. The place is then dropped from `population`, which holds only who was surveyed, such as `adults` or `registered voters`. A page that omits the population takes the geography of another page with the same field dates, and values one page omits come from another page citing the same survey. Articles mostly state margins only for subgroups, so Pew also reads the methodology pages and PDFs an article links from its report's table of contents or its body, such as "How we did this". They are cached like the articles. A methodology survey with the same field dates fills in what the article left out, usually the full-sample margin of error. A methodology survey the article never dates is added to the page, because the page belongs to the report that methodology describes. A methodology page that cannot be read is skipped with a message, and the article still loads.

Marist reads `data/ingestion/marist/marist_manifest.csv` and caches under `data/ingestion/marist/cache/` the same way. Fetching, chunking, embedding, and storing are the same code as Pew. The passages come from the release page: the lead, the chart with its bars and source line, the bullet points, and the sections under them, including the Methodology note. Each release's survey is read from the first page of its "Nature of the Sample and Tables" PDF, which is the `methodology_pdf` column or else the page's Survey Data link. Most first pages state the sample size, population, field dates, and margin of error. Some open with the sample table, which names only the population and field dates. The missing facts are then taken from the page's Methodology note when it reports the same field dates. `published_on` is the date on the release page.

`surveys.metadata_source` records where the values were read: the main source first, then any field that came from elsewhere, as in `page; methodology for margin_of_error` for Pew or `pdf; page for sample_size, margin_of_error` for Marist. When several pages cite one survey, each value keeps the source of the page it was taken from.

Every run, dry or not, ends with a check per source that lists each survey still missing a geography, sample size, population, or margin of error, with its `metadata_source`, and each page that cites no survey.

Every run rewrites each page's metadata and survey links. A page is embedded again only when its passage text changes or its vectors came from another model. Documents no longer in the manifest are deleted. A nullable column added to a corpus table, such as `metadata_source`, is added in place. Any other change to the corpus tables' layout drops them and loads them again, which embeds every passage again.

Set `VOYAGE_API_KEY` in the environment or in `.env`. This command reads `.env`. The API process does not.

## Evals

No eval command yet. Results will be recorded in [docs/evals.md](../docs/evals.md).
