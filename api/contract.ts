// The shape of one answer from /api/chat. The UI reads the text; the eval in
// evals/ reads the rest. Fields the agent cannot fill yet are empty lists.

// Where a claim or a retrieved item came from: one passage of a poll article,
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
// in Paper Trail. out_of_scope: the request is not about polls or FEC data.
// opinion: it asks for advice, a recommendation, or a prediction.
export type DeclineReason = "not_loaded" | "out_of_scope" | "opinion";

export interface Citation {
  // The sentence or figure in the answer that this source supports.
  claim: string;
  source: SourceRef;
  // The text of the source that supports the claim, copied exactly.
  quote: string;
}

export interface RetrievedItem {
  source: SourceRef;
  // Similarity or rank score, when the retriever produces one.
  score: number | null;
  text: string;
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
