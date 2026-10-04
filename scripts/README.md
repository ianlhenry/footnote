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

`--dry-run` prints the FEC rows and Pew passages that would be written, including the text that would be embedded, the surveys found on each page, and any documents that would be deleted. It does not change the database or call Voyage. It does fetch Pew pages that are not cached yet and saves them to the cache.

```sh
.venv/bin/python -m server.ingest --dry-run
```

That command calls the FEC, Marist, and Pew loaders. Marist does nothing. The FEC loader replaces these tables from the files below:

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
    pew/
      pew_manifest.csv
      cache/
```

Files are from the [FEC bulk data page](https://www.fec.gov/data/browse-data/?tab=bulk-data). The `.txt` files are pipe-delimited and have no header row. `cn`, `cm`, and `ccl` each have a matching `*_header_file.csv`. `weball26.txt` uses the [all candidates file description](https://www.fec.gov/campaign-finance-data/all-candidates-file-description/). `webk26.txt` uses the [PAC and party summary file description](https://www.fec.gov/campaign-finance-data/pac-and-party-summary-file-description/). `independent_expenditure_2026.csv` is comma-separated and includes a header row.

A second FEC run replaces those tables. It does not append.

Pew reads `data/ingestion/pew/pew_manifest.csv`. Each article is fetched once and saved under `data/ingestion/pew/cache/`, but only after its article text is found, so an error page is never cached. A later run reads the cache. Fetches and Voyage calls retry throttling, server errors, and dropped connections.

The loader keeps the article text and the charts, with each chart's data table, note, and source. Paragraphs under one heading are merged into passages of up to 800 characters. Each passage starts with the article title and its section heading. Passages are embedded with Voyage `voyage-4` and written to `documents`, `passages`, and `passage_embeddings`.

Field dates, sample size, population, and margin of error are read from the text and written to `surveys`. `document_surveys` links each page to every survey it cites. A survey is keyed by its field dates and sample size. A chapter that omits the sample takes it from another page with the same field dates. Margin of error is often missing because most articles state it only for subgroups.

Every run rewrites each page's metadata and survey links. A page is embedded again only when its passage text changes or its vectors came from another model. Documents no longer in the manifest are deleted. If the corpus tables have an older layout, they are dropped and loaded again.

Set `VOYAGE_API_KEY` in the environment or in `.env`. This command reads `.env`. The API process does not.

## Evals

No eval command yet. Results will be recorded in [docs/evals.md](../docs/evals.md).
