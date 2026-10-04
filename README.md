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
