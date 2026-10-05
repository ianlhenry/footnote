import assert from "node:assert/strict";
import { test } from "node:test";
import { findFigures, findNumbers, matches } from "./numbers.ts";

test("scale words turn a written amount into its plain value", () => {
  const found = findNumbers("$4.2k, 12 thousand, 68.6mn, and $2.5 billion");

  assert.deepEqual(
    found.map((item) => item.value),
    [4200, 12000, 68.6e6, 2.5e9],
  );
  assert.ok(found.every((item) => !item.percent));
});

test("figures leave out dates, bare years, and number words", () => {
  const figures = findFigures(
    "In September 2026, one poll on April 20 found 34% and $1.2 million. Filed 2026-09-14.",
  );

  assert.deepEqual(
    figures.map((item) => item.value),
    [34, 1.2e6],
  );
});

test("percentage points are not read as a percent", () => {
  const [found] = findNumbers("plus or minus 3.8 percentage points");

  assert.equal(found?.value, 3.8);
  assert.equal(found?.percent, false);
});

test("each kind matches inside its own tolerance", () => {
  const pct = { value: 52.5, percent: true, text: "52.5%" };
  assert.equal(matches({ n: 52, kind: "pct" }, pct), true);
  assert.equal(matches({ n: 52, kind: "pct" }, { ...pct, value: 52.6, text: "52.6%" }), false);

  const dollars = { value: 101, percent: false, text: "$101" };
  assert.equal(matches({ n: 100, kind: "usd" }, dollars), true);
  assert.equal(matches({ n: 100, kind: "usd" }, { ...dollars, value: 102, text: "$102" }), false);
  assert.equal(matches({ n: 52, kind: "usd" }, pct), false);

  const count = { value: 1005, percent: false, text: "1,005" };
  assert.equal(matches({ n: 1000, kind: "count" }, count), true);
  assert.equal(
    matches({ n: 1000, kind: "count" }, { ...count, value: 1006, text: "1,006" }),
    false,
  );
  assert.equal(
    matches({ n: 1000, kind: "count" }, { value: 1000, percent: true, text: "1000%" }),
    false,
  );

  assert.equal(
    matches({ n: 10, kind: "num" }, { value: 10.04, percent: false, text: "10.04" }),
    true,
  );
  assert.equal(
    matches({ n: 10, kind: "num" }, { value: 10.06, percent: false, text: "10.06" }),
    false,
  );
});
