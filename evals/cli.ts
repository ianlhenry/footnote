import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { type Case, loadCases, CASES_PATH } from "./cases.ts";
import { type AnswerRow, type GradeRow, grade, runFeatures } from "./grade.ts";
import { Judge, JudgeMiss, JUDGE_PROMPT_VERSIONS, type JudgeConfig } from "./judge.ts";
import { agentCost, judgeCost, readJsonl, type RunInfo, writeReport, writeSummary } from "./report.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// The self-test points this at a scratch directory.
const RUNS_DIR = process.env.EVAL_RUNS_DIR ?? path.join(ROOT, "evals", "runs");
const RESULTS_PATH = process.env.EVAL_RUNS_DIR
  ? path.join(process.env.EVAL_RUNS_DIR, "results.md")
  : path.join(ROOT, "evals", "results.md");
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const DEFAULT_URL = "http://127.0.0.1:8000";
const DEFAULT_JUDGE: JudgeConfig = { model: "claude-sonnet-5-5", effort: "medium" };

// What /api/chat must return. A change to api/contract.ts that breaks this
// fails the case loudly instead of grading a malformed answer.
const SourceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passage"), passage_id: z.number(), document_url: z.string() }),
  z.object({ kind: z.literal("fec"), table: z.string(), id: z.string() }),
]);
const AnswerSchema = z.object({
  content: z.string(),
  status: z.enum(["answered", "refused"]),
  // Older runs predate decline_reason.
  decline_reason: z.enum(["not_loaded", "out_of_scope", "opinion"]).nullable().default(null),
  citations: z.array(z.object({ claim: z.string(), source: SourceRef, quote: z.string() })),
  retrieved: z.array(z.object({ source: SourceRef, score: z.number().nullable(), text: z.string() })),
  tool_calls: z.array(z.object({ name: z.string(), input: z.unknown(), output: z.unknown() })),
  usage: z.array(
    z.object({
      model: z.string(),
      stop_reason: z.string().nullable(),
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
    }),
  ),
});
const ChatResponse = z.object({ messages: z.array(z.unknown()).min(1) });

