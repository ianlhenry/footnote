import Anthropic from "@anthropic-ai/sdk";
import type { Answer } from "./contract.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1024;
// Passages retrieved per question.
const TOP_K = 8;
// Claude calls per question. The last one gets no tools, so it has to answer.
const MAX_TURNS = 6;

const SYSTEM_PROMPT = `You are a research assistant for polling and campaign finance data.
Answer questions about polls and FEC records plainly and briefly.
Answer only from the search results provided with the question and from the FEC tools. Use the FEC tools for questions about campaign money. If neither contains what the question needs, say so.
If you cannot answer any part of the question, explain briefly and call the decline tool in the same reply. If you can answer part of it, answer that part and do not call decline.
A poll's stated margin of error applies to each number separately, so a lead is clearly outside it only when the gap is about twice that margin.`;

// Tools and the system prompt are the same on every call, for every
// question, and come first in the request. A cache breakpoint at the end of
// the system prompt lets each call within five minutes of the last read that
// prefix at a tenth of the input price. The passages after it change with
// every question, so they are not cached.
const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

export class MissingKeyError extends Error {
  /**
   * Creates the error raised when a question is asked with no Anthropic key. Sets the message to
   * say ANTHROPIC_API_KEY is not set.
   */
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
  }
}

let client: Anthropic | undefined;

/**
 * Returns the shared Anthropic client, creating it from the API key on first use.
 *
 * @returns The shared client.
 * @throws {MissingKeyError} If ANTHROPIC_API_KEY is unset or blank.
 */
function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingKeyError();
  }

  client ??= new Anthropic({ apiKey });
  return client;
}

/**
 * Answers a question from the closest survey passages and any FEC tools Claude calls.
 *
 * @param question - What the user asked. It is embedded for the passage search and sent to Claude.
 * @returns The reply, whether it was answered or refused, citations, retrieved records, tool calls,
 * and token usage for each Claude call.
 * @throws {Error} If the model returns no reply.
 */
export async function answer(question: string): Promise<Answer> {
  void question;
  void MODEL;
  void MAX_TOKENS;
  void TOP_K;
  void MAX_TURNS;
  void SYSTEM;
  void getClient;

  throw new Error("not implemented");
}
