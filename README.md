# Papertrail

A local chat app for questions about public political data. Answers will come from a SQLite database of FEC filings, Marist polls, and Pew research.

## Architecture

- **Front end.** `web/` is a React chat page, built with Vite. It listens on port 5173 and proxies `/api` to the API. Vite fits a single client-rendered page, and the proxy lets that page call `/api` on its own origin while the API runs as a separate process.
- **Back end.** `api/` is a Hono server on port 8000. `POST /api/chat` accepts `{ "content": "..." }` and returns the user message plus an assistant message. On startup it opens SQLite through `node:sqlite` and loads `sqlite-vec`. Hono is TypeScript-native, and its streaming helpers are there for token-by-token replies.
- **Ingestion.** `server/` is Python. `python -m server.ingest` calls the FEC, Marist, and Pew loaders. `server/db.py` opens the same database, `data/papertrail.sqlite`, unless `DATABASE_PATH` is set. Loading those sources is a batch job, so it stays separate from the chat server and writes into the same SQLite file.

## Run

Requires Node.js 22.18 or newer.

```sh
npm install
npm install --prefix web
npm run dev
```

Open http://127.0.0.1:5173. The API listens on port 8000, and Vite proxies `/api` to it.

Set `DATABASE_PATH` to override the database location (see `.env.example`). The default is `data/papertrail.sqlite`.

## Ingest

Ingestion uses Python 3.

```sh
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
.venv/bin/python -m server.ingest
```

The FEC loader replaces `fec_candidate`, `fec_committee`, `fec_candidate_committee`, `fec_candidate_summary`, `fec_pac_summary`, and `fec_independent_expenditure` from `cn.txt`, `cm.txt`, `ccl.txt`, `weball26.txt`, `webk26.txt`, and `independent_expenditure_2026.csv`. Marist and Pew are not loaded yet.

Raw downloads live under `data/ingestion/<source>/`. `data/` is gitignored, so those files stay local. The database is a separate file, `data/papertrail.sqlite`.

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

FEC files are from the [FEC bulk data page](https://www.fec.gov/data/browse-data/?tab=bulk-data). The `.txt` files are pipe-delimited and have no header row. `cn`, `cm`, and `ccl` each have a matching `*_header_file.csv`: one CSV line of column names, in the same order as the fields. `weball26.txt` and `webk26.txt` have no header file. Their columns are the fields in the FEC descriptions linked below. `independent_expenditure_2026.csv` is comma-separated and includes a header row.

| File | Header | What it is |
| --- | --- | --- |
| `cn.txt` | `cn_header_file.csv` | Candidate master. One record for each candidate who has registered with the FEC or appeared on a state ballot list. |
| `cm.txt` | `cm_header_file.csv` | Committee master. One record for each committee registered with the FEC. |
| `ccl.txt` | `ccl_header_file.csv` | Candidate-committee linkages. One record for each link between a candidate and a committee. |
| `weball26.txt` | [All candidates file description](https://www.fec.gov/campaign-finance-data/all-candidates-file-description/) | All-candidates summary for 2025–2026. One record per candidate who raised or spent money, with receipt and disbursement totals. |
| `webk26.txt` | [PAC and party summary file description](https://www.fec.gov/campaign-finance-data/pac-and-party-summary-file-description/) | PAC and party summary for 2025–2026. One record per committee, with receipts, disbursements, and independent-expenditure totals. |
| `independent_expenditure_2026.csv` | Header row in the file | Independent expenditures for 2025–2026. One row per reported expenditure, including amendments. |
