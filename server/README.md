# Backend

The chat API is the Hono server in `api/`. This directory is the Python package that opens the database and loads files. Ingest commands are in [scripts/README.md](../scripts/README.md).

## Run the API

From the repo root. Requires Node.js 22.18 or newer.

```sh
npm install
npm run dev:api
```

The server listens on http://127.0.0.1:8000. `POST /api/chat` takes `{ "content": "..." }` and returns the user message plus Claude's reply. `api/agent.ts` embeds the question with Voyage, retrieves the 8 nearest poll passages from the corpus (`api/retrieval.ts`), and makes one Messages API call with those passages as citable search results. It has no history, tools, or FEC data yet.

The reply also carries `status` (`answered` or `refused`), `citations`, `retrieved`, `tool_calls`, and `usage`, defined in `api/contract.ts`. The eval in `evals/` grades them. `retrieved` lists the passages given to Claude and `citations` the passages it cited. `tool_calls` stays empty until the agent has tools, and `status` is always `answered` until something decides to refuse.

`npm run dev` starts this process and the frontend together. See [web/README.md](../web/README.md).

The server reads the repo `.env` on startup. Variables already set in the shell take precedence. See `.env.example`.

- `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` are required for chat. Without either, `/api/chat` returns 503. Errors from Anthropic or Voyage return 502.
- `DATABASE_PATH` overrides the database file, which defaults to `data/papertrail.sqlite`.
