# Footnote

Footnote is a research assistant for polling and campaign finance data:
- You ask a question in plain language, and it searches poll write-ups and queries FEC records to answer it. 
- Every claim links back to the exact passage or query result it came from, so you can check it before acting on it. 
- When the data doesn't cover the question, it refuses and tells you what's missing.

## Why, and how?

This project was designed primarily as an exercise to familiarize myself with building a product on top of an LLM, and get some experience with RAG, tool use, agent loops, citations, and evals. It is a learning project, not a production system: the corpus is small (<50 documents from two pollsters, plus FEC summary data for one cycle) and the eval set is <25 questions.

Much of this code code was written with AI coding tools (Cursor and Claude Code); I directed the design, and reviewed the changes. I wrote some key parts myself to make sure I fully understood it:
- The core agent loop in agent.ts, 
- Tool implementations in tools/declineTool.ts, tools/fecTool.ts
- The retrieval code in retrieval.ts / embeddings.ts,

## Results

Three graded runs of the 10 verified cases, three repetitions each (30 answers). Adding FEC tools moved facts from 79% to 98%. The decline tool moved refusal from 80% to 100%. The full series is in [evals/results.md](evals/results.md).

| change | facts | refusal |
| --- | --- | --- |
| Poll passages retrieved | 79% | 80% |
| FEC tools added | 98% | 80% |
| Decline tool added | 98% | 100% |

## Run

See [Running](docs/running.md).

## Docs

- [Architecture](docs/architecture.md)
- [Evals](docs/evals.md)
- [Running](docs/running.md)
- [Ingestion](docs/ingestion.md)
