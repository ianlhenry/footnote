import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StreamEvent } from "../../api/contract.ts";
import { AnswerView, StreamingText, type AnswerDetails } from "./Answer.tsx";

type Message =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      details?: AnswerDetails;
      seconds?: number;
      notes?: string[];
      error?: boolean;
    };

// What the agent has said so far for the question in progress.
interface Pending {
  status: string;
  // Text of the turn being written.
  draft: string;
  // Text from turns that ended in tool calls.
  notes: string[];
}

const STARTING: Pending = { status: "Searching Pew and Marist reports", draft: "", notes: [] };

// Yield each server-sent event's data, parsed, as it arrives. EventSource
// cannot POST, so the stream is read from fetch.
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    // stream: true keeps a character split across chunks intact.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield JSON.parse(data) as StreamEvent;
    }
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const sending = pending !== null;
  const list = useRef<HTMLOListElement>(null);
  const latestAnswer = useRef<HTMLLIElement>(null);

  // While the agent works, show the question and the spinner at the bottom.
  useEffect(() => {
    if (sending) list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [sending]);

  // When an answer arrives, bring its first line to the top instead of
  // jumping to its end, so it can be read from the start.
  useEffect(() => {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || !list.current || !latestAnswer.current) return;
    // .messages is position: relative, so offsetTop is measured from the list.
    list.current.scrollTo({ top: latestAnswer.current.offsetTop, behavior: "smooth" });
  }, [messages]);

  function fail(message: string) {
    setMessages((current) => [...current, { id: `error-${Date.now()}`, role: "assistant", content: message, error: true }]);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;

    const started = performance.now();
    // Show the question right away, while the agent works.
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: text }]);
    setPending(STARTING);
    setContent("");
    let notes: string[] = [];
    let draft = "";
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.detail ? String(data.detail) : `Request failed (${response.status})`);
      }
      let finished = false;
      for await (const update of readEvents(response.body)) {
        if (update.type === "status") {
          setPending((current) => current && { ...current, status: update.message });
        } else if (update.type === "text") {
          draft += update.text;
          setPending((current) => current && { ...current, draft });
        } else if (update.type === "turn_end") {
          // A turn that ends in tool calls wrote a note, not the answer.
          if (update.tool_use) {
            if (draft.trim()) notes = [...notes, draft.trim()];
            draft = "";
            setPending((current) => current && { ...current, draft, notes });
          }
        } else if (update.type === "error") {
          throw new Error(update.detail);
        } else if (update.type === "done") {
          finished = true;
          const { text: answer, ...details } = update.answer;
          setMessages((current) => [
            ...current,
            {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: answer,
              details,
              notes,
              seconds: (performance.now() - started) / 1000,
            },
          ]);
        }
      }
      if (!finished) throw new Error("The answer was cut off before it finished.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Papertrail</h1>
      </header>
      <ol className="messages" ref={list}>
        {messages.map((message, index) => (
          <li
            key={message.id}
            ref={index === messages.length - 1 ? latestAnswer : undefined}
            className={`message ${message.role}${message.role === "assistant" && message.error ? " error" : ""}`}>
            <span className="role">{message.role}</span>
            {message.role === "assistant" && message.details ? (
              <AnswerView
                id={message.id}
                text={message.content}
                details={message.details}
                seconds={message.seconds}
                notes={message.notes}
              />
            ) : (
              <p>{message.content}</p>
            )}
          </li>
        ))}
        {pending && (
          <li className="message assistant pending">
            <span className="role">assistant</span>
            <p className="thinking" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              {pending.status}…
            </p>
            {pending.draft && <StreamingText text={pending.draft} />}
          </li>
        )}
      </ol>
      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="message">
          Message
        </label>
        <input
          id="message"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Ask about Pew or Marist survey findings, or a campaign's FEC filings"
          autoComplete="off"
        />
        <button type="submit" disabled={sending || !content.trim()}>
          {sending ? "Working…" : "Send"}
        </button>
      </form>
    </main>
  );
}
