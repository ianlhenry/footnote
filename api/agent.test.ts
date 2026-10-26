import assert from "node:assert/strict";
import { test } from "node:test";
import { actionForStopReason, UnexpectedStopError } from "./agent.ts";

test("a normal end keeps the reply, and a tool call runs the tools", () => {
  assert.equal(actionForStopReason("end_turn"), "finish");
  assert.equal(actionForStopReason("stop_sequence"), "finish");
  assert.equal(actionForStopReason("tool_use"), "tools");
});

test("an unexpected stop reason throws and names the reason", () => {
  const reasons = ["max_tokens", "pause_turn", "refusal", "model_context_window_exceeded"] as const;
  for (const reason of reasons) {
    assert.throws(() => actionForStopReason(reason), UnexpectedStopError);
    assert.throws(() => actionForStopReason(reason), new RegExp(reason));
  }
});
