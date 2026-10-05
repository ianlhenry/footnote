import type { DatabaseSync } from "node:sqlite";
import { readOnlyDatabase } from "./db.ts";

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
  const vector = await embedQuery(question);
  const conn = readOnlyDatabase();
  const hits = conn
    .prepare(
      `SELECT passage_id, distance FROM passage_embeddings
       WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(new Uint8Array(vector.buffer), k) as { passage_id: number; distance: number }[];
  if (!hits.length) {
    return [];
  }

  const marks = hits.map(() => "?").join(", ");
  const rows = conn
    .prepare(
      `SELECT passages.id, passages.text, passages.document_id,
              documents.url, documents.title, documents.source, documents.doc_type, documents.published_on
       FROM passages JOIN documents ON documents.id = passages.document_id
       WHERE passages.id IN (${marks})`,
    )
    .all(...hits.map((hit) => hit.passage_id)) as {
    id: number;
    text: string;
    document_id: number;
    url: string;
    title: string;
    source: string;
    doc_type: string | null;
    published_on: string | null;
  }[];

  const byId = new Map(rows.map((row) => [row.id, row]));
  const surveys = surveyLines(conn, [...new Set(rows.map((row) => row.document_id))]);

  return hits.flatMap((hit) => {
    const row = byId.get(hit.passage_id);
    if (!row) {
      return [];
    }

    return [
      {
        passage_id: row.id,
        distance: hit.distance,
        text: row.text,
        document_url: row.url,
        title: row.title,
        source: row.source,
        doc_type: row.doc_type,
        published_on: row.published_on,
        surveys: surveys.get(row.document_id) ?? [],
      },
    ];
  });
}

/**
 * Loads a one-line description of each survey the given documents report on.
 *
 * @param conn - The database holding surveys and the document-to-survey links.
 * @param documentIds - The documents whose survey lines are needed.
 * @returns Those lines keyed by document id, in field-end order.
 */
function surveyLines(conn: DatabaseSync, documentIds: number[]): Map<number, string[]> {
  const lines = new Map<number, string[]>();
  if (!documentIds.length) {
    return lines;
  }

  const marks = documentIds.map(() => "?").join(", ");
  const rows = conn
    .prepare(
      `SELECT document_surveys.document_id, surveys.geography, surveys.field_start, surveys.field_end,
              surveys.sample_size, surveys.population, surveys.margin_of_error
       FROM document_surveys JOIN surveys ON surveys.id = document_surveys.survey_id
       WHERE document_surveys.document_id IN (${marks})
       ORDER BY surveys.field_end`,
    )
    .all(...documentIds) as {
    document_id: number;
    geography: string | null;
    field_start: string;
    field_end: string;
    sample_size: number | null;
    population: string | null;
    margin_of_error: number | null;
  }[];

  for (const row of rows) {
    const parts = [`Fielded ${row.field_start} to ${row.field_end}`];
    if (row.sample_size !== null) {
      parts.push(`${row.sample_size.toLocaleString("en-US")} ${row.population ?? "respondents"}`);
    }
    if (row.geography) {
      parts.push(`geography ${row.geography}`);
    }
    if (row.margin_of_error !== null) {
      parts.push(`margin of error ±${row.margin_of_error} points`);
    }

    const list = lines.get(row.document_id) ?? [];
    list.push(parts.join("; "));
    lines.set(row.document_id, list);
  }

  return lines;
}

/**
 * Embeds a question with Voyage so it can be matched against stored passages.
 *
 * @param text - The question to embed.
 * @returns The query vector at the same model and width the ingest stored.
 * @throws {MissingVoyageKeyError} If VOYAGE_API_KEY is unset.
 * @throws {VoyageError} If the request fails or the vector has the wrong length.
 */
async function embedQuery(text: string): Promise<Float32Array> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingVoyageKeyError();
  }

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [text],
        model: EMBEDDING_MODEL,
        input_type: "query",
        output_dimension: EMBEDDING_DIMENSION,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * 2 ** attempt * (0.5 + Math.random())),
      );
      continue;
    }
    if (!response.ok) {
      throw new VoyageError(
        `Voyage HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as { data: { embedding: number[] }[] };
    const embedding = payload.data[0]?.embedding;
    if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
      throw new VoyageError(
        `Voyage returned ${embedding?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSION}`,
      );
    }

    return Float32Array.from(embedding);
  }
}
