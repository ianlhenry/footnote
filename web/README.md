# Frontend

React chat page, built with Vite.

From the repo root:

```sh
npm install --prefix web
npm run dev:web
```

Or from this directory, after `npm install`:

```sh
npm run dev
```

Each answer shows numbered citation markers that link to a source list below it, with the quoted text and a link to the article or FEC record. A badge marks answers the agent declined, with the reason. "Trace" expands to the passages retrieved, each FEC tool call and what it returned, and the Claude calls, tokens, and seconds the answer took. While the agent works, a spinner shows what it is doing, such as searching reports or looking up FEC candidates, and the reply appears as Claude writes it. Citation markers and sources are added when it finishes. The page reads `POST /api/chat/stream`.

Open http://127.0.0.1:5173. Vite proxies `/api` to http://127.0.0.1:8000. Start the API first, or use `npm run dev` from the repo root to start both.

The repo expects Node.js 22.18 or newer. Production build: `npm run build`, then `npm run preview`.
