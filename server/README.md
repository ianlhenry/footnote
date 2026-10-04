# Backend

The chat API is the Hono server in `api/`. This directory is the Python package that opens the database and loads files. Ingest commands are in [scripts/README.md](../scripts/README.md).

## Run the API

From the repo root. Requires Node.js 22.18 or newer.

```sh
npm install
npm run dev:api
```

The server listens on http://127.0.0.1:8000. `POST /api/chat` takes `{ "content": "..." }` and returns the user message plus an assistant message.

`npm run dev` starts this process and the frontend together. See [web/README.md](../web/README.md).

The database defaults to `data/papertrail.sqlite`. Set `DATABASE_PATH` to use another file. See `.env.example`. The process does not load `.env` by itself.
