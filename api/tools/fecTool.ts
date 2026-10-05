import type Anthropic from "@anthropic-ai/sdk";
import type { CitableResult } from "../contract";
import { readOnlyDatabase } from "../db";
import { MONEY_FIELDS, rankCandidates, searchCandidates, searchCommittees } from "../fec";

export const FEC_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_candidates",
    description:
      "Find federal candidates in the FEC's 2025-2026 candidate files by name, state, office, or party, with each one's 2026-cycle money totals (receipts, disbursements, cash on hand, individual contributions) and principal campaign committee. FEC names are LAST, FIRST and may differ from common usage: Ashley Hinson is filed as ARENHOLZ, ASHLEY HINSON and Ken Paxton as PAXTON, WARREN KENNETH JR. Each word you give must start a word of the filed name, so search a distinctive last name, or a first and last name. One person can have several candidate IDs, one per office sought.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Words of the candidate\'s name, e.g. "Talarico" or "Sherrod Brown".',
        },
        state: {
          type: "string",
          description: "Two-letter postal code of the state the office is in.",
        },
        office: {
          type: "string",
          enum: ["H", "S", "P"],
          description: "H House, S Senate, P President.",
        },
        party: { type: "string", description: "Three-letter FEC party code, e.g. DEM or REP." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rank_candidates",
    description:
      "List the candidates with the most money by one 2026-cycle total, optionally within one office, state, or party. Use for questions like who raised the most or who has the most cash on hand.",
    input_schema: {
      type: "object",
      properties: {
        by: {
          type: "string",
          enum: Object.keys(MONEY_FIELDS),
          description: "The total to rank by.",
        },
        office: { type: "string", enum: ["H", "S", "P"] },
        state: { type: "string", description: "Two-letter postal code." },
        party: { type: "string", description: "Three-letter FEC party code." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many to return. Default 5.",
        },
      },
      required: ["by"],
      additionalProperties: false,
    },
  },
  {
    name: "search_committees",
    description:
      "Find FEC committees (campaign committees, PACs, super PACs, party committees) by name or committee ID, with each one's 2026-cycle totals when the FEC summary file has them: receipts, disbursements, cash on hand, and independent expenditures. Individual donors and itemized contributions are not loaded, so this cannot say who gave to a committee.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Words of the committee name. Each must start a word of the filed name.",
        },
        committee_id: { type: "string", description: "A committee ID such as C00916288." },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Runs one FEC tool Claude asked for.
 *
 * @param name - Name of the tool asked for.
 * @param input - The arguments Claude supplied for that tool.
 * @returns The matching records as citable results, possibly empty, or null if no tool matched.
 */
export function runFecTool(name: string, input: Record<string, unknown>): CitableResult[] | null {
  let fecResults: CitableResult[] | null = null;

  switch (name) {
    case "search_candidates":
      fecResults = searchCandidates(readOnlyDatabase(), input);
      break;
    case "rank_candidates":
      fecResults = rankCandidates(readOnlyDatabase(), input);
      break;
    case "search_committees":
      fecResults = searchCommittees(readOnlyDatabase(), input);
      break;
  }

  return fecResults;
}
