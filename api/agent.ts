import Anthropic from "@anthropic-ai/sdk";
import type { Answer, AnswerUsage } from "./contract.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a research assistant for polling and campaign finance data.
Answer questions about polls and FEC records plainly and briefly.
You do not have access to any sources yet, so say so when a question needs data you cannot check.`;

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

export async function answer(question: string): Promise<Answer> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
  });
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  // No retrieval, tools, or citations yet, and nothing decides to refuse, so
  // every reply counts as answered.
  return {
    text,
    status: "answered",
    citations: [],
    retrieved: [],
    tool_calls: [],
    usage: [usageOf(response)],
  };
}
