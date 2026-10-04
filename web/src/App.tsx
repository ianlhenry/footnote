import { useState, type FormEvent } from "react";

type Message = {
  id: number | string;
  role: "user" | "assistant";
  content: string;
};

type ChatResponse = {
  messages: Message[];
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;

    setSending(true);
    setContent("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = (await response.json()) as ChatResponse;
      setMessages((current) => [...current, ...data.messages]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: "Something went wrong.",
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
      <ol className="messages">
        {messages.map((message) => (
          <li key={message.id} className={`message ${message.role}`}>
            <span className="role">{message.role}</span>
            <p>{message.content}</p>
          </li>
        ))}
      </ol>
      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="message">
          Message
        </label>
        <input
          id="message"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Ask something"
          autoComplete="off"
        />
        <button type="submit" disabled={sending || !content.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
