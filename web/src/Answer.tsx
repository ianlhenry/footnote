import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Answer, Citation, DeclineReason, SourceRef, ToolCall } from "../../api/contract.ts";

export type AnswerDetails = Omit<Answer, "text">;

const DECLINE_LABELS: Record<DeclineReason, string> = {
  not_loaded: "Not in Paper Trail",
  out_of_scope: "Out of scope",
  opinion: "Advice or prediction",
};

interface Source {
  number: number;
  key: string;
  ref: SourceRef;
  title: string;
  label: string;
  quotes: string[];
}

function sourceKey(ref: SourceRef): string {
  return ref.kind === "passage" ? `passage:${ref.passage_id}` : `fec:${ref.table}:${ref.id}`;
}

function sourceLink(ref: SourceRef): string {
  if (ref.kind === "passage") {
    return ref.document_url;
  }

  const kind =
    ref.table === "fec_committee" || ref.table === "fec_pac_summary" ? "committee" : "candidate";
  return `https://www.fec.gov/data/${kind}/${ref.id}/`;
}

// Number each distinct source in the order the answer first cites it.
function numberSources(citations: Citation[]): Map<string, Source> {
  const sources = new Map<string, Source>();
  for (const citation of citations) {
    const key = sourceKey(citation.source);
    let source = sources.get(key);
    if (!source) {
      source = {
        number: sources.size + 1,
        key,
        ref: citation.source,
        title: citation.title,
        label: citation.label,
        quotes: [],
      };
      sources.set(key, source);
    }
    if (!source.quotes.includes(citation.quote)) {
      source.quotes.push(citation.quote);
    }
  }

  return sources;
}

// Insert a Markdown link to the source list after each cited claim, so the
// markers survive Markdown rendering, table cells included. Claims are found
// in order, so a repeated phrase is matched at its next occurrence.
function withMarkers(
  id: string,
  text: string,
  citations: Citation[],
  sources: Map<string, Source>,
): string {
  const marks = new Map<number, number[]>();
  let cursor = 0;
  for (const citation of citations) {
    const at = citation.claim ? text.indexOf(citation.claim, cursor) : -1;
    if (at === -1) {
      continue;
    }

    const end = at + citation.claim.length;
    cursor = at;

    const numbers = marks.get(end) ?? [];
    const number = sources.get(sourceKey(citation.source))!.number;
    if (!numbers.includes(number)) {
      numbers.push(number);
    }
    marks.set(end, numbers);
  }

  let marked = "";
  let start = 0;
  for (const end of [...marks.keys()].sort((a, b) => a - b)) {
    const links = marks
      .get(end)!
      .map((number) => `[${number}](#${id}-source-${number})`)
      .join("");
    marked += text.slice(start, end) + links;
    start = end;
  }

  return marked + text.slice(start);
}

