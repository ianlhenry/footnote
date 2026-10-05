// We must match the model and dimension used during ingestion; see server/ingest/corpus.py.
// Otherwise, we won't pull relevant passages at retrieval time.
const EMBEDDING_MODEL = "voyage-4";
const EMBEDDING_DIMENSION = 1024;
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MAX_RETRIES = 2;

// Raised when Voyage answers with an HTTP error or an embedding of the wrong length.
export class VoyageError extends Error {}

export class MissingVoyageKeyError extends Error {
  /**
   * Creates the error raised when a search runs with no Voyage key. Sets the message to say
   * VOYAGE_API_KEY is not set.
   */
  constructor() {
    super("VOYAGE_API_KEY is not set");
  }
}

type VoyageEmbeddingResponseData = { embedding: number[] };
type VoyageEmbeddingResponse = {
  data: VoyageEmbeddingResponseData[];
};

/**
 * Gets the embedding
 *
 * @param question - The user's question. It is embedded with Voyage before the search..
 * @returns Those passages, closest first, with their text and document details.
 * @throws {MissingVoyageKeyError} If VOYAGE_API_KEY is unset.
 * @throws {VoyageError} If the embedding request fails or the vector has the wrong length.
 */
export async function getEmbedding(inputStr: string): Promise<Float32Array> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingVoyageKeyError();
  }

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [inputStr],
        model: EMBEDDING_MODEL,
        input_type: "query",
        output_dimension: EMBEDDING_DIMENSION,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    // Retry for certain status codes, up to the max attempts, using an exponential back-off.
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs = 1000 * 2 ** attempt;

      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });

      continue;
    }

    if (!response.ok) {
      throw new VoyageError(
        `Voyage HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const responseJson = (await response.json()) as VoyageEmbeddingResponse;

    const embeddingMaybe = responseJson.data[0]?.embedding;
    if (!embeddingMaybe || embeddingMaybe.length !== EMBEDDING_DIMENSION) {
      throw new VoyageError(
        `Voyage returned ${embeddingMaybe?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSION}`,
      );
    }

    return Float32Array.from(embeddingMaybe);
  }
}
