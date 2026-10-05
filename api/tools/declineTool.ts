import type Anthropic from "@anthropic-ai/sdk";
import { DECLINE_REASONS, type DeclineReason } from "../contract";

export const DECLINE_TOOL: Anthropic.Tool = {
  name: "decline",
  description:
    "Record that you are not answering the question. Call it together with your explanation, only when you can answer no part of what was asked. reason: not_loaded when the data the question needs is not in the search results or FEC tools, out_of_scope when the request is not about polls or campaign finance, opinion when it asks for advice, a recommendation, or a prediction.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", enum: [...DECLINE_REASONS] } },
    required: ["reason"],
    additionalProperties: false,
  },
};

export function tryGetDeclineReason(response: Anthropic.Messages.Message): DeclineReason | null {
  const declineToolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === "decline",
  );

  if (declineToolUse) {
    const declineToolUseInput = declineToolUse.input as { reason?: string };
    return DECLINE_REASONS.find((known) => known === declineToolUseInput.reason) ?? "not_loaded";
  }

  return null;
}
