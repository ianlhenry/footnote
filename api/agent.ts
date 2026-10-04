import Anthropic from "@anthropic-ai/sdk";

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

export async function answer(question: string): Promise<string> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
  });
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
}