const USAGE = `Usage: npm run eval -- <command> [options]

  plan                 Check cases.json and count the calls a run would make. Calls nothing.
  run --yes --note "…" Ask every case through /api/chat, then grade. Costs money.
  grade <run> [--yes]  Grade a stored run again. Asks --yes only if the judge cache misses.
  summary              Rebuild evals/results.md from every run.
  review               Write evals/cases.md, a readable sheet of the cases.

Options:
  --note TEXT          What changed since the last run. Required for run.
  --only ID,ID         Run only these case ids.
  --verified-only      Run only cases marked verified.
  --reps N             Times to ask each case (default 1).
  --concurrency N      Questions in flight at once (default 3).
  --timeout-s N        Seconds before one question fails (default 180).
  --url URL            Where the API listens (default ${DEFAULT_URL}).
  --judge-model ID     Judge model (default ${DEFAULT_JUDGE.model}).
  --judge-effort E     low, medium, or high (default ${DEFAULT_JUDGE.effort}).
  --no-judge           Store answers without grading them.
  --resume RUN         Continue a run that stopped, skipping answers already stored.
  --yes                Allow calls that cost money.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      note: { type: "string" },
      only: { type: "string" },
      "verified-only": { type: "boolean", default: false },
      reps: { type: "string", default: "1" },
      concurrency: { type: "string", default: "3" },
      "timeout-s": { type: "string", default: "180" },
      url: { type: "string", default: DEFAULT_URL },
      "judge-model": { type: "string", default: DEFAULT_JUDGE.model },
      "judge-effort": { type: "string", default: DEFAULT_JUDGE.effort },
      "no-judge": { type: "boolean", default: false },
      resume: { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) return console.log(USAGE);

  const judgeConfig = JudgeConfigSchema.parse({ model: values["judge-model"], effort: values["judge-effort"] });
  const options = {
    reps: positiveInt(values.reps, "--reps"),
    concurrency: positiveInt(values.concurrency, "--concurrency"),
    timeoutS: positiveInt(values["timeout-s"], "--timeout-s"),
  };

  switch (command) {
    case "plan":
      return plan(selectCases(values.only, values["verified-only"]), options.reps, judgeConfig);
    case "review":
      return review();
    case "summary":
      writeSummary(RUNS_DIR, RESULTS_PATH);
      return console.log("Wrote evals/results.md.");
    case "grade": {
      if (!target) fail("grade needs a run id or directory");
      return gradeRun(resolveRun(target), judgeConfig, values.yes, options.concurrency);
    }
    case "run": {
      const cases = selectCases(values.only, values["verified-only"]);
      if (!values.yes) {
        await plan(cases, options.reps, judgeConfig);
        fail("run calls Claude through /api/chat and the judge. Re-run with --yes to spend.");
      }
      const note = values.note?.trim();
      if (!note && !values.resume) fail("run needs --note describing what changed");
      const dir = values.resume ? resolveRun(values.resume) : newRunDir(note!);
      await askAll(dir, cases, { ...options, url: values.url, note: note ?? "" });
      if (!values["no-judge"]) await gradeRun(dir, judgeConfig, true, options.concurrency);
      return;
    }
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

const JudgeConfigSchema = z.object({ model: z.string(), effort: z.enum(["low", "medium", "high"]) });

function selectCases(only: string | undefined, verifiedOnly: boolean): Case[] {
  let cases = loadCases();
  if (only) {
    const ids = new Set(only.split(",").map((id) => id.trim()));
    const unknown = [...ids].filter((id) => !cases.some((item) => item.id === id));
    if (unknown.length) fail(`unknown case ids: ${unknown.join(", ")}`);
    cases = cases.filter((item) => ids.has(item.id));
  }
  if (verifiedOnly) cases = cases.filter((item) => item.verified);
  if (!cases.length) fail("no cases selected");
  return cases;
}

async function plan(cases: Case[], reps: number, judgeConfig: JudgeConfig) {
  const verified = cases.filter((item) => item.verified).length;
  const byCategory = new Map<string, number>();
  for (const item of cases) byCategory.set(item.tags[0], (byCategory.get(item.tags[0]) ?? 0) + 1);
  console.log(`cases.json is valid: ${cases.length} cases selected, ${verified} verified.`);
  console.log(`  ${[...byCategory].map(([name, count]) => `${name} ${count}`).join(", ")}`);
  console.log(`  expect answer ${cases.filter((c) => c.expect === "answer").length}, refuse ${cases.filter((c) => c.expect === "refuse").length}`);
  console.log(`\nA run would make:`);
  console.log(`  ${cases.length * reps} requests to /api/chat (${cases.length} cases × ${reps} reps). Each makes as many Claude calls as the agent does; today that is 1.`);
  console.log(`  up to ${cases.length * reps} judge calls on ${judgeConfig.model} (effort ${judgeConfig.effort}) to grade facts, plus 1 per answer that has citations.`);
  const estimate = measuredCost();
  if (estimate) {
    console.log(`\nLast graded run (${estimate.run}) cost $${estimate.perAnswer.toFixed(4)} per answer, judge included.`);
    console.log(`  At that rate this run would cost about $${(estimate.perAnswer * cases.length * reps).toFixed(2)}.`);
  } else {
    console.log(`\nNo graded run yet, so there is no measured cost. Pilot with --only on 2 or 3 cases to measure it.`);
  }
}

function measuredCost(): { run: string; perAnswer: number } | null {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const runs = fs.readdirSync(RUNS_DIR).filter((name) => fs.existsSync(path.join(RUNS_DIR, name, "grades.jsonl"))).sort();
  const last = runs.at(-1);
  if (!last) return null;
  const answers = readJsonl<AnswerRow>(path.join(RUNS_DIR, last, "answers.jsonl"));
  const grades = readJsonl<GradeRow>(path.join(RUNS_DIR, last, "grades.jsonl"));
  if (!answers.length) return null;
  const total = answers.reduce((sum, row) => sum + agentCost(row), 0) + grades.reduce((sum, row) => sum + judgeCost(row, true), 0);
  return { run: last, perAnswer: total / answers.length };
}

async function askAll(dir: string, cases: Case[], options: { reps: number; concurrency: number; timeoutS: number; url: string; note: string }) {
  await preflight(options.url);
  fs.mkdirSync(dir, { recursive: true });
  const infoPath = path.join(dir, "run.json");
  const resumed = fs.existsSync(infoPath);
  const info: RunInfo = resumed
    ? JSON.parse(fs.readFileSync(infoPath, "utf8"))
    : {
        id: path.basename(dir),
        note: options.note,
        started_at: new Date().toISOString(),
        finished_at: null,
        url: options.url,
        reps: options.reps,
        case_ids: cases.map((item) => item.id),
        cases_sha: sha(fs.readFileSync(CASES_PATH)),
        git: gitState(),
        api_sha: apiSha(),
        corpus: corpusState(),
        judge: null,
        agent_models: [],
        answers: 0,
        errors: 0,
      };
  if (resumed && info.api_sha !== apiSha()) {
    fail(`api/ changed since ${info.id} started, so resumed answers would come from a different agent. Start a new run.`);
  }
  writeJson(infoPath, info);

  const answersPath = path.join(dir, "answers.jsonl");
  const errorsPath = path.join(dir, "errors.jsonl");
  const done = new Set(readJsonl<AnswerRow>(answersPath).map((row) => `${row.case_id}#${row.rep}`));
  const tasks = info.case_ids
    .map((id) => cases.find((item) => item.id === id))
    .filter((item): item is Case => item !== undefined)
    .flatMap((item) => Array.from({ length: info.reps }, (_, rep) => ({ item, rep })))
    .filter(({ item, rep }) => !done.has(`${item.id}#${rep}`));
  console.log(`${info.id}: asking ${tasks.length} questions (${done.size} already stored).`);

  let next = 0;
  let failed = 0;
  async function worker() {
    while (next < tasks.length) {
      const { item, rep } = tasks[next++];
      try {
        const asked = await askOne(options.url, item.question, options.timeoutS);
        const row: AnswerRow = { case_id: item.id, rep, question: item.question, ...asked };
        fs.appendFileSync(answersPath, JSON.stringify(row) + "\n");
        console.log(`  ${item.id}#${rep} ${asked.answer.status} in ${asked.latency_s.toFixed(1)}s`);
      } catch (error) {
        failed++;
        const failure = error instanceof AskError ? error : new AskError("error", String(error), 0);
        // Failed attempts never take the case's slot in answers.jsonl, so a
        // resume asks them again.
        fs.appendFileSync(
          errorsPath,
          JSON.stringify({ case_id: item.id, rep, failure_class: failure.kind, error: failure.message, retries: failure.retries, at: new Date().toISOString() }) + "\n",
        );
        console.error(`  ${item.id}#${rep} FAILED (${failure.kind}): ${failure.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  const answers = readJsonl<AnswerRow>(answersPath);
  info.answers = answers.length;
  info.errors = readJsonl(errorsPath).length;
  info.agent_models = [...new Set(answers.flatMap((row) => row.answer.usage.map((usage) => usage.model)))].sort();
  info.finished_at = new Date().toISOString();
  writeJson(infoPath, info);
  console.log(`${info.id}: ${answers.length} answers stored, ${failed} failed this pass.`);
  if (info.agent_models.length > 1) console.warn(`  Answers came from more than one model: ${info.agent_models.join(", ")}.`);
}

class AskError extends Error {
  constructor(
    readonly kind: "timeout" | "http" | "contract" | "network" | "error",
    message: string,
    readonly retries: number,
  ) {
    super(message);
  }
}

// An empty question gets a 400 without calling Claude, so it shows the server
// is up and is the API this runner expects.
async function preflight(url: string) {
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    if (response.status !== 400) fail(`${url}/api/chat answered ${response.status} to an empty question; expected 400.`);
  } catch (error) {
    fail(`cannot reach ${url}. Start the API with \`npm run dev:api\`. (${error})`);
  }
}

async function askOne(url: string, question: string, timeoutS: number) {
  const deadline = Date.now() + timeoutS * 1000;
  let retries = 0;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: question }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      if (Date.now() >= deadline) throw new AskError("timeout", `no answer within ${timeoutS}s`, retries);
      if (attempt < 3) {
        retries++;
        await backoff(attempt, deadline);
        continue;
      }
      throw new AskError("network", String(error), retries);
    }
    const latency_s = (Date.now() - started) / 1000;
    const body = await response.json().catch(() => null);
    // The API answers 502 when the Anthropic call failed and 500 on a crash;
    // both may pass. 503 means the key is missing, which retrying cannot fix.
    if ([429, 500, 502, 504].includes(response.status) && attempt < 3) {
      retries++;
      await backoff(attempt, deadline);
      continue;
    }
    if (!response.ok) throw new AskError("http", `HTTP ${response.status}: ${JSON.stringify(body)}`, retries);
    const parsed = ChatResponse.safeParse(body);
    const last = parsed.success ? parsed.data.messages.at(-1) : undefined;
    const answer = AnswerSchema.safeParse(last);
    if (!answer.success) throw new AskError("contract", `response does not match api/contract.ts: ${answer.error.message}`, retries);
    const { content, ...rest } = answer.data;
    return { answer: { text: content, ...rest }, latency_s, retries };
  }
}

