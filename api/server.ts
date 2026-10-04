import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { answer, MissingKeyError } from "./agent.ts";
import type { StreamEvent } from "./contract.ts";
import { connect } from "./db.ts";
import { MissingVoyageKeyError, VoyageError } from "./retrieval.ts";

const envFile = new URL("../.env", import.meta.url);
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let nextId = 1;

function takeId(): number {
  const id = nextId;
  nextId += 1;
  return id;
}

// The question from a request body, or an error response to send instead.
async function readContent(c: Context): Promise<string | Response> {
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
    typeof parsed === "object" && parsed !== null && "content" in parsed && typeof parsed.content === "string"
      ? parsed.content.trim()
      : "";
  return content || c.json({ detail: "content is required" }, 400);
}

// The status and message a failure is reported with, on either endpoint.
function describeError(error: unknown): { status: ContentfulStatusCode; detail: string } {
  if (error instanceof MissingKeyError || error instanceof MissingVoyageKeyError) {
    return { status: 503, detail: error.message };
  }
  if (error instanceof VoyageError) return { status: 502, detail: "Search request failed" };
  if (error instanceof Anthropic.APIError) return { status: 502, detail: "Model request failed" };
  return { status: 500, detail: "Internal server error" };
}

const app = new Hono();

app.all("/api/chat", async (c) => {
  const content = await readContent(c);
  if (content instanceof Response) return content;

  const { text, ...details } = await answer(content);

  return c.json({
    messages: [
      { id: takeId(), role: "user", content },
      { id: takeId(), role: "assistant", content: text, ...details },
    ],
  });
});

// The same agent as /api/chat, reporting progress and the reply as it is
// written. The last event is done, with the full answer, or error.
app.all("/api/chat/stream", async (c) => {
  const content = await readContent(c);
  if (content instanceof Response) return content;

  return streamSSE(c, async (stream) => {
    // Events arrive from synchronous callbacks; chaining keeps them in order.
    let pending = Promise.resolve();
    const send = (event: StreamEvent) => {
      pending = pending.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
    };
    try {
      const result = await answer(content, send);
      send({ type: "done", answer: result });
    } catch (error) {
      console.error(error);
      send({ type: "error", detail: describeError(error).detail });
    }
    await pending;
  });
});

app.notFound((c) => c.json({ detail: "Not found" }, 404));

app.onError((error, c) => {
  console.error(error);
  const { status, detail } = describeError(error);
  return c.json({ detail }, status);
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
