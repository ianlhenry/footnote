import fs from "node:fs";
import { callCost } from "../api/pricing.ts";
import path from "node:path";
import { type AnswerRow, type GradeRow, METRICS, type MetricId } from "./grade.ts";
import type { JudgeConfig } from "./judge.ts";

export interface RunInfo {
  id: string;
  note: string;
  started_at: string;
  finished_at: string | null;
  url: string;
  reps: number;
  case_ids: string[];
  cases_sha: string;
  git: { commit: string; dirty: boolean };
  // A digest of api/*.ts, so a prompt or model change shows up even before
  // it is committed.
  api_sha: string;
  // The corpus the answers were drawn from. A chunking change shows up as a
  // different passage count.
  corpus: { documents: number; passages: number } | null;
  // Runs graded before the facts and citation prompts were versioned
  // separately carry a single prompt_version.
  judge: (JudgeConfig & { prompt_versions?: Record<string, number>; prompt_version?: number }) | null;
  agent_models: string[];
  answers: number;
  errors: number;
}

// Prices live in api/pricing.ts. A model missing there makes a cost NaN
// rather than wrong.
export function agentCost(row: AnswerRow): number {
  return row.answer.usage.reduce((sum, usage) => sum + (callCost(usage) ?? NaN), 0);
}

// includeCached: count verdicts read from the cache at what they cost when
// first made, which is what a fresh run would pay.
export function judgeCost(row: GradeRow, includeCached = false): number {
  return row.judge_usage
    .filter((usage) => includeCached || !usage.cached)
    .reduce((sum, usage) => sum + (callCost(usage) ?? NaN), 0);
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

interface Stat {
  mean: number;
  n: number;
  // Half-width of a normal-approximation 95% interval.
  margin: number;
}

function stat(rows: GradeRow[], metric: MetricId): Stat | null {
  const values = rows.map((row) => row.metrics[metric]).filter((value): value is number => value !== null);
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1) : 0;
  return { mean, n: values.length, margin: 1.96 * Math.sqrt(variance / values.length) };
}

function cell(value: Stat | null, withMargin = true): string {
  if (!value) return "—";
  const mean = `${Math.round(value.mean * 100)}%`;
  return withMargin && value.n > 1 ? `${mean} ±${Math.round(value.margin * 100)} (${value.n})` : `${mean} (${value.n})`;
}

function promptVersions(judge: NonNullable<RunInfo["judge"]>): string {
  if (judge.prompt_versions) {
    return Object.entries(judge.prompt_versions).map(([kind, version]) => `${kind} prompt v${version}`).join(", ");
  }
  return `prompt v${judge.prompt_version}`;
}

