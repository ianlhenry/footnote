import type { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import type { SourceRef } from "./contract.ts";

// FEC lookups Claude can call. Each matching record comes back as one
// citable result whose text blocks each come from one table row, so a
// citation names the exact record it relies on.

export interface ResultBlock {
  text: string;
  ref: SourceRef;
}

export interface ToolResult {
  // What Claude sees as the result's title.
  title: string;
  // For display: the document's own title and a short description of the
  // source. FEC results leave these out and are labeled per record.
  name?: string;
  label?: string;
  // A link to the record on fec.gov.
  source: string;
  blocks: ResultBlock[];
}

const OFFICES: Record<string, string> = { H: "House", S: "Senate", P: "President" };
const STATUS: Record<string, string> = {
  C: "statutory candidate",
  F: "future candidate",
  N: "not yet a candidate",
  P: "prior-cycle candidate",
};
const ICI: Record<string, string> = { I: "incumbent", C: "challenger", O: "open seat" };
const MONEY_FIELDS = {
  receipts: "TTL_RECEIPTS",
  disbursements: "TTL_DISB",
  cash_on_hand: "COH_COP",
  individual_contributions: "TTL_INDIV_CONTRIB",
} as const;

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
 * @param conn - The database holding the FEC tables.
 * @param name - Which tool: search_candidates, rank_candidates, or search_committees.
 * @param input - The arguments Claude supplied for that tool.
 * @returns The matching records as citable results.
 * @throws {Error} If the tool name is unknown or the arguments are missing or invalid.
 */
export function runFecTool(
  conn: DatabaseSync,
  name: string,
  input: Record<string, unknown>,
): ToolResult[] {
  switch (name) {
    case "search_candidates":
      return searchCandidates(conn, input);
    case "rank_candidates":
      return rankCandidates(conn, input);
    case "search_committees":
      return searchCommittees(conn, input);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

interface CandidateRow {
  CAND_ID: string;
  CAND_NAME: string;
  CAND_PTY_AFFILIATION: string | null;
  CAND_ELECTION_YR: number | null;
  CAND_OFFICE_ST: string | null;
  CAND_OFFICE: string | null;
  CAND_OFFICE_DISTRICT: string | null;
  CAND_ICI: string | null;
  CAND_STATUS: string | null;
  CAND_PCC: string | null;
  TTL_RECEIPTS: number | null;
  TTL_DISB: number | null;
  COH_COP: number | null;
  TTL_INDIV_CONTRIB: number | null;
  DEBTS_OWED_BY: number | null;
  CVG_END_DT: string | null;
  HAS_SUMMARY: number;
  CMTE_NM: string | null;
}

const CANDIDATE_SELECT = `
  SELECT c.CAND_ID, c.CAND_NAME, c.CAND_PTY_AFFILIATION, c.CAND_ELECTION_YR, c.CAND_OFFICE_ST,
         c.CAND_OFFICE, c.CAND_OFFICE_DISTRICT, c.CAND_ICI, c.CAND_STATUS, c.CAND_PCC,
         s.TTL_RECEIPTS, s.TTL_DISB, s.COH_COP, s.TTL_INDIV_CONTRIB, s.DEBTS_OWED_BY, s.CVG_END_DT,
         s.CAND_ID IS NOT NULL AS HAS_SUMMARY, m.CMTE_NM
  FROM fec_candidate c
  LEFT JOIN fec_candidate_summary s ON s.CAND_ID = c.CAND_ID
  LEFT JOIN fec_committee m ON m.CMTE_ID = c.CAND_PCC`;

/**
 * Adds candidate filters for state, office, and party when the tool input includes them. Writes the
 * new clauses and values onto where and params.
 *
 * @param input - The tool arguments, read for state, office, and party.
 * @param where - SQL conditions being built; matching clauses are appended here.
 * @param params - Bound values for those clauses, appended in the same order.
 */
function filters(input: Record<string, unknown>, where: string[], params: string[]) {
  const state = text(input.state)?.toUpperCase();
  const office = text(input.office)?.toUpperCase();
  const party = text(input.party)?.toUpperCase();

  if (state) {
    where.push("c.CAND_OFFICE_ST = ?");
    params.push(state);
  }
  if (office) {
    where.push("c.CAND_OFFICE = ?");
    params.push(office);
  }
  if (party) {
    where.push("c.CAND_PTY_AFFILIATION = ?");
    params.push(party);
  }
}

/**
 * Builds the WHERE clause for a candidate search.
 *
 * @param input - Optional name words, plus state, office, and party.
 * @returns The conditions, their bound values, and the name words. Each name word is a LIKE
 * substring here; nameMatches applies the stricter check later.
 * @throws {Error} If no name, state, office, or party was given.
 */
export function candidateWhere(input: Record<string, unknown>): {
  where: string[];
  params: string[];
  words: string[];
} {
  const words = nameWords(text(input.name));
  const where: string[] = [];
  const params: string[] = [];
  filters(input, where, params);
  for (const word of words) {
    where.push("c.CAND_NAME LIKE ?");
    params.push(`%${word}%`);
  }
  if (!where.length) {
    throw new Error("give at least a name, state, office, or party");
  }

  return { where, params, words };
}

/**
 * Finds federal candidates whose filed name and filters match the tool input.
 *
 * @param conn - The database holding candidates and their 2026-cycle summaries.
 * @param input - Optional name words, plus state, office, and party.
 * @returns Up to ten candidates, highest receipts first, each as a citable result.
 * @throws {Error} If no name, state, office, or party was given.
 */
function searchCandidates(conn: DatabaseSync, input: Record<string, unknown>): ToolResult[] {
  const { where, params, words } = candidateWhere(input);
  // SQL narrows by substring; nameMatches then requires each word to start a
  // word of the name, so "Hinson" does not match HUTCHINSON.
  const rows = conn
    .prepare(
      `${CANDIDATE_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.TTL_RECEIPTS DESC NULLS LAST LIMIT 200`,
    )
    .all(...params) as unknown as CandidateRow[];

  return rows
    .filter((row) => nameMatches(row.CAND_NAME, words))
    .slice(0, 10)
    .map(candidateResult);
}

/**
 * Builds the query for a candidate ranking.
 *
 * @param input - Which total to rank by, plus optional office, state, party, and how many.
 * @returns The summary column, the row limit, and the WHERE clause with its bound values.
 * @throws {Error} If by is missing or is not a known total.
 */
export function rankQuery(input: Record<string, unknown>): {
  column: string;
  limit: number;
  where: string[];
  params: string[];
} {
  const by = text(input.by) as keyof typeof MONEY_FIELDS | undefined;
  if (!by || !(by in MONEY_FIELDS)) {
    throw new Error(`by must be one of ${Object.keys(MONEY_FIELDS).join(", ")}`);
  }

  const column = MONEY_FIELDS[by];
  const limit = Math.min(20, Math.max(1, Number(input.limit ?? 5) || 5));
  const where = [`s.${column} IS NOT NULL`];
  const params: string[] = [];
  filters(input, where, params);
  return { column, limit, where, params };
}

/**
 * Lists the candidates with the largest 2026-cycle total of one kind.
 *
 * @param conn - The database holding the candidate summary.
 * @param input - Which total to rank by, plus optional office, state, party, and how many.
 * @returns That many candidates, largest total first, at most twenty.
 * @throws {Error} If by is missing or is not a known total.
 */
function rankCandidates(conn: DatabaseSync, input: Record<string, unknown>): ToolResult[] {
  const { column, limit, where, params } = rankQuery(input);

  const rows = conn
    .prepare(
      `${CANDIDATE_SELECT} WHERE ${where.join(" AND ")} ORDER BY s.${column} DESC LIMIT ${limit}`,
    )
    .all(...params) as unknown as CandidateRow[];
  return rows.map(candidateResult);
}

/**
 * Turns one candidate row into the text blocks Claude can cite.
 *
 * @param row - A candidate joined to its 2026-cycle summary and principal committee.
 * @returns The candidate record, its money totals when the summary has them, and its committee.
 */
function candidateResult(row: CandidateRow): ToolResult {
  const office = OFFICES[row.CAND_OFFICE ?? ""] ?? row.CAND_OFFICE ?? "unknown office";
  const seat =
    row.CAND_OFFICE === "H" && row.CAND_OFFICE_DISTRICT
      ? `${row.CAND_OFFICE_ST}-${row.CAND_OFFICE_DISTRICT}`
      : row.CAND_OFFICE_ST;
  const details = [
    `${row.CAND_NAME} (candidate ID ${row.CAND_ID})`,
    `party ${row.CAND_PTY_AFFILIATION ?? "unknown"}`,
    `${office}${seat ? `, ${seat}` : ""}`,
    row.CAND_ELECTION_YR ? `election year ${row.CAND_ELECTION_YR}` : null,
    row.CAND_ICI ? (ICI[row.CAND_ICI] ?? row.CAND_ICI) : null,
    row.CAND_STATUS ? (STATUS[row.CAND_STATUS] ?? row.CAND_STATUS) : null,
  ].filter(Boolean);
  const blocks: ResultBlock[] = [
    {
      text: `FEC candidate record: ${details.join("; ")}.`,
      ref: { kind: "fec", table: "fec_candidate", id: row.CAND_ID },
    },
  ];

  if (row.HAS_SUMMARY) {
    const money = [
      `total receipts ${usd(row.TTL_RECEIPTS)}`,
      `total disbursements ${usd(row.TTL_DISB)}`,
      `cash on hand ${usd(row.COH_COP)}`,
      `individual contributions ${usd(row.TTL_INDIV_CONTRIB)}`,
      `debts owed ${usd(row.DEBTS_OWED_BY)}`,
    ];
    blocks.push({
      text: `2026-cycle totals for ${row.CAND_NAME}, through ${row.CVG_END_DT ?? "an unknown date"}: ${money.join("; ")}.`,
      ref: { kind: "fec", table: "fec_candidate_summary", id: row.CAND_ID },
    });
  } else {
    blocks.push({
      text: `The FEC 2026-cycle summary file has no totals for ${row.CAND_NAME} (${row.CAND_ID}).`,
      ref: { kind: "fec", table: "fec_candidate", id: row.CAND_ID },
    });
  }
  if (row.CAND_PCC) {
    blocks.push({
      text: `Principal campaign committee of ${row.CAND_NAME}: ${row.CMTE_NM ?? "name not on file"} (committee ID ${row.CAND_PCC}).`,
      ref: { kind: "fec", table: "fec_committee", id: row.CAND_PCC },
    });
  }

  return {
    title: `${row.CAND_NAME}, ${office}${seat ? ` ${seat}` : ""} (${row.CAND_ID})`,
    source: `https://www.fec.gov/data/candidate/${row.CAND_ID}/`,
    blocks,
  };
}

interface CommitteeRow {
  CMTE_ID: string;
  CMTE_NM: string;
  CMTE_TP: string | null;
  CMTE_DSGN: string | null;
  CMTE_PTY_AFFILIATION: string | null;
  CONNECTED_ORG_NM: string | null;
  CAND_ID: string | null;
  HAS_SUMMARY: number;
  TTL_RECEIPTS: number | null;
  TTL_DISB: number | null;
  COH_COP: number | null;
  IND_EXP: number | null;
  CVG_END_DT: string | null;
}

// Committee type codes from the FEC committee master file description.
const COMMITTEE_TYPES: Record<string, string> = {
  H: "House campaign committee",
  S: "Senate campaign committee",
  P: "presidential campaign committee",
  N: "PAC (nonqualified)",
  Q: "PAC (qualified)",
  O: "super PAC (independent expenditure-only)",
  V: "hybrid PAC (with noncontribution account), nonqualified",
  W: "hybrid PAC (with noncontribution account), qualified",
  X: "party committee (nonqualified)",
  Y: "party committee (qualified)",
  I: "independent expenditor (person or group)",
  U: "single-candidate independent expenditure committee",
  D: "delegate committee",
  E: "electioneering communication filer",
  C: "communication cost filer",
};

/**
 * Builds the WHERE clause for a committee search.
 *
 * @param input - A committee name, a committee ID, or both.
 * @returns The conditions, their bound values, and the name words. The ID is uppercased, and each
 * name word is a LIKE substring.
 * @throws {Error} If neither a name nor an ID was given.
 */
export function committeeWhere(input: Record<string, unknown>): {
  where: string[];
  params: string[];
  words: string[];
} {
  const id = text(input.committee_id)?.toUpperCase();
  const words = nameWords(text(input.name));
  const where: string[] = [];
  const params: string[] = [];
  if (id) {
    where.push("m.CMTE_ID = ?");
    params.push(id);
  }
  for (const word of words) {
    where.push("m.CMTE_NM LIKE ?");
    params.push(`%${word}%`);
  }
  if (!where.length) {
    throw new Error("give a committee name or ID");
  }

  return { where, params, words };
}

/**
 * Finds committees by filed name or committee ID.
 *
 * @param conn - The database holding committees and their 2026-cycle PAC summaries.
 * @param input - A committee name, a committee ID, or both.
 * @returns Up to ten committees, highest receipts first, each as a citable result.
 * @throws {Error} If neither a name nor an ID was given.
 */
function searchCommittees(conn: DatabaseSync, input: Record<string, unknown>): ToolResult[] {
  const { where, params, words } = committeeWhere(input);

  const rows = conn
    .prepare(
      `SELECT m.CMTE_ID, m.CMTE_NM, m.CMTE_TP, m.CMTE_DSGN, m.CMTE_PTY_AFFILIATION, m.CONNECTED_ORG_NM, m.CAND_ID,
              p.CMTE_ID IS NOT NULL AS HAS_SUMMARY, p.TTL_RECEIPTS, p.TTL_DISB, p.COH_COP, p.IND_EXP, p.CVG_END_DT
       FROM fec_committee m LEFT JOIN fec_pac_summary p ON p.CMTE_ID = m.CMTE_ID
       WHERE ${where.join(" AND ")} ORDER BY p.TTL_RECEIPTS DESC NULLS LAST LIMIT 200`,
    )
    .all(...params) as unknown as CommitteeRow[];

  return rows
    .filter((row) => nameMatches(row.CMTE_NM, words))
    .slice(0, 10)
    .map((row) => {
      const kind = COMMITTEE_TYPES[row.CMTE_TP ?? ""] ?? `type ${row.CMTE_TP ?? "unknown"}`;
      const details = [
        `${row.CMTE_NM} (committee ID ${row.CMTE_ID})`,
        kind,
        row.CMTE_PTY_AFFILIATION ? `party ${row.CMTE_PTY_AFFILIATION}` : null,
        row.CONNECTED_ORG_NM ? `connected organization ${row.CONNECTED_ORG_NM}` : null,
        row.CAND_ID ? `candidate ID ${row.CAND_ID}` : null,
      ].filter(Boolean);
      const blocks: ResultBlock[] = [
        {
          text: `FEC committee record: ${details.join("; ")}.`,
          ref: { kind: "fec", table: "fec_committee", id: row.CMTE_ID },
        },
      ];
      if (row.HAS_SUMMARY) {
        const money = [
          `total receipts ${usd(row.TTL_RECEIPTS)}`,
          `total disbursements ${usd(row.TTL_DISB)}`,
          `cash on hand ${usd(row.COH_COP)}`,
          `independent expenditures ${usd(row.IND_EXP)}`,
        ];
        blocks.push({
          text: `2026-cycle totals for ${row.CMTE_NM}, through ${row.CVG_END_DT ?? "an unknown date"}: ${money.join("; ")}.`,
          ref: { kind: "fec", table: "fec_pac_summary", id: row.CMTE_ID },
        });
      }
      return {
        title: `${row.CMTE_NM} (${row.CMTE_ID})`,
        source: `https://www.fec.gov/data/committee/${row.CMTE_ID}/`,
        blocks,
      };
    });
}

/**
 * Reads an optional tool argument as trimmed text.
 *
 * @param value - One field from the tool input.
 * @returns The trimmed string, or undefined when the field is missing or blank.
 */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Splits a name into the words used to match a filed FEC name.
 *
 * @param name - The name the tool was given, or undefined when the tool omitted it.
 * @returns The uppercased words longer than one character.
 */
function nameWords(name: string | undefined): string[] {
  return (name ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9']+/)
    .filter((word) => word.length > 1);
}

/**
 * Each query word must start a word of the filed name.
 *
 * @param filed - The name as the FEC recorded it.
 * @param words - The query words, already split and uppercased.
 * @returns Whether every query word starts some word of the filed name.
 */
export function nameMatches(filed: string, words: string[]): boolean {
  const parts = filed.toUpperCase().split(/[^A-Z0-9']+/);
  return words.every((word) => parts.some((part) => part.startsWith(word)));
}

/**
 * Formats a dollar amount for the text shown to Claude.
 *
 * @param value - A money total from an FEC summary, or null when the file left it blank.
 * @returns A USD string, or "not reported" when the total is missing.
 */
function usd(value: number | null): string {
  return value === null
    ? "not reported"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
