import Anthropic from "@anthropic-ai/sdk";
import {
  type Answer,
  type AnswerUsage,
  type CitableResult,
  type Citation,
  DECLINE_TEXT,
  labelFor,
  type RetrievedItem,
  type ToolCall,
} from "./contract.ts";
import { searchPassages } from "./retrieval.ts";
import { DECLINE_TOOL, tryGetDeclineReason } from "./tools/declineTool.ts";
import { FEC_TOOLS, runFecTool } from "./tools/fecTool.ts";
import { getAnswerUsage } from "./util/pricing.ts";

const ANTHROPIC_API_CONFIG = {
  MODEL: "claude-sonnet-5-5",
  MAX_TOKENS: 1024,
  MAX_TURNS_PER_QUESTION: 6,
  NUM_PASSAGES_TO_SEND: 8,
};

const TOOL_CHOICE_NONE_DISABLE_TOOLS = { tool_choice: { type: "none" as const } };

const SYSTEM_PROMPT = `You are a research assistant for polling and campaign finance data.
Answer questions about polls and FEC records plainly and briefly.
Answer only from the search results provided with the question and from the FEC tools. Use the FEC tools for questions about campaign money. If neither contains what the question needs, say so.
If you cannot answer any part of the question, explain briefly and call the decline tool in the same reply. If you can answer part of it, answer that part and do not call decline.
A poll's stated margin of error applies to each number separately, so a lead is clearly outside it only when the gap is about twice that margin.`;

// Tools and the system prompt are the same on every call, for every question. Since these are first in the request, a cache breakpoint at the end of
// the system prompt allows each call within 5 minutes to read this for free. The data after it change with every question, so it's not cached.
const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

const TOOL_DEFINITIONS: Anthropic.Tool[] = [DECLINE_TOOL, ...FEC_TOOLS];

type ToolCallback = (name: string, input: Record<string, any>) => CitableResult[] | null;

const TOOL_CALLBACKS: ToolCallback[] = [runFecTool];

export class MissingKeyError extends Error {
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

// Anthropic types this as unknown since it could be anything; wrangle it to a Record.
export function toolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function toSearchResult(result: CitableResult): Anthropic.SearchResultBlockParam {
  return {
    type: "search_result",
    source: result.source,
    title: result.title,
    content: result.blocks.map((block) => ({ type: "text", text: block.text })),
    citations: { enabled: true },
  };
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
  const anthropicClient = getClient();

  const citableSources = await searchPassages(question, ANTHROPIC_API_CONFIG.NUM_PASSAGES_TO_SEND);

  const searchResults = citableSources.map((passage) => toSearchResult(passage));
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [...searchResults, { type: "text", text: question }],
    },
  ];

  var declineReason = null;
  var apiResponse: Anthropic.Message | null = null;
  var toolCalls: ToolCall[] = [];
  var apiUsage: AnswerUsage[] = [];

  for (let turn = 1; turn <= ANTHROPIC_API_CONFIG.MAX_TURNS_PER_QUESTION; turn++) {
    let apiRequest = {
      model: ANTHROPIC_API_CONFIG.MODEL,
      max_tokens: ANTHROPIC_API_CONFIG.MAX_TOKENS,
      system: SYSTEM,
      tools: TOOL_DEFINITIONS,
      messages: messages,
    };

    if (turn === ANTHROPIC_API_CONFIG.MAX_TURNS_PER_QUESTION) {
      // The API requires us to keep passing the tool list, which is ideal for caching too.
      // But by adding TOOL_CHOICE_NONE_DISABLE_TOOLS, we disable tool usage and force the model to give us a response.
      apiRequest = {
        ...apiRequest,
        ...TOOL_CHOICE_NONE_DISABLE_TOOLS,
      };
    }

    // Make the API request.
    apiResponse = await anthropicClient.messages.create(apiRequest);

    apiUsage.push(getAnswerUsage(apiResponse));

    // First check for a decline, and exit the loop.
    declineReason = tryGetDeclineReason(apiResponse);
    if (declineReason) {
      // If the model declined to answer, exit immediately.
      toolCalls.push({ name: "decline", input: { reason: declineReason }, output: null });

      break;
    }

    // Any other reason than tool_use means we can exit the loop.
    if (apiResponse.stop_reason !== "tool_use") {
      break;
    }

    messages.push({ role: "assistant", content: apiResponse.content });

    // Process tool usage.
    const toolResults = apiResponse.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((toolBlock) => {
        try {
          let toolResults: CitableResult[] | null = null;
          for (const toolCallback of TOOL_CALLBACKS) {
            toolResults = toolCallback(toolBlock.name, toolInput(toolBlock.input));
            if (toolResults !== null) {
              break;
            }
          }

          if (toolResults === null) {
            throw new Error("Unknown tool");
          }

          citableSources.push(...toolResults);
          toolCalls.push({
            name: toolBlock.name,
            input: toolBlock.input,
            output: toolResults.map((result) => result.title),
          });
          return {
            type: "tool_result" as const,
            tool_use_id: toolBlock.id,
            content: toolResults.length
              ? toolResults.map((result) => toSearchResult(result))
              : [{ type: "text" as const, text: "No matching records." }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          toolCalls.push({
            name: toolBlock.name,
            input: toolBlock.input,
            output: { error: errorMessage },
          });

          return {
            type: "tool_result" as const,
            tool_use_id: toolBlock.id,
            content: errorMessage,
            is_error: true,
          };
        }
      });

    messages.push({ role: "user", content: toolResults });
  }

  const responseTextBlocks = apiResponse?.content.filter((block) => block.type === "text");

  const citations: Citation[] = [];
  for (const textBlock of responseTextBlocks || []) {
    for (const searchCitation of textBlock.citations?.filter(
      (citation) => citation.type === "search_result_location",
    ) || []) {
      const citedResult = citableSources[searchCitation.search_result_index];
      const citedResultBlock = citedResult?.blocks[searchCitation.start_block_index];
      if (citedResultBlock) {
        citations.push({
          claim: textBlock.text.trim(),
          source: citedResultBlock.ref,
          title: citedResult.name ?? citedResult.title,
          label: citedResult.label ?? labelFor(citedResultBlock.ref),
          quote: searchCitation.cited_text,
        });
      }
    }
  }

  const retrievedItems: RetrievedItem[] = [];
  citableSources.forEach((citableSource) => {
    citableSource.blocks.forEach((block) => {
      const same = retrievedItems.find(
        (item) => JSON.stringify(item.source) === JSON.stringify(block.ref),
      );
      if (same) {
        same.text += `\n\n${block.text}`;
      } else {
        retrievedItems.push({ source: block.ref, text: block.text });
      }
    });
  });

  var resultString =
    responseTextBlocks
      ?.map((block) => block.text)
      .join("")
      .trim() ?? "";
  if (!resultString && declineReason) {
    resultString = DECLINE_TEXT[declineReason];
  }

  return {
    text: resultString,
    status: declineReason ? "refused" : "answered",
    decline_reason: declineReason,
    citations: citations,
    retrieved: retrievedItems,
    tool_calls: toolCalls,
    usage: apiUsage,
  };
}
