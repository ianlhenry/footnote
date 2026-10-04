import type { Answer, SourceRef } from "../api/contract.ts";
import type { Case, ExpectedSource } from "./cases.ts";
import type { CitationVerdict, FactsVerdict, Judge, JudgeUsage } from "./judge.ts";
import { findFigures, findNumbers, stated } from "./numbers.ts";

// One answer from /api/chat, as the runner stored it.
export interface AnswerRow {
  case_id: string;
  rep: number;
  question: string;
  answer: Answer;
  latency_s: number;
  retries: number;
}

// Each metric is a score from 0 to 1, or null when it does not apply to the
// case or the agent does not produce that field yet.
export const METRICS = [
  ["facts", "Labeled facts the judge finds in the answer"],
  ["numbers", "Labeled figures found in the answer text, checked in code"],
  ["no_errors", "No fact contradicted and no must_not rule broken"],
  ["refusal", "status field matches whether the case expects a refusal"],
  ["refusal_text", "The judge's reading of whether the text declines matches the label"],
  ["retrieval", "Expected documents or FEC records among the retrieved items"],
  ["citation_coverage", "Figures in the answer that some citation's claim covers"],
  ["quote_fidelity", "Passage citations whose quote appears in the retrieved passage"],
  ["citation_support", "Citations whose quote the judge says supports the claim"],
] as const;
export type MetricId = (typeof METRICS)[number][0];
export type Metrics = Record<MetricId, number | null>;

export interface GradeRow {
  case_id: string;
  rep: number;
  category: string;
  expect: Case["expect"];
  verified: boolean;
  metrics: Metrics;
  details: {
    facts?: FactsVerdict["facts"];
    must_not?: FactsVerdict["must_not"];
    declines?: { value: boolean; evidence: string };
    missing_values?: string[];
    missing_sources?: string[];
    uncovered_numbers?: string[];
    unfaithful_quotes?: number[];
    citations?: CitationVerdict["citations"];
  };
  judge_usage: JudgeUsage[];
}

// Whether any answer in the run has retrieved items or citations. Before the
// agent produces them, those metrics are null for every case instead of 0.
export interface RunFeatures {
  retrieval: boolean;
  citations: boolean;
}

export function runFeatures(rows: AnswerRow[]): RunFeatures {
  return {
    retrieval: rows.some((row) => row.answer.retrieved.length > 0),
    citations: rows.some((row) => row.answer.citations.length > 0),
  };
}

export async function grade(
  item: Case,
  row: AnswerRow,
  features: RunFeatures,
  judge: Judge,
): Promise<GradeRow> {
  const { answer } = row;
  const details: GradeRow["details"] = {};
  const judgeUsage: JudgeUsage[] = [];

  const facts = await judge.facts(item, answer.text);
  judgeUsage.push(facts.usage);
  details.facts = facts.verdict.facts;
  details.must_not = facts.verdict.must_not;
  details.declines = { value: facts.verdict.declines, evidence: facts.verdict.declines_evidence };

  const answerCase = item.expect === "answer";
  const supported = facts.verdict.facts.filter((fact) => fact.verdict === "supported").length;
  const contradicted = facts.verdict.facts.some((fact) => fact.verdict === "contradicted");
  const violated = facts.verdict.must_not.some((rule) => rule.violated);

  const values = item.facts.flatMap((fact) => fact.values ?? []);
  const missingValues = values.filter((value) => !stated(value, answer.text));
  if (missingValues.length) {
    details.missing_values = missingValues.map((value) => `${value.n} (${value.kind})`);
  }

  let retrieval: number | null = null;
  if (answerCase && features.retrieval && item.sources.length) {
    const missing = item.sources.filter(
      (expected) => !answer.retrieved.some((retrieved) => sameSource(expected, retrieved.source)),
    );
    if (missing.length) {
      details.missing_sources = missing.map(describe);
    }
    retrieval = (item.sources.length - missing.length) / item.sources.length;
  }

  let citationCoverage: number | null = null;
  let quoteFidelity: number | null = null;
  let citationSupport: number | null = null;

  if (features.citations && answer.status === "answered") {
    const claims = answer.citations.map((citation) => citation.claim).join("\n");
    const figures = findFigures(answer.text);
    if (figures.length) {
      const uncovered = figures.filter(
        (figure) => !findNumbers(claims).some((claimed) => claimed.value === figure.value),
      );
      if (uncovered.length) {
        details.uncovered_numbers = uncovered.map((figure) => figure.text);
      }
      citationCoverage = (figures.length - uncovered.length) / figures.length;
    }

    const passageCitations = answer.citations
      .map((citation, index) => ({ citation, index }))
      .filter(({ citation }) => citation.source.kind === "passage");

    if (passageCitations.length) {
      const unfaithful = passageCitations.filter(({ citation }) => {
        const source = citation.source as Extract<SourceRef, { kind: "passage" }>;
        const passage = answer.retrieved.find(
          (item) => item.source.kind === "passage" && item.source.passage_id === source.passage_id,
        );
        return !passage || !normalize(passage.text).includes(normalize(citation.quote));
      });
      if (unfaithful.length) {
        details.unfaithful_quotes = unfaithful.map(({ index }) => index);
      }
      quoteFidelity = (passageCitations.length - unfaithful.length) / passageCitations.length;
    }

    if (answer.citations.length) {
      const verdict = await judge.citations(answer.citations);
      judgeUsage.push(verdict.usage);
      details.citations = verdict.verdict.citations;
      citationSupport =
        verdict.verdict.citations.filter((citation) => citation.supports).length /
        answer.citations.length;
    }
  }

  return {
    case_id: item.id,
    rep: row.rep,
    category: item.tags[0],
    expect: item.expect,
    verified: item.verified,
    metrics: {
      facts: answerCase ? supported / item.facts.length : null,
      numbers:
        answerCase && values.length ? (values.length - missingValues.length) / values.length : null,
      no_errors: contradicted || violated ? 0 : 1,
      refusal: Number((answer.status === "refused") === (item.expect === "refuse")),
      refusal_text: Number(facts.verdict.declines === (item.expect === "refuse")),
      retrieval,
      citation_coverage: citationCoverage,
      quote_fidelity: quoteFidelity,
      citation_support: citationSupport,
    },
    details,
    judge_usage: judgeUsage,
  };
}

function sameSource(expected: ExpectedSource, actual: SourceRef): boolean {
  if (expected.kind === "document") {
    return actual.kind === "passage" && trimSlash(actual.document_url) === trimSlash(expected.url);
  }

  return actual.kind === "fec" && actual.table === expected.table && actual.id === expected.id;
}

function describe(source: ExpectedSource): string {
  return source.kind === "document" ? source.url : `${source.table} ${source.id}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Whitespace is dropped entirely: a citation spanning several blocks of one
// search result joins them without a fixed separator.
function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}
