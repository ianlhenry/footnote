# Backend

The chat API is the Hono server in `api/`. This directory is the Python package that opens the database and loads files. Ingest commands are in [scripts/README.md](../scripts/README.md).

## Run the API

From the repo root. Requires Node.js 22.18 or newer.

```sh
npm install
npm run dev:api
```

The server listens on http://127.0.0.1:8000. `POST /api/chat` takes `{ "content": "..." }` and returns the user message plus Claude's reply. `api/agent.ts` makes one Messages API call per question, with no history or tools yet.

The reply also carries `status` (`answered` or `refused`), `citations`, `retrieved`, `tool_calls`, and `usage`, defined in `api/contract.ts`. The eval in `evals/` grades them. Until the agent has retrieval and tools, the lists are empty and `status` is always `answered`.

`npm run dev` starts this process and the frontend together. See [web/README.md](../web/README.md).

The server reads the repo `.env` on startup. Variables already set in the shell take precedence. See `.env.example`.

- `ANTHROPIC_API_KEY` is required for chat. Without it, `/api/chat` returns 503. Errors from Anthropic return 502.
- `DATABASE_PATH` overrides the database file, which defaults to `data/papertrail.sqlite`.
