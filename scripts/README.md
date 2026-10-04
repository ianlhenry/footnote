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

That command calls the FEC, Marist, and Pew loaders. Marist and Pew do nothing. The FEC loader replaces these tables from the files below:

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
```

Files are from the [FEC bulk data page](https://www.fec.gov/data/browse-data/?tab=bulk-data). The `.txt` files are pipe-delimited and have no header row. `cn`, `cm`, and `ccl` each have a matching `*_header_file.csv`. `weball26.txt` uses the [all candidates file description](https://www.fec.gov/campaign-finance-data/all-candidates-file-description/). `webk26.txt` uses the [PAC and party summary file description](https://www.fec.gov/campaign-finance-data/pac-and-party-summary-file-description/). `independent_expenditure_2026.csv` is comma-separated and includes a header row.

A second run replaces those tables. It does not append.

## Evals

No eval command yet. Results will be recorded in [docs/evals.md](../docs/evals.md).