function money(value: number): string {
  return Number.isNaN(value) ? "unknown" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

interface LoadedRun {
  dir: string;
  info: RunInfo;
  answers: AnswerRow[];
  grades: GradeRow[];
  errors: { case_id: string; rep: number; failure_class: string; error: string }[];
}

function loadRun(dir: string): LoadedRun {
  return {
    dir,
    info: JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")),
    answers: readJsonl<AnswerRow>(path.join(dir, "answers.jsonl")),
    grades: readJsonl<GradeRow>(path.join(dir, "grades.jsonl")),
    errors: readJsonl(path.join(dir, "errors.jsonl")),
  };
}

function costs(run: LoadedRun) {
  const agent = run.answers.reduce((sum, row) => sum + agentCost(row), 0);
  const judgeSpent = run.grades.reduce((sum, row) => sum + judgeCost(row), 0);
  const judgeFull = run.grades.reduce((sum, row) => sum + judgeCost(row, true), 0);
  return { agent, judgeSpent, judgeFull };
}

const METRIC_IDS = METRICS.map(([id]) => id);

// One run's scores, its failures, and enough of each failing answer to see
// why, for error analysis.
export function writeReport(dir: string) {
  const run = loadRun(dir);
  const { info, answers, grades, errors } = run;
  const verified = grades.filter((row) => row.verified);
  const { agent, judgeSpent, judgeFull } = costs(run);
  const lines: string[] = [
    `# ${info.id}`,
    "",
    `**Note:** ${info.note || "(none)"}`,
    "",
    `- Commit \`${info.git.commit}\`${info.git.dirty ? " with uncommitted changes" : ""}, api/ digest \`${info.api_sha}\``,
    `- Corpus: ${info.corpus ? `${info.corpus.documents} documents, ${info.corpus.passages} passages` : "not found"}`,
    `- Agent model: ${info.agent_models.join(", ") || "unknown"}`,
    `- Judge: ${info.judge ? `${info.judge.model}, effort ${info.judge.effort}, ${promptVersions(info.judge)}` : "not graded"}`,
    `- ${answers.length} answers from ${info.case_ids.length} cases × ${info.reps} reps, ${errors.length} failed attempts, ${grades.length} graded (${verified.length} on verified cases)`,
    `- Cost: agent ${money(agent)}, judge ${money(judgeSpent)} this grading (${money(judgeFull)} uncached)`,
    "",
    "Scores are the mean over graded answers, with a 95% interval and the count. — means the metric did not apply.",
    "",
    "| metric | verified cases | all cases | what it measures |",
    "| --- | --- | --- | --- |",
    ...METRICS.map(([id, label]) => `| ${id} | ${cell(stat(verified, id))} | ${cell(stat(grades, id))} | ${label} |`),
    "",
    "## By category (all cases)",
    "",
    `| category | n | ${METRIC_IDS.join(" | ")} |`,
    `| --- | --- | ${METRIC_IDS.map(() => "---").join(" | ")} |`,
  ];
  const categories = [...new Set(grades.map((row) => row.category))].sort();
  for (const category of categories) {
    const rows = grades.filter((row) => row.category === category);
    lines.push(`| ${category} | ${rows.length} | ${METRIC_IDS.map((id) => cell(stat(rows, id), false)).join(" | ")} |`);
  }

  lines.push("", "## Cases", "", `| case | rep | expect | verified | ${METRIC_IDS.join(" | ")} |`, `| --- | --- | --- | --- | ${METRIC_IDS.map(() => "---").join(" | ")} |`);
  for (const row of grades) {
    const values = METRIC_IDS.map((id) => (row.metrics[id] === null ? "—" : `${Math.round(row.metrics[id]! * 100)}`));
    lines.push(`| [${row.case_id}](#${row.case_id}-${row.rep}) | ${row.rep} | ${row.expect} | ${row.verified ? "yes" : "no"} | ${values.join(" | ")} |`);
  }

  if (errors.length) {
    lines.push("", "## Failed attempts", "", "These never produced an answer and are not scored.", "");
    for (const error of errors) lines.push(`- ${error.case_id}#${error.rep} (${error.failure_class}): ${error.error}`);
  }

  lines.push("", "## Details", "");
  for (const row of grades) {
    const answer = answers.find((item) => item.case_id === row.case_id && item.rep === row.rep);
    lines.push(`### ${row.case_id}-${row.rep}`, "");
    const problems: string[] = [];
    for (const fact of row.details.facts ?? []) {
      if (fact.verdict !== "supported") problems.push(`Fact ${fact.index} ${fact.verdict}: ${fact.evidence}`);
    }
    for (const rule of row.details.must_not ?? []) {
      if (rule.violated) problems.push(`Broke must_not ${rule.index}: ${rule.evidence}`);
    }
    if (row.metrics.refusal === 0) problems.push(`status was "${answer?.answer.status}" but the case expects to ${row.expect}`);
    if (row.metrics.refusal_text === 0) problems.push(`Judge says the text ${row.details.declines?.value ? "declines" : "answers"}: ${row.details.declines?.evidence}`);
    if (row.details.missing_values?.length) problems.push(`Figures not found in the text: ${row.details.missing_values.join(", ")}`);
    if (row.details.missing_sources?.length) problems.push(`Expected sources not retrieved: ${row.details.missing_sources.join(", ")}`);
    if (row.details.uncovered_numbers?.length) problems.push(`Figures with no citation: ${row.details.uncovered_numbers.join(", ")}`);
    if (row.details.unfaithful_quotes?.length) problems.push(`Citations whose quote is not in the passage: ${row.details.unfaithful_quotes.join(", ")}`);
    for (const citation of row.details.citations ?? []) {
      if (!citation.supports) problems.push(`Citation ${citation.index} unsupported: ${citation.reason}`);
    }
    lines.push(...(problems.length ? problems.map((problem) => `- ${problem}`) : ["No problems found."]), "");
    if (answer) {
      const text = answer.answer.text;
      const ticks = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
      lines.push("<details><summary>Answer</summary>", "", ticks, text, ticks, "", "</details>", "");
    }
  }
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n"));
}

// Every graded run, oldest first, so a change in one number can be read
// against what changed in the note.
export function writeSummary(runsDir: string, out: string) {
  const runs = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter((name) => fs.existsSync(path.join(runsDir, name, "run.json")))
        .sort()
        .map((name) => loadRun(path.join(runsDir, name)))
        .filter((run) => run.grades.length)
    : [];
  const relative = (dir: string) => path.relative(path.dirname(out), path.join(dir, "report.md"));
  const table = (pick: (run: LoadedRun) => GradeRow[]) => [
    `| run | note | commit | n | ${METRIC_IDS.join(" | ")} | cost |`,
    `| --- | --- | --- | --- | ${METRIC_IDS.map(() => "---").join(" | ")} | --- |`,
    ...runs.map((run) => {
      const rows = pick(run);
      // What the run cost when its verdicts were first made, so a free
      // regrade from the cache does not make it look cheaper.
      const { agent, judgeFull } = costs(run);
      const commit = `${run.info.git.commit}${run.info.git.dirty ? "+" : ""}`;
      return `| [${run.info.id}](${relative(run.dir)}) | ${run.info.note.replaceAll("|", "\\|")} | ${commit} | ${rows.length} | ${METRIC_IDS.map((id) => cell(stat(rows, id), false)).join(" | ")} | ${money(agent + judgeFull)} |`;
    }),
  ];
  const lines = [
    "# Eval results",
    "",
    "Generated by `npm run eval -- summary` (and after every graded run). Each row links to that run's report.",
    "A `+` after the commit means the run had uncommitted changes outside `evals/`. Cells are the mean score with the number of graded answers; — means the metric did not apply.",
    "",
    "## Verified cases",
    "",
    "Only cases whose labels a person has checked. Compare runs here.",
    "",
    ...table((run) => run.grades.filter((row) => row.verified)),
    "",
    "## All cases",
    "",
    "Includes cases with unverified labels, so a score here can be wrong because the label is.",
    "",
    ...table((run) => run.grades),
    "",
    "## Metrics",
    "",
    ...METRICS.map(([id, label]) => `- **${id}**: ${label}.`),
    "",
  ];
  fs.writeFileSync(out, lines.join("\n"));
}
