// The shape of one answer from /api/chat. The UI reads the text; the eval in
// evals/ reads the rest. Fields the agent cannot fill yet are empty lists.

// Where a claim or a retrieved item came from: one passage of a Pew or Marist report,
// or one FEC record identified by its table and primary id (CAND_ID, CMTE_ID,
// LINKAGE_ID, or TRAN_ID for independent expenditures).
export type SourceRef =
  | { kind: "passage"; passage_id: number; document_url: string }
  | { kind: "fec"; table: string; id: string };

// answered: the reply answers the question from the sources.
// refused: it declines, because the data is not loaded or the request is out
// of scope. A refusal may still point to related data that is loaded.
export type AnswerStatus = "answered" | "refused";

// Why an answer was refused. not_loaded: the data the question needs is not
// in Footnote. out_of_scope: the request is not about polls or FEC data.
// opinion: it asks for advice, a recommendation, or a prediction.
export const DECLINE_REASONS = ["not_loaded", "out_of_scope", "opinion"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];
export const DECLINE_TEXT: Record<DeclineReason, string> = {
  not_loaded: "Footnote does not have the data this question needs.",
  out_of_scope: "That is outside what Footnote covers: polls and FEC campaign finance records.",
  opinion:
    "Footnote reports what polls and FEC records show, but does not give advice or predictions.",
};
export interface Citation {
  // The sentence or figure in the answer that this source supports.
  claim: string;
  source: SourceRef;
  // The source's display name, such as a report title or an FEC record.
  title: string;
  // What kind of source it is, such as "Marist Poll · state release" or
  // "FEC candidate summary · S6IA00314".
  label: string;
  // The text of the source that supports the claim, copied exactly.
  quote: string;
}

export interface CitableResult {
  title: string; // Claude's title
  name?: string; // Document's own title
  label?: string; // Document's description
  source: string;
  blocks: ResultBlock[];
}

export interface ResultBlock {
  text: string;
  ref: SourceRef;
}

export interface RetrievedItem {
  source: SourceRef;
  text: string;
}

export function labelFor(ref: SourceRef): string {
  if (ref.kind === "passage") {
    return "Survey report";
  }
  return `FEC ${ref.table.replace(/^fec_/, "").replaceAll("_", " ")} · ${ref.id}`;
}

export interface ToolCall {
  name: string;
  input: unknown;
  output: unknown;
}

export interface AnswerUsage {
  model: string;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // Dollars at list price (api/util/pricing.ts), or null for an unpriced model.
  cost_usd: number | null;
}

export interface Answer {
  text: string;
  status: AnswerStatus;
  // Set when status is refused, null otherwise.
  decline_reason: DeclineReason | null;
  citations: Citation[];
  retrieved: RetrievedItem[];
  tool_calls: ToolCall[];
  // One entry per Claude call made while answering.
  usage: AnswerUsage[];
}
