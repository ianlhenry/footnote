import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { answer, MissingKeyError, UnexpectedStopError } from "./agent.ts";
import { connect } from "./db.ts";
import { MissingVoyageKeyError, VoyageError } from "./util/embeddings.ts";

const envFile = new URL("../.env", import.meta.url);
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

let nextId = 1;

/**
 * Takes the next message id for a chat response, then advances the counter.
 *
 * @returns That id. The first call returns 1.
 */
function takeId(): number {
  const id = nextId;
  nextId += 1;
  return id;
}

const app = new Hono();

app.all("/api/chat", async (c) => {
  if (c.req.method !== "POST") {
    return c.json({ detail: "Method not allowed" }, 405);
  }

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ detail: "content is required" }, 400);
  }

  const content =
    typeof parsed === "object" &&
    parsed !== null &&
    "content" in parsed &&
    typeof parsed.content === "string"
      ? parsed.content.trim()
      : "";

  if (!content) {
    return c.json({ detail: "content is required" }, 400);
  }

  const { text, ...details } = await answer(content);

  return c.json({
    messages: [
      { id: takeId(), role: "user", content },
      { id: takeId(), role: "assistant", content: text, ...details },
    ],
  });
});

app.notFound((c) => c.json({ detail: "Not found" }, 404));

app.onError((error, c) => {
  console.error(error);

  if (error instanceof MissingKeyError || error instanceof MissingVoyageKeyError) {
    return c.json({ detail: error.message }, 503);
  }
  if (error instanceof VoyageError) {
    return c.json({ detail: "Search request failed" }, 502);
  }
  if (error instanceof UnexpectedStopError) {
    return c.json({ detail: error.message }, 502);
  }
  if (error instanceof Anthropic.APIError) {
    return c.json({ detail: "Model request failed" }, 502);
  }
  return c.json({ detail: "Internal server error" }, 500);
});

connect().close();

serve(
  {
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 8000,
  },
  () => {
    console.log("API listening on http://127.0.0.1:8000");
  },
);
