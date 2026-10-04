import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { connect } from "./db.ts";

const PLACEHOLDER = "Not wired yet.";
let nextId = 1;

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

  return c.json({
    messages: [
      { id: takeId(), role: "user", content },
      { id: takeId(), role: "assistant", content: PLACEHOLDER },
    ],
  });
});

app.notFound((c) => c.json({ detail: "Not found" }, 404));

app.onError((error, c) => {
  console.error(error);
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
