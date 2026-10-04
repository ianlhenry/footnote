// Checks the eval's own plumbing without calling Claude: number matching,
// every code-graded metric (with a stand-in judge), and the runner against a
// fake API. Run with `npm run test:evals`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Answer } from "../api/contract.ts";
import { type Case, loadCases } from "./cases.ts";
import { type AnswerRow, grade, runFeatures } from "./grade.ts";
import type { Judge } from "./judge.ts";
import { findFigures, stated } from "./numbers.ts";

const cases = loadCases();
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Says a fact is supported when every figure in it is stated, and that the
// answer declines when it says so. Good enough to test the code around it.
const stubJudge = {
  async facts(item: Case, answer: string) {
    return {
      verdict: {
        facts: item.facts.map((fact, index) => {
          const values = fact.values ?? [];
          const found = values.length ? values.every((value) => stated(value, answer)) : answer.includes(fact.text);
          return { index, verdict: found ? ("supported" as const) : ("missing" as const), evidence: "" };
        }),
        must_not: item.must_not.map((_, index) => ({ index, violated: false, evidence: "" })),
        declines: /don't have|not loaded/i.test(answer),
        declines_evidence: "",
      },
      usage: { model: "stub", input_tokens: 0, output_tokens: 0, cached: true },
    };
  },
  async citations(citations: { claim: string; quote: string }[]) {
    return {
      verdict: { citations: citations.map((citation, index) => ({ index, supports: citation.quote.length > 0, reason: "" })) },
      usage: { model: "stub", input_tokens: 0, output_tokens: 0, cached: true },
    };
  },
} as unknown as Judge;

function answerRow(item: Case, answer: Partial<Answer> & { text: string }): AnswerRow {
  return {
    case_id: item.id,
    rep: 0,
    question: item.question,
    latency_s: 1,
    retries: 0,
    answer: { status: "answered", decline_reason: null, citations: [], retrieved: [], tool_calls: [], usage: [], ...answer },
  };
}

test("figures match across the ways answers write them", () => {
  assert.ok(stated({ n: 68560930.42, kind: "usd" }, "Talarico raised $68.6 million."));
  assert.ok(stated({ n: 68560930.42, kind: "usd" }, "He raised $68,560,930.42 in total."));
  assert.ok(stated({ n: 52, kind: "pct" }, "About half (52%) say so."));
  assert.ok(stated({ n: 42, kind: "pct" }, "Turek leads 50-42."));
  assert.ok(stated({ n: 1298, kind: "count" }, "A survey of 1,298 voters."));
  assert.ok(stated({ n: 9, kind: "num" }, "There are nine groups."));
  assert.ok(stated({ n: 3.8, kind: "num" }, "plus or minus 3.8 percentage points"));
  assert.ok(!stated({ n: 68560930.42, kind: "usd" }, "He raised $60 million."));
  assert.ok(!stated({ n: 5103, kind: "count" }, "51% approve."));
  assert.ok(!stated({ n: 52, kind: "pct" }, "53% say too much."));
});

test("citation coverage skips dates and number words", () => {
  const figures = findFigures("Pew surveyed 5,103 adults April 20-26, 2026; one group, 34% approve. Sept. 14-15 and 2026-09-14, in a September 2026 poll.");
  assert.deepEqual(figures.map((found) => found.value), [5103, 34]);
});

test("every labeled figure appears in its own fact text", () => {
  // Otherwise the numbers metric could never pass for that case.
  for (const item of cases) {
    for (const fact of item.facts) {
      for (const value of fact.values ?? []) {
        assert.ok(stated(value, fact.text), `${item.id}: ${value.n} is not in "${fact.text}"`);
      }
    }
  }
});

test("an answer that states every fact scores full marks", async () => {
  const answerCases = cases.filter((item) => item.expect === "answer");
  const rows = answerCases.map((item) => answerRow(item, { text: item.facts.map((fact) => fact.text).join(". ") }));
  const features = runFeatures(rows);
  for (const [index, item] of answerCases.entries()) {
    const graded = await grade(item, rows[index], features, stubJudge);
    assert.equal(graded.metrics.facts, 1, item.id);
    if (graded.metrics.numbers !== null) {
      assert.equal(graded.metrics.numbers, 1, item.id);
    }
    assert.equal(graded.metrics.refusal, 1, item.id);
    assert.equal(graded.metrics.retrieval, null, "no retrieval in the run means not applicable");
    assert.equal(graded.metrics.citation_support, null);
  }
});

test("an empty or evasive answer scores zero on facts and figures", async () => {
  for (const text of ["", "I don't know."]) {
    for (const item of cases.filter((c) => c.expect === "answer")) {
      const graded = await grade(item, answerRow(item, { text }), { retrieval: false, citations: false }, stubJudge);
      assert.equal(graded.metrics.facts, 0, item.id);
      if (graded.metrics.numbers !== null) {
        assert.equal(graded.metrics.numbers, 0, item.id);
      }
    }
  }
});

test("refusal is graded from status, and the text check separately", async () => {
  const refuse = cases.find((item) => item.expect === "refuse")!;
  const answer = cases.find((item) => item.expect === "answer")!;
  const none = { retrieval: false, citations: false };
  const declined = await grade(refuse, answerRow(refuse, { text: "I don't have that data.", status: "refused" }), none, stubJudge);
  assert.equal(declined.metrics.refusal, 1);
  assert.equal(declined.metrics.refusal_text, 1);
  assert.equal(declined.metrics.facts, null);
  // Today's agent always says "answered", so status fails even when the text declines.
  const stub = await grade(refuse, answerRow(refuse, { text: "I don't have that data." }), none, stubJudge);
  assert.equal(stub.metrics.refusal, 0);
  assert.equal(stub.metrics.refusal_text, 1);
  const wrongly = await grade(answer, answerRow(answer, { text: "I don't have that data.", status: "refused" }), none, stubJudge);
  assert.equal(wrongly.metrics.refusal, 0);
});

