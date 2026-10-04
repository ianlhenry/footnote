import fs from "node:fs";
import { z } from "zod";

// One expected figure in an answer. pct and num compare absolutely, usd and
// count relatively, so "$68.6 million" matches 68,560,930.42.
export const ExpectedValue = z.object({
  n: z.number(),
  kind: z.enum(["pct", "usd", "count", "num"]),
});

export const Fact = z.object({
  text: z.string().min(1),
  values: z.array(ExpectedValue).optional(),
});

// Labels name documents by URL, not passage id, because passage ids change
// whenever a document is embedded again.
export const ExpectedSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), url: z.string().url() }),
  z.object({ kind: z.literal("fec"), table: z.string().min(1), id: z.string().min(1) }),
]);

export const Case = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase words joined by hyphens"),
  question: z.string().min(1),
  // tags[0] is the category the summary groups by.
  tags: z.array(z.string()).min(1),
  expect: z.enum(["answer", "refuse"]),
  facts: z.array(Fact),
  // Things a correct answer must not do, such as naming the wrong leader.
  must_not: z.array(z.string()),
  sources: z.array(ExpectedSource),
  // Only verified cases count toward headline scores.
  verified: z.boolean(),
  provenance: z.string().min(1),
});

export type ExpectedValue = z.infer<typeof ExpectedValue>;
export type Fact = z.infer<typeof Fact>;
export type ExpectedSource = z.infer<typeof ExpectedSource>;
export type Case = z.infer<typeof Case>;

export const CASES_PATH = new URL("./cases.json", import.meta.url);

// Read the eval cases and reject a file the schema or the extra rules do not accept.
// path: the cases file to read. Defaults to cases.json beside this module.
// Returns the cases. Throws when the JSON, the schema, or checkCases fails.
export function loadCases(path: URL | string = CASES_PATH): Case[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  const cases = z.array(Case).parse(raw);
  const problems = checkCases(cases);
  if (problems.length) {
    throw new Error(`cases.json has problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  return cases;
}

// Rules the schema cannot express: unique ids, at least one fact and one source on every answer case, and no facts on a refusal.
// cases: the cases already parsed from JSON.
// Returns one message per broken rule.
export function checkCases(cases: Case[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) {
      problems.push(`${item.id}: duplicate id`);
    }
    seen.add(item.id);

    if (item.expect === "answer" && item.facts.length === 0) {
      problems.push(`${item.id}: an answer case needs at least one fact`);
    }
    if (item.expect === "refuse" && item.facts.length > 0) {
      problems.push(`${item.id}: a refusal case should not list facts; use must_not`);
    }
    if (item.expect === "answer" && item.sources.length === 0) {
      problems.push(`${item.id}: an answer case needs at least one expected source`);
    }
  }

  return problems;
}
