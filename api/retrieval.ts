import type { CitableResult } from "./contract";
import { readOnlyDatabase } from "./db";
import { getEmbedding } from "./util/embeddings";

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

type RelatedPassageQueryResult = { passage_id: number; distance: number }[];
type PassageDetailQueryResult = {
  id: number;
  text: string;
  document_id: number;
  url: string;
  title: string;
  source: string;
  doc_type: string | null;
  published_on: string | null;
};
type SurveyQueryResult = {
  document_id: number;
  geography: string | null;
  field_start: string;
  field_end: string;
  sample_size: number | null;
  population: string | null;
  margin_of_error: number | null;
};

const POLLSTERS: Record<string, string> = {
  pew: "Pew Research Center",
  marist: "Marist Poll",
};

function getQueryQuestionMarks<T>(list: T[]) {
  return list.map(() => "?").join(", ");
}

/**
 * Finds the passages closest in meaning to a question.
 *
 * @param question - The user's question. It is embedded with Voyage before the search.
 * @param numPassages - How many passages to return.
 * @returns Those passages, closest first, with their text and document details.
 * @throws {MissingVoyageKeyError} If VOYAGE_API_KEY is unset.
 * @throws {VoyageError} If the embedding request fails or the vector has the wrong length.
 */
export async function searchPassages(
  question: string,
  numPassages: number,
): Promise<CitableResult[]> {
  if (!question?.trim()) {
    return [];
  }

  // First, get the embedding for the question, so that we can use it to find related passages.
  const embeddingForQuestion = await getEmbedding(question);

  // Now, query for the related passages in the database.
  const dbConn = readOnlyDatabase();
  const embeddingBytes = new Uint8Array(embeddingForQuestion.buffer);
  const relevantPassageQuery = dbConn
    .prepare(
      `SELECT passage_id, distance FROM passage_embeddings
       WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(embeddingBytes, numPassages) as RelatedPassageQueryResult;

  if (!relevantPassageQuery.length) {
    return [];
  }

  const relevantPassageIds = relevantPassageQuery.map(
    (relevantPassage) => relevantPassage.passage_id,
  );

  // Next, query the details for those relevant passages.
  const passageResults = dbConn
    .prepare(
      `SELECT passages.id, passages.text, passages.document_id,
              documents.url, documents.title, documents.source, documents.doc_type, documents.published_on
       FROM passages JOIN documents ON documents.id = passages.document_id
       WHERE passages.id IN (${getQueryQuestionMarks(relevantPassageIds)})`,
    )
    .all(...relevantPassageIds) as PassageDetailQueryResult[];

  // We need to maintain the same order as in the original relevantPassageQuery, so some shenanigans are necessary here.
  const passageById = new Map(passageResults.map((row) => [row.id, row]));
  const orderedPassageResults = relevantPassageQuery.flatMap((hit) => {
    const row = passageById.get(hit.passage_id);
    if (!row) {
      return [];
    }
    return [row];
  });

  // If no results, don't bother continuing.
  if (!orderedPassageResults.length) {
    return [];
  }

  // We also want any survey details related to the documents these passages came from.
  const documentIds = passageResults.map((passage) => passage.document_id);
  const surveyResults = dbConn
    .prepare(
      `SELECT document_surveys.document_id, surveys.geography, surveys.field_start, surveys.field_end,
              surveys.sample_size, surveys.population, surveys.margin_of_error
       FROM document_surveys JOIN surveys ON surveys.id = document_surveys.survey_id
       WHERE document_surveys.document_id IN (${getQueryQuestionMarks(documentIds)})
       ORDER BY surveys.field_end`,
    )
    .all(...documentIds) as SurveyQueryResult[];

  // Consolidate the survey results into a single line each, and output that in a
  // map; we end up with a map of document_id => array of strings, one per survey associated with the document.
  const surveyLines = surveyResults.reduce((linesByDocument, surveyResult) => {
    const newLineForSurvey = [
      `Fielded ${surveyResult.field_start} to ${surveyResult.field_end}`,
      surveyResult.sample_size !== null
        ? `${surveyResult.sample_size.toLocaleString("en-US")} ${surveyResult.population ?? "respondents"}`
        : "",
      surveyResult.geography ? `geography ${surveyResult.geography}` : "",
      surveyResult.margin_of_error !== null
        ? `margin of error ±${surveyResult.margin_of_error} points`
        : "",
    ]
      .filter((part) => part !== "")
      .join("; ");

    const linesForDocument = linesByDocument.get(surveyResult.document_id) ?? [];
    linesForDocument.push(newLineForSurvey);
    linesByDocument.set(surveyResult.document_id, linesForDocument);

    return linesByDocument;
  }, new Map<number, string[]>());

  // Generate the final output:
  return orderedPassageResults.map((passageResult) => {
    const ref = {
      kind: "passage" as const,
      passage_id: passageResult.id,
      document_url: passageResult.url,
    };
    const surveys = surveyLines.get(passageResult.document_id) ?? [];
    const blocks = [{ text: passageResult.text, ref }];
    if (surveys.length) {
      blocks.push({ text: `Survey details: ${surveys.join(". ")}.`, ref });
    }
    const published = passageResult.published_on ? `published ${passageResult.published_on}` : null;

    const pollster = POLLSTERS[passageResult.source] ?? passageResult.source;
    return {
      title: `${passageResult.title} (${pollster}${published ? `, ${published}` : ""})`,
      name: passageResult.title,
      label: [pollster, passageResult.doc_type, published].filter(Boolean).join(" · "),
      source: passageResult.url,
      blocks,
    };
  });
}
