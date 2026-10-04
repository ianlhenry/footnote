import Anthropic from "@anthropic-ai/sdk";
import type { Answer, AnswerUsage, Citation, RetrievedItem } from "./contract.ts";
import { type Passage, searchPassages } from "./retrieval.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1024;
// Passages retrieved per question.
const TOP_K = 8;

const SYSTEM_PROMPT = `You are a research assistant for polling and campaign finance data.
Answer questions about polls and FEC records plainly and briefly.
Answer only from the search results provided with the question. If they do not contain what the question needs, say so.`;

export class MissingKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
  }
}

let client: Anthropic | undefined;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new MissingKeyError();
  client ??= new Anthropic({ apiKey });
  return client;
}

function usageOf(response: Anthropic.Message): AnswerUsage {
  return {
    model: response.model,
    stop_reason: response.stop_reason,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  };
}

// The passage, then the surveys its page reports on, as separate blocks so a
// citation of a sample size or margin points at the survey line alone.
function blocksOf(passage: Passage): string[] {
  const blocks = [passage.text];
  if (passage.surveys.length) blocks.push(`Survey details: ${passage.surveys.join(". ")}.`);
  return blocks;
}

function searchResult(passage: Passage): Anthropic.SearchResultBlockParam {
  const pollster = passage.source === "pew" ? "Pew Research Center" : passage.source === "marist" ? "Marist Poll" : passage.source;
  return {
    type: "search_result",
    source: passage.document_url,
    title: `${passage.title} (${pollster}${passage.published_on ? `, published ${passage.published_on}` : ""})`,
    content: blocksOf(passage).map((text) => ({ type: "text", text })),
    citations: { enabled: true },
  };
}

export async function answer(question: string): Promise<Answer> {
  const passages = await searchPassages(question, TOP_K);
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [...passages.map(searchResult), { type: "text", text: question }],
      },
    ],
  });

  // With citations on, the reply comes back as several text blocks that
  // together make one answer, each cited block carrying its sources.
  const citations: Citation[] = [];
  let text = "";
  for (const block of response.content) {
    if (block.type !== "text") continue;
    text += block.text;
    for (const citation of block.citations ?? []) {
      if (citation.type !== "search_result_location") continue;
      const passage = passages[citation.search_result_index];
      if (!passage) continue;
      citations.push({
        claim: block.text.trim(),
        source: { kind: "passage", passage_id: passage.passage_id, document_url: passage.document_url },
        quote: citation.cited_text,
      });
    }
  }

  const retrieved: RetrievedItem[] = passages.map((passage) => ({
    source: { kind: "passage", passage_id: passage.passage_id, document_url: passage.document_url },
    // Distance is smaller for closer passages; flip it so a higher score is better.
    score: 1 - passage.distance,
    text: blocksOf(passage).join("\n\n"),
  }));

  // Nothing decides to refuse yet, so every reply counts as answered.
  return {
    text: text.trim(),
    status: "answered",
    citations,
    retrieved,
    tool_calls: [],
    usage: [usageOf(response)],
  };
}
