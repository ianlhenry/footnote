# Running

Requires Node.js 22.18 or newer.

Copy [`.env.example`](../.env.example) to `.env` and fill in the API keys. The database is not in the repo; build it with the ingest steps in [ingestion.md](ingestion.md).

The server reads the repo `.env` on startup. Variables already set in the shell take precedence.

- `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` are required for chat.
- `DATABASE_PATH` overrides the database file, which defaults to `data/footnote.sqlite`.

From the repo root:

```sh
npm install
npm install --prefix web
npm run dev
```

`npm run dev` runs `scripts/dev.sh`, which starts the API and the frontend together. Open http://127.0.0.1:5173.

To start one of them:

```sh
npm run dev:api
npm run dev:web
```

The API listens on http://127.0.0.1:8000. Vite proxies `/api` to that address, so start the API first when running the frontend alone.

A production build of the page, from `web/` after `npm install`:

```sh
npm run build
npm run preview
```

## Check

`npm run check` runs the formatter, the linter, both typechecks, the unit tests, and the eval tests. A commit runs it before it is created, and GitHub Actions runs it on every push.