test("retrieval counts expected documents and FEC records", async () => {
  const item = cases.find((c) => c.id === "iowa-poll-and-money")!;
  const passage = (url: string) => ({ source: { kind: "passage" as const, passage_id: 1, document_url: url }, score: 0.9, text: "" });
  const fec = (id: string) => ({ source: { kind: "fec" as const, table: "fec_candidate_summary", id }, score: null, text: "" });
  const all = answerRow(item, {
    text: "",
    retrieved: [passage("https://maristpoll.marist.edu/polls/2026-midterm-elections-in-iowa-september-2026"), fec("S6IA00314"), fec("S6IA00298")],
  });
  const some = answerRow(item, { text: "", retrieved: [fec("S6IA00314")] });
  const features = { retrieval: true, citations: false };
  assert.equal((await grade(item, all, features, stubJudge)).metrics.retrieval, 1, "a trailing slash does not matter");
  const partial = await grade(item, some, features, stubJudge);
  assert.equal(partial.metrics.retrieval, 1 / 3);
  assert.equal(partial.details.missing_sources?.length, 2);
});

test("citation coverage, quote fidelity, and support", async () => {
  const item = cases.find((c) => c.id === "texas-senate-poll")!;
  const source = { kind: "passage" as const, passage_id: 7, document_url: "https://example.org/texas" };
  const row = answerRow(item, {
    text: "Talarico has 50% and Paxton 44% in a September 2026 poll.",
    retrieved: [{ source, score: 0.8, text: "Paxton (R): 44%\nTalarico (D): 50%" }],
    citations: [
      { claim: "Talarico has 50%", source, title: "Texas poll", label: "Marist Poll · state release", quote: "Talarico (D): 50%" },
      { claim: "Paxton 44%", source, title: "Texas poll", label: "Marist Poll · state release", quote: "Paxton (R): 41%" },
    ],
  });
  const graded = await grade(item, row, { retrieval: true, citations: true }, stubJudge);
  assert.equal(graded.metrics.citation_coverage, 1, "the year is not a figure that needs a citation");
  assert.equal(graded.metrics.quote_fidelity, 0.5, "the second quote is not in the passage");
  assert.deepEqual(graded.details.unfaithful_quotes, [1]);
  assert.equal(graded.metrics.citation_support, 1);
});

test("the runner stores answers, and records failures without scoring them", async () => {
  const good = cases[0];
  const broken = cases[1];
  const down = cases[2];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { content } = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (!content) {
        return response.writeHead(400).end(JSON.stringify({ detail: "content is required" }));
      }
      if (content === down.question) {
        return response.writeHead(503).end(JSON.stringify({ detail: "ANTHROPIC_API_KEY is not set" }));
      }

      const assistant =
        content === broken.question
          ? { id: 2, role: "assistant", content: "missing fields" }
          : {
              id: 2, role: "assistant", content: "Talarico 50%, Paxton 44%.", status: "answered",
              citations: [], retrieved: [], tool_calls: [],
              usage: [{ model: "claude-sonnet-5-5", stop_reason: "end_turn", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
            };
      response.writeHead(200).end(JSON.stringify({ messages: [{ id: 1, role: "user", content }, assistant] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "papertrail-eval-"));
  try {
    const cli = (...args: string[]) =>
      new Promise<{ status: number | null; output: string }>((resolve) => {
        // spawnSync would block this process's event loop, and with it the fake server.
        const child = spawnCli(args, runsDir);
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk));
        child.on("close", (status: number | null) => resolve({ status, output }));
      });
    const result = await cli("run", "--yes", "--no-judge", "--note", "self test", "--only", [good.id, broken.id, down.id].join(","), "--url", `http://127.0.0.1:${port}`);
    assert.equal(result.status, 0, result.output);
    const [runId] = fs.readdirSync(runsDir).filter((name) => fs.statSync(path.join(runsDir, name)).isDirectory());
    const dir = path.join(runsDir, runId);
    const answers = fs.readFileSync(path.join(dir, "answers.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const errors = fs.readFileSync(path.join(dir, "errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(answers.map((row) => row.case_id), [good.id]);
    assert.deepEqual(errors.map((row) => [row.case_id, row.failure_class]).sort(), [[broken.id, "contract"], [down.id, "http"]].sort());
    const info = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    assert.deepEqual(info.agent_models, ["claude-sonnet-5-5"]);
    assert.equal(info.note, "self test");
    // A resume asks only what failed.
    const resumed = await cli("run", "--yes", "--no-judge", "--resume", runId, "--only", [good.id, broken.id, down.id].join(","), "--url", `http://127.0.0.1:${port}`);
    assert.match(resumed.output, /asking 2 questions \(1 already stored\)/);
  } finally {
    server.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("plan calls nothing and run refuses to spend without --yes", () => {
  const result = spawnSync("npx", ["tsx", "evals/cli.ts", "run", "--note", "x"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--yes/);
});

function spawnCli(args: string[], runsDir: string) {
  return spawn("npx", ["tsx", "evals/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, EVAL_RUNS_DIR: runsDir } });
}
