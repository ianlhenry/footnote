import Anthropic from "@anthropic-ai/sdk";
import type { Answer, AnswerUsage, Citation, RetrievedItem, ToolCall } from "./contract.ts";
import { readOnlyDatabase } from "./db.ts";
import { FEC_TOOLS, runFecTool, type ToolResult } from "./fec.ts";
import { type Passage, searchPassages } from "./retrieval.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1024;
// Passages retrieved per question.
const TOP_K = 8;
// Claude calls per question. The last one gets no tools, so it has to answer.
const MAX_TURNS = 6;

const SYSTEM_PROMPT = `You are a research assistant for polling and campaign finance data.
Answer questions about polls and FEC records plainly and briefly.
Answer only from the search results provided with the question and from the FEC tools. Use the FEC tools for questions about campaign money. If neither contains what the question needs, say so.`;

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

const POLLSTERS: Record<string, string> = { pew: "Pew Research Center", marist: "Marist Poll" };

// The passage, then the surveys its page reports on, as separate blocks so a
// citation of a sample size or margin points at the survey line alone.
function passageResult(passage: Passage): ToolResult {
  const ref = { kind: "passage" as const, passage_id: passage.passage_id, document_url: passage.document_url };
  const blocks = [{ text: passage.text, ref }];
  if (passage.surveys.length) blocks.push({ text: `Survey details: ${passage.surveys.join(". ")}.`, ref });
  const pollster = POLLSTERS[passage.source] ?? passage.source;
  return {
    title: `${passage.title} (${pollster}${passage.published_on ? `, published ${passage.published_on}` : ""})`,
    source: passage.document_url,
    blocks,
  };
}

function searchResultBlock(result: ToolResult): Anthropic.SearchResultBlockParam {
  return {
    type: "search_result",
    source: result.source,
    title: result.title,
    content: result.blocks.map((block) => ({ type: "text", text: block.text })),
    citations: { enabled: true },
  };
}

export async function answer(question: string): Promise<Answer> {
  const passages = await searchPassages(question, TOP_K);
  // Every search_result block in the conversation, in the order Claude sees
  // them, since a citation names its result by that position.
  const results: ToolResult[] = passages.map(passageResult);
  const scores = new Map<ToolResult, number>(results.map((result, index) => [result, 1 - passages[index].distance]));
  const toolCalls: ToolCall[] = [];
  const usage: AnswerUsage[] = [];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [...results.map(searchResultBlock), { type: "text", text: question }] },
  ];

  let response: Anthropic.Message | undefined;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const last = turn === MAX_TURNS;
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: FEC_TOOLS,
      // The last turn may not call tools, so it ends with an answer.
      ...(last ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    });
    usage.push(usageOf(response));
    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      try {
        const found = runFecTool(readOnlyDatabase(), block.name, input);
        results.push(...found);
        toolCalls.push({ name: block.name, input, output: found.map((result) => result.title) });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: found.length ? found.map(searchResultBlock) : [{ type: "text", text: "No matching FEC records." }],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolCalls.push({ name: block.name, input, output: { error: message } });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
  if (!response) throw new Error("no response");

  // With citations on, the reply comes back as several text blocks that
  // together make one answer, each cited block carrying its sources.
  const citations: Citation[] = [];
  let text = "";
  for (const block of response.content) {
    if (block.type !== "text") continue;
    text += block.text;
    for (const citation of block.citations ?? []) {
      if (citation.type !== "search_result_location") continue;
      const cited = results[citation.search_result_index]?.blocks[citation.start_block_index];
      if (!cited) continue;
      citations.push({ claim: block.text.trim(), source: cited.ref, quote: citation.cited_text });
    }
  }

  return {
    text: text.trim(),
    // Nothing decides to refuse yet, so every reply counts as answered.
    status: "answered",
    citations,
    retrieved: results.flatMap((result) => retrievedItems(result, scores.get(result) ?? null)),
    tool_calls: toolCalls,
    usage,
  };
}

// One item per record a result drew on. A passage's text and survey line
// are one item; an FEC result has one per table row.
function retrievedItems(result: ToolResult, score: number | null): RetrievedItem[] {
  const items: RetrievedItem[] = [];
  for (const block of result.blocks) {
    const same = items.find((item) => JSON.stringify(item.source) === JSON.stringify(block.ref));
    if (same) same.text += `\n\n${block.text}`;
    else items.push({ source: block.ref, score, text: block.text });
  }
  return items;
}
