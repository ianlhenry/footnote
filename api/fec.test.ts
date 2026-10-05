import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateWhere, committeeWhere, nameMatches, rankQuery } from "./fec.ts";

test("a candidate search filters by name, state, office, and party", () => {
  const query = candidateWhere({
    name: "A Hinson",
    state: "ia",
    office: "h",
    party: "rep",
  });

  assert.deepEqual(query.where, [
    "c.CAND_OFFICE_ST = ?",
    "c.CAND_OFFICE = ?",
    "c.CAND_PTY_AFFILIATION = ?",
    "c.CAND_NAME LIKE ?",
  ]);
  assert.deepEqual(query.params, ["IA", "H", "REP", "%HINSON%"]);
  assert.deepEqual(query.words, ["HINSON"]);
});

test("a candidate search needs a name or a filter", () => {
  assert.throws(() => candidateWhere({ name: "A" }), /name, state, office, or party/);
  assert.throws(() => candidateWhere({}), /name, state, office, or party/);
});

test("each query word must start a word of the filed name", () => {
  assert.equal(nameMatches("ARENHOLZ, ASHLEY HINSON", ["HINSON"]), true);
  assert.equal(nameMatches("ARENHOLZ, ASHLEY HINSON", ["ASHLEY", "HINSON"]), true);
  assert.equal(nameMatches("HUTCHINSON, A", ["HINSON"]), false);
  assert.equal(nameMatches("PAXTON, WARREN KENNETH JR", ["KEN"]), true);
});

test("a ranking names the summary column and clamps the limit", () => {
  const query = rankQuery({ by: "cash_on_hand", office: "S", limit: 100 });

  assert.equal(query.column, "COH_COP");
  assert.equal(query.limit, 20);
  assert.deepEqual(query.where, ["s.COH_COP IS NOT NULL", "c.CAND_OFFICE = ?"]);
  assert.deepEqual(query.params, ["S"]);

  assert.equal(rankQuery({ by: "receipts" }).limit, 5);
  assert.throws(() => rankQuery({ by: "votes" }), /by must be one of/);
});

test("a committee search uppercases the ID and matches name words", () => {
  const query = committeeWhere({ committee_id: "c00916288", name: "WinRed" });

  assert.deepEqual(query.where, ["m.CMTE_ID = ?", "m.CMTE_NM LIKE ?"]);
  assert.deepEqual(query.params, ["C00916288", "%WINRED%"]);
  assert.throws(() => committeeWhere({}), /committee name or ID/);
});