async function backoff(attempt: number, deadline: number) {
  const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
  if (Date.now() + delay >= deadline) throw new AskError("timeout", "no time left to retry", attempt);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function gradeRun(dir: string, judgeConfig: JudgeConfig, allowSpend: boolean, concurrency: number) {
  const info: RunInfo = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const cases = new Map(loadCases().map((item) => [item.id, item]));
  const answers = readJsonl<AnswerRow>(path.join(dir, "answers.jsonl"));
  const features = runFeatures(answers);
  const orphans = answers.filter((row) => !cases.has(row.case_id));
  if (orphans.length) console.warn(`  ${orphans.length} answers belong to cases no longer in cases.json; skipping them.`);
  const rows = answers.filter((row) => cases.has(row.case_id));

  // Count what the cache cannot answer before spending anything.
  const offline = new Judge(judgeConfig, true);
  let misses = 0;
  for (const row of rows) {
    try {
      await grade(cases.get(row.case_id)!, row, features, offline);
    } catch (error) {
      if (!(error instanceof JudgeMiss)) throw error;
      misses++;
    }
  }
  if (misses && !allowSpend) {
    fail(`${misses} of ${rows.length} answers need judge calls on ${judgeConfig.model}. Re-run with --yes to spend.`);
  }

  const judge = new Judge(judgeConfig);
  const graded: GradeRow[] = new Array(rows.length);
  const failures: string[] = [];
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index];
      try {
        graded[index] = await grade(cases.get(row.case_id)!, row, features, judge);
      } catch (error) {
        failures.push(`${row.case_id}#${row.rep}: ${error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const failure of failures) console.error(`  grading failed: ${failure}`);

  // Grades are derived, so each grading pass replaces the file.
  const lines = graded.filter(Boolean).map((row) => JSON.stringify(row));
  fs.writeFileSync(path.join(dir, "grades.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));
  info.judge = { ...judgeConfig, prompt_versions: { ...JUDGE_PROMPT_VERSIONS } };
  writeJson(path.join(dir, "run.json"), info);
  writeReport(dir);
  writeSummary(RUNS_DIR, RESULTS_PATH);
  console.log(`${info.id}: graded ${lines.length} answers${failures.length ? `, ${failures.length} failed` : ""}. See ${path.relative(ROOT, path.join(dir, "report.md"))}.`);
  if (failures.length) process.exitCode = 1;
}

function review() {
  const cases = loadCases();
  const fence = (text: string) => {
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const ticks = "`".repeat(longest + 1);
    return `${ticks}\n${text}\n${ticks}`;
  };
  const lines = [
    "# Eval cases",
    "",
    "Generated by `npm run eval -- review` from `evals/cases.json`. Edit the JSON, not this file.",
    "",
    `${cases.length} cases, ${cases.filter((item) => item.verified).length} verified.`,
    "",
    "| id | category | expect | verified | facts | sources |",
    "| --- | --- | --- | --- | --- | --- |",
    ...cases.map((item) => `| [${item.id}](#${item.id}) | ${item.tags[0]} | ${item.expect} | ${item.verified ? "yes" : "no"} | ${item.facts.length} | ${item.sources.length} |`),
    "",
  ];
  for (const item of cases) {
    lines.push(`## ${item.id}`, "", fence(item.question), "");
    lines.push(`Tags: ${item.tags.join(", ")}. Expect: **${item.expect}**. Verified: ${item.verified ? "yes" : "**no**"}.`, "");
    if (item.facts.length) {
      lines.push("Facts:", "");
      for (const fact of item.facts) {
        const values = fact.values?.map((value) => `${value.n} ${value.kind}`).join(", ");
        lines.push(`- ${fact.text}${values ? ` _(checked: ${values})_` : ""}`);
      }
      lines.push("");
    }
    if (item.must_not.length) lines.push("Must not:", "", ...item.must_not.map((rule) => `- ${rule}`), "");
    if (item.sources.length) {
      lines.push("Sources:", "", ...item.sources.map((source) => `- ${source.kind === "document" ? source.url : `${source.table} \`${source.id}\``}`), "");
    }
    lines.push(`Provenance: ${item.provenance}`, "");
  }
  fs.writeFileSync(path.join(ROOT, "evals", "cases.md"), lines.join("\n"));
  console.log(`Wrote evals/cases.md (${cases.length} cases).`);
}

function newRunDir(note: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  // Cut at a word boundary so the name does not end mid-word or on a hyphen.
  const words = note.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = "";
  for (const word of words) {
    if (slug && slug.length + word.length + 1 > 40) break;
    slug = slug ? `${slug}-${word}` : word.slice(0, 40);
  }
  return path.join(RUNS_DIR, slug ? `${stamp}-${slug}` : stamp);
}

function resolveRun(target: string): string {
  const dir = fs.existsSync(path.join(RUNS_DIR, target)) ? path.join(RUNS_DIR, target) : path.resolve(target);
  if (!fs.existsSync(path.join(dir, "run.json"))) fail(`no run at ${target}`);
  return dir;
}

function gitState() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  // evals/ changes on every run, so only the rest of the tree counts as dirty.
  const dirty = git("status", "--porcelain", "--", ".", ":!evals/runs", ":!evals/results.md").length > 0;
  return { commit: git("rev-parse", "--short", "HEAD"), dirty };
}

function apiSha(): string {
  const dir = path.join(ROOT, "api");
  const hash = crypto.createHash("sha256");
  for (const name of fs.readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) {
    hash.update(name).update("\0").update(fs.readFileSync(path.join(dir, name))).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

// The corpus the answers were drawn from. Chunking or embedding changes show
// up here as a different passage count or model.
function corpusState(): RunInfo["corpus"] {
  const file = process.env.DATABASE_PATH
    ? path.resolve(ROOT, process.env.DATABASE_PATH)
    : path.join(ROOT, "data", "papertrail.sqlite");
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { documents: count("documents"), passages: count("passages") };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function sha(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 12);
}

function positiveInt(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive whole number`);
  return number;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
