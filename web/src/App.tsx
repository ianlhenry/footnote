import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnswerView, type AnswerDetails } from "./Answer.tsx";

type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; details?: AnswerDetails; seconds?: number; error?: boolean };

type ChatResponse = {
  messages: ({ id: number; role: "user" | "assistant"; content: string } & Partial<AnswerDetails>)[];
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;

    const started = performance.now();
    // Show the question right away, while the agent works.
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: text }]);
    setSending(true);
    setContent("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.detail ? String(data.detail) : `Request failed (${response.status})`);
      }
      const reply = [...(data as ChatResponse).messages].reverse().find((message) => message.role === "assistant");
      if (!reply) throw new Error("The server sent no answer.");
      const { id, content: answer, status, decline_reason, citations, retrieved, tool_calls, usage } = reply;
      const details =
        status && citations && retrieved && tool_calls && usage
          ? { status, decline_reason: decline_reason ?? null, citations, retrieved, tool_calls, usage }
          : undefined;
      setMessages((current) => [
        ...current,
        { id: `assistant-${id}`, role: "assistant", content: answer, details, seconds: (performance.now() - started) / 1000 },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: error instanceof Error ? error.message : "Something went wrong.",
          error: true,
        },
      ]);
    } finally {
      setSending(false);
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
              <AnswerView id={message.id} text={message.content} details={message.details} seconds={message.seconds} />
            ) : (
              <p>{message.content}</p>
            )}
          </li>
        ))}
        {sending && (
          <li className="message assistant pending" aria-live="polite">
            <span className="role">assistant</span>
            <p className="thinking">
              <span className="spinner" aria-hidden="true" />
              Searching Pew and Marist reports…
            </p>
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
