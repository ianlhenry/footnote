# Footnote

Footnote is a research assistant for polling and campaign finance data:
- You ask a question in plain language, and it searches poll write-ups and queries FEC records to answer it. 
- Every claim links back to the exact passage or query result it came from, so you can check it before acting on it. 
- When the data doesn't cover the question, it refuses and tells you what's missing.

## Why, and how?

This project was designed primarily as an exercise to familiarize myself with building a product on top of an LLM, and get some experience with RAG, tool use, agent loops, citations, and evals. It is a learning project, not a production system: the corpus is small (<50 documents from two pollsters, plus FEC summary data for one cycle) and the eval set is 10 questions.

Much of this code code was written with AI coding tools (Cursor and Claude Code); I directed the design, and reviewed the changes. I wrote some key parts myself to make sure I fully understood it:
- The core agent loop in `agent.ts` sends the nearest passages to Claude, runs tool calls until it answers or declines, and turns the reply into citations and retrieved records.
- The tool wiring in `tools/declineTool.ts` and `tools/fecTool.ts`: routing each FEC tool call to its query, and reading the refusal reason from a decline call.
- The retrieval code in `retrieval.ts` and `embeddings.ts` embeds the question, finds the nearest passages, and attaches each page's survey lines.

## Results

The same 10 verified cases, asked three times (30 answers). Each row adds one capability. The full series is in [evals/results.md](evals/results.md).

With no sources, the model stated almost none of the labeled facts. Sending the eight nearest poll passages made the poll questions answerable, and facts rose from 2% to 79%. FEC lookup tools then covered the money questions, and facts rose to 98%. A decline tool made the two out-of-scope cases refuse instead of guessing, and refusal rose from 80% to 100%. Until then, refusal sat at 80% because eight of the ten cases should be answered.

| added | facts | refusal |
| --- | --- | --- |
| One Claude call, no sources | 2% | 80% |
| Eight nearest poll passages | 79% | 80% |
| FEC lookup tools | 98% | 80% |
| Decline tool | 98% | 100% |

## Run

See [Running](docs/running.md).

## Docs

- [Architecture](docs/architecture.md)
- [Evals](docs/evals.md)
- [Running](docs/running.md)
- [Ingestion](docs/ingestion.md)
