# Evals

The eval asks Paper Trail a fixed set of questions through `/api/chat`, the same endpoint the UI uses, and scores the answers. The code is in `evals/`. Results across runs are in [evals/results.md](../evals/results.md).

## Running it

Start the API first (`npm run dev:api`). Then:

```sh
npm run eval -- plan                                   # check cases.json and count the calls a run would make; calls nothing
npm run eval -- run --yes --note "what changed"        # ask every case, grade, and log the run
npm run eval -- run --yes --note "pilot" --only texas-senate-poll,gallup-approval
npm run eval -- grade <run-id> --yes                   # grade a stored run again, after a label or grader change
npm run eval -- summary                                # rebuild evals/results.md
npm run eval -- review                                 # write evals/cases.md, a readable sheet of the cases
npm run test:evals                                     # self-test of the eval's own code; calls nothing
```

A run costs money: one `/api/chat` request per case, which calls Claude, and one judge call per answer, plus one more for any answer with citations. `run` refuses without `--yes` and prints the plan instead. `plan` shows the measured cost per answer from the last graded run once there is one. `grade` only asks for `--yes` when the judge cache cannot answer, and the cache lives in `data/evals/judge-cache/`, so grading the same answers again is free.

`--reps N` asks each case N times. With 10 cases and one rep, a score that moves less than about ±30 points is within noise. Use `--reps 3` or more, or more cases, before acting on smaller changes. The pilot measured about $0.008 per answer with the judge included, so a full run costs about $0.08 per rep.

## The test set

`evals/cases.json` holds the questions. Each case has:

- `question`, and `tags`, where the first tag is the category the reports group by.
- `expect`: `answer`, or `refuse` when the right behavior is to decline because the data is not loaded or the request is out of scope.
- `facts`: what a correct answer states. A fact's `values` are figures that code checks for in the answer text. Percentages match within half a point, dollars within 1%, and counts within 0.5%.
- `must_not`: things a correct answer must not do, such as naming the wrong leader or predicting a winner.
- `sources`: the documents (by URL) or FEC records (by table and id) that the answer should draw on.
- `verified` and `provenance`: where the label came from and whether a person has checked it.

The 10 cases were drafted by Claude from the database and are unverified. Because they were read from the database, a label inherits any ingestion error, so check them against the original pages. 25 more drafted cases are parked in `evals/cases-backlog.json`; move one into `cases.json` to use it. To verify one, check its facts against the source named in `provenance`, fix anything wrong, and set `verified` to true. Only verified cases count in the "Verified cases" table in `evals/results.md`. After changing labels, run `grade` on earlier runs so their scores use the new labels.

## Graders

Every metric is a score from 0 to 1 per answer, or blank (—) when it does not apply.

| metric | how | what it checks |
| --- | --- | --- |
| facts | judge | Share of the labeled facts the answer states |
| numbers | code | Share of the labeled figures found in the answer text |
| no_errors | judge | No fact contradicted and no `must_not` rule broken |
| refusal | code | The `status` field matches `expect` |
| refusal_text | judge | Whether the text declines matches `expect`, regardless of `status` |
| retrieval | code | Share of the expected sources among the retrieved items |
| citation_coverage | code | Share of figures in the answer that a citation's claim covers |
| quote_fidelity | code | Share of passage citations whose quote appears in the retrieved passage |
| citation_support | judge | Share of citations whose quote supports the claim |

Retrieval and citation metrics stay blank for a whole run until the agent returns retrieved items or citations, so a missing feature does not count as a failure. Today the agent has no retrieval or citations and always reports `answered`, so only facts, numbers, no_errors, and the two refusal metrics mean anything, and `refusal` fails every refusal case.

The judge is `claude-sonnet-5-5` at medium effort by default, the same model the agent uses. A judge tends to favor answers written like its own, so treat close calls with care, or pass `--judge-model claude-opus-5-5` to compare. It is given the answer as data, told not to reward length, and returns a structured verdict per fact, per rule, and per citation, with quoted evidence. A judge served by a different model than requested fails the case instead of grading it.

## What a run saves

Each run is a directory under `evals/runs/`, committed with everything in it:

- `run.json`: the note, the commit and whether the tree had uncommitted changes, a digest of `api/`, the corpus size, the agent and judge models, and counts.
- `answers.jsonl`: every answer as the API returned it, with retrieved items, citations, token usage, and latency.
- `errors.jsonl`: attempts that never produced an answer (timeouts, HTTP errors, responses that do not match `api/contract.ts`). They are not scored, and `--resume <run>` asks them again.
- `grades.jsonl`: per-answer metrics and the judge's evidence. Rewritten on every `grade`.
- `report.md`: scores overall and by category, and the problems found in each answer, with the answer text.

## Error analysis

When a run fails questions, start from its `report.md`. Note the question, the wrong answer, and whether the miss was retrieval, a wrong figure, a bad FEC join, a refusal that should have been an answer, or a bad label.
