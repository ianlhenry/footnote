import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { citationsFrom } from "./agent.ts";
import type { ToolResult } from "./fec.ts";

const passage: ToolResult = {
  title: "Pew report (Pew Research Center, published 2026-04-26)",
  name: "Pew report",
  label: "Pew Research Center · topline · published 2026-04-26",
  source: "https://example.test/pew",
  blocks: [
    {
      text: "34% approve.",
      ref: { kind: "passage", passage_id: 7, document_url: "https://example.test/pew" },
    },
    {
      text: "Survey details: 5,103 adults.",
      ref: { kind: "passage", passage_id: 7, document_url: "https://example.test/pew" },
    },
  ],
};

const candidate: ToolResult = {
  title: "ARENHOLZ, ASHLEY HINSON, House IA-02 (H6IA01174)",
  source: "https://www.fec.gov/data/candidate/H6IA01174/",
  blocks: [
    {
      text: "FEC candidate record.",
      ref: { kind: "fec", table: "fec_candidate", id: "H6IA01174" },
    },
    {
      text: "2026-cycle totals.",
      ref: { kind: "fec", table: "fec_candidate_summary", id: "H6IA01174" },
    },
  ],
};

// A search-result citation pointing at one block of one result.
// searchResultIndex: which result in the list shown to the model.
// startBlockIndex: which text block of that result.
// citedText: the quote Claude attached.
// Returns the location citation with the other fields filled in.
function location(
  searchResultIndex: number,
  startBlockIndex: number,
  citedText: string,
): Anthropic.CitationsSearchResultLocation {
  return {
    type: "search_result_location",
    cited_text: citedText,
    search_result_index: searchResultIndex,
    start_block_index: startBlockIndex,
    end_block_index: startBlockIndex + 1,
    source: "https://example.test",
    title: null,
  };
}

test("a citation lands on the result and block it names", () => {
  const citations = citationsFrom(
    [
      {
        type: "text",
        text: "  Ashley Hinson raised the most. ",
        citations: [location(1, 1, "2026-cycle totals.")],
      },
    ],
    [passage, candidate],
  );

  assert.deepEqual(citations, [
    {
      claim: "Ashley Hinson raised the most.",
      source: { kind: "fec", table: "fec_candidate_summary", id: "H6IA01174" },
      title: "ARENHOLZ, ASHLEY HINSON, House IA-02 (H6IA01174)",
      label: "FEC candidate summary · H6IA01174",
      quote: "2026-cycle totals.",
    },
  ]);
});

test("a passage citation keeps the result's own title and label", () => {
  const citations = citationsFrom(
    [
      {
        type: "text",
        text: "Approval is 34%.",
        citations: [location(0, 0, "34% approve.")],
      },
    ],
    [passage],
  );

  assert.equal(citations[0]?.title, "Pew report");
  assert.equal(citations[0]?.label, "Pew Research Center · topline · published 2026-04-26");
  assert.deepEqual(citations[0]?.source, {
    kind: "passage",
    passage_id: 7,
    document_url: "https://example.test/pew",
  });
});

test("other citation kinds and indexes past the end are left out", () => {
  const citations = citationsFrom(
    [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "search_candidates",
        input: { name: "Hinson" },
        caller: { type: "direct" },
      },
      {
        type: "text",
        text: "See the report.",
        citations: [
          {
            type: "char_location",
            cited_text: "34%",
            document_index: 0,
            document_title: null,
            start_char_index: 0,
            end_char_index: 3,
            file_id: null,
          },
          location(0, 9, "missing block"),
          location(4, 0, "missing result"),
          location(0, 1, "Survey details: 5,103 adults."),
        ],
      },
    ],
    [passage],
  );

  assert.deepEqual(
    citations.map((citation) => citation.quote),
    ["Survey details: 5,103 adults."],
  );
});
