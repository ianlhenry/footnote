// Must match the model and width the ingest stored in passage_embeddings
// (server/ingest/corpus.py). A different model's query vectors would land in
// a different space and return unrelated passages.
const EMBEDDING_MODEL = "voyage-4";
const EMBEDDING_DIMENSION = 1024;
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export class MissingVoyageKeyError extends Error {
  /**
   * Creates the error raised when a search runs with no Voyage key. Sets the message to say
   * VOYAGE_API_KEY is not set.
   */
  constructor() {
    super("VOYAGE_API_KEY is not set");
  }
}

// Raised when Voyage answers with an HTTP error or an embedding of the wrong length.
export class VoyageError extends Error {}

export interface Passage {
  passage_id: number;
  distance: number;
  text: string;
  document_url: string;
  title: string;
  source: string;
  // The publisher's kind of document, such as "state release" or "short read".
  doc_type: string | null;
  published_on: string | null;
  // One line per survey the page reports on: field dates, sample, margin.
  surveys: string[];
}

/**
 * Finds the passages closest in meaning to a question.
 *
 * @param question - The user's question. It is embedded with Voyage before the search.
 * @param k - How many passages to return.
 * @returns Those passages, closest first, with their text and document details.
 * @throws {MissingVoyageKeyError} If VOYAGE_API_KEY is unset.
 * @throws {VoyageError} If the embedding request fails or the vector has the wrong length.
 */
export async function searchPassages(question: string, k: number): Promise<Passage[]> {
  void question;
  void k;
  void EMBEDDING_MODEL;
  void EMBEDDING_DIMENSION;
  void VOYAGE_URL;

  throw new Error("not implemented");
}