// Citation markers are in-page links; any other link the answer contains
// opens in a new tab.
function markdownComponents(id: string): Components {
  return {
    a({ href, children }) {
      if (href?.startsWith(`#${id}-source-`)) {
        return (
          <a className="cite" href={href} aria-label={`Source ${String(children)}`}>
            {children}
          </a>
        );
      }

      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
}

export function AnswerView({
  id,
  text,
  details,
  seconds,
}: {
  id: string;
  text: string;
  details: AnswerDetails;
  seconds?: number;
}) {
  const sources = numberSources(details.citations);

  return (
    <div className="answer">
      {details.status === "refused" && (
        <span className="badge declined">
          Declined{details.decline_reason ? ` · ${DECLINE_LABELS[details.decline_reason]}` : ""}
        </span>
      )}
      <div className="answer-text">
        {/* react-markdown does not render raw HTML, so answer text cannot inject markup. */}
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents(id)}>
          {withMarkers(id, text, details.citations, sources)}
        </Markdown>
      </div>
      {sources.size > 0 && (
        <section className="sources" aria-label="Sources">
          <h2>Sources</h2>
          <ol>
            {[...sources.values()].map((source) => (
              <li key={source.key} id={`${id}-source-${source.number}`}>
                <span className="source-number" aria-hidden="true">
                  {source.number}
                </span>
                <div className="source-body">
                  <a href={sourceLink(source.ref)} target="_blank" rel="noreferrer">
                    {source.title || sourceLink(source.ref)}
                  </a>
                  <span className="source-kind">{source.label || fallbackLabel(source.ref)}</span>
                  {source.quotes.map((quote) => (
                    <Quote key={quote} text={quote} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Trace details={details} seconds={seconds} />
    </div>
  );
}

// Long quotes show their first few lines until expanded, so the source list
// stays one scrolling page instead of a stack of small scrollboxes.
const LONG_QUOTE = 280;

function Quote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_QUOTE;

  return (
    <blockquote className={long && !open ? "clamped" : undefined}>
      <span className="quote-text">{text}</span>
      {long && (
        <button
          type="button"
          className="quote-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </blockquote>
  );
}

// For answers saved before citations carried a label.
function fallbackLabel(ref: SourceRef): string {
  return ref.kind === "passage"
    ? "Pew or Marist report"
    : `FEC ${ref.table.replace(/^fec_/, "").replaceAll("_", " ")} · ${ref.id}`;
}

// Three decimals below a dime, so a typical answer reads $0.031, not $0.03.
function dollars(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

function describeOutput(call: ToolCall): string {
  if (call.name === "decline") {
    return "";
  }

  if (Array.isArray(call.output)) {
    if (!call.output.length) {
      return "no records";
    }

    return `${call.output.length} record${call.output.length === 1 ? "" : "s"}: ${call.output.join("; ")}`;
  }

  if (call.output && typeof call.output === "object" && "error" in call.output) {
    return `error: ${String((call.output as { error: unknown }).error)}`;
  }

  return "";
}

// What the agent looked at and did, in order: the passages retrieved for the
// question, then each tool call Claude made.
function Trace({ details, seconds }: { details: AnswerDetails; seconds?: number }) {
  const passages = details.retrieved.filter((item) => item.source.kind === "passage");
  const inputTokens = details.usage.reduce(
    (sum, call) =>
      sum + call.input_tokens + call.cache_read_input_tokens + call.cache_creation_input_tokens,
    0,
  );
  const outputTokens = details.usage.reduce((sum, call) => sum + call.output_tokens, 0);
  // Null when any call's model has no price, or the answer predates costs.
  const cost = details.usage.every((call) => typeof call.cost_usd === "number")
    ? details.usage.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0)
    : null;
  const summary = [
    `${details.usage.length} Claude call${details.usage.length === 1 ? "" : "s"}`,
    `${details.tool_calls.length} tool call${details.tool_calls.length === 1 ? "" : "s"}`,
    cost !== null ? dollars(cost) : null,
    seconds !== undefined ? `${seconds.toFixed(1)}s` : null,
  ].filter(Boolean);

  return (
    <details className="trace">
      <summary>Trace · {summary.join(" · ")}</summary>
      <ol>
        <li>
          <strong>Searched Pew and Marist reports</strong>, {passages.length} passages
          <ul>
            {passages.map((item) => (
              <li key={sourceKey(item.source)}>
                {item.text.split("\n")[0]}
                {item.score !== null && <span className="score">{item.score.toFixed(2)}</span>}
              </li>
            ))}
          </ul>
        </li>
        {details.tool_calls.map((call, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a finished trace never reorders, and a tool call has no id of its own
          <li key={index}>
            <strong>{call.name === "decline" ? "Declined" : call.name}</strong>
            {` (${describeInput(call.input)})`}
            {describeOutput(call) && <div className="tool-output">{describeOutput(call)}</div>}
          </li>
        ))}
        <li>
          <strong>Answered</strong> with {details.usage[0]?.model ?? "Claude"},{" "}
          {inputTokens.toLocaleString()} tokens in, {outputTokens.toLocaleString()} out
          <div className="tool-output">
            {cost !== null
              ? `Cost ${dollars(cost)} at list price for the Claude calls${details.usage.length > 1 ? ` (${details.usage.map((call) => dollars(call.cost_usd ?? 0)).join(" + ")})` : ""}. The Voyage search embedding is not included; it is a small fraction of a cent.`
              : "Cost unknown: a model in this answer has no price on file."}
          </div>
        </li>
      </ol>
    </details>
  );
}
