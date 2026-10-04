# Papertrail

Paper Trail is a research assistant for polling and campaign finance data. You ask a question in plain language, and it searches poll write-ups and queries FEC records to answer it. Every claim links back to the exact passage or query result it came from, so you can check it before acting on it. When the evidence is thin or sources disagree, it says so, and when the data doesn't cover the question, it refuses and tells you what's missing.

## Run

Requires Node.js 22.18 or newer.

```sh
npm install
npm install --prefix web
npm run dev
```

Open http://127.0.0.1:5173.

## Docs

- [Architecture](docs/architecture.md)
- [Evals](docs/evals.md)
- [Backend](server/README.md)
- [Frontend](web/README.md)
- [Scripts](scripts/README.md)
