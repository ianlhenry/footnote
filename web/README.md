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

Open http://127.0.0.1:5173. Vite proxies `/api` to http://127.0.0.1:8000. Start the API first, or use `npm run dev` from the repo root to start both.

The repo expects Node.js 22.18 or newer. Production build: `npm run build`, then `npm run preview`.
