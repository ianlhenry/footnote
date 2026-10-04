import type { ExpectedValue } from "./cases.ts";

// A figure written in an answer, scaled to its plain value: "$68.6 million"
// is 68600000 and "52%" is 52.
export interface FoundNumber {
  value: number;
  percent: boolean;
  text: string;
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

const SCALES: Record<string, number> = {
  thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, b: 1e9, bn: 1e9,
};

const NUMBER =
  /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|percent\b|percentage points?\b|thousand\b|million\b|billion\b|mn\b|bn\b|[kmb]\b)?/gi;

export function findNumbers(text: string): FoundNumber[] {
  const found: FoundNumber[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const [whole, digits, fraction, suffix] = match;
    let value = Number(digits.replaceAll(",", "") + (fraction ?? ""));
    const unit = suffix?.toLowerCase();
    const percent = unit === "%" || unit === "percent";
    if (unit && unit in SCALES) value *= SCALES[unit];
    found.push({ value, percent, text: whole.trim() });
  }
  for (const match of text.matchAll(/\b([a-z]+)\b/gi)) {
    const value = WORDS[match[1].toLowerCase()];
    if (value !== undefined) found.push({ value, percent: false, text: match[1] });
  }
  return found;
}

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
// "April 20-26", "Sept. 14-15, 2026", "September 17th through 20th", "Nov. 17 to 30".
const DATE = new RegExp(
  `\\b${MONTH}\\.?\\s+\\d{1,2}(?!\\d)(?:st|nd|rd|th)?(?:\\s*(?:-|–|—|to|through)\\s*(?:${MONTH}\\.?\\s+)?\\d{1,2}(?!\\d)(?:st|nd|rd|th)?)?(?:,?\\s+\\d{4})?`,
  "gi",
);
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

// The figures in an answer that a citation should back: numbers written in
// digits, leaving out dates, bare years such as "2026", and number words
// such as "one".
export function findFigures(text: string): FoundNumber[] {
  const withoutDates = text.replace(DATE, " ").replace(ISO_DATE, " ");
  return findNumbers(withoutDates).filter((found) => /\d/.test(found.text) && !/^(19|20)\d\d$/.test(found.text));
}

// Whether the answer states the expected figure. Percentages may be written
// with or without the sign ("50-42"); dollars and counts may be rounded.
export function matches(expected: ExpectedValue, found: FoundNumber): boolean {
  const { n, kind } = expected;
  switch (kind) {
    case "pct":
      return Math.abs(found.value - n) <= 0.5;
    case "num":
      return Math.abs(found.value - n) <= 0.05;
    case "usd":
      return !found.percent && Math.abs(found.value - n) <= Math.abs(n) * 0.01;
    case "count":
      return !found.percent && Math.abs(found.value - n) <= Math.abs(n) * 0.005;
  }
}

export function stated(expected: ExpectedValue, text: string): boolean {
  return findNumbers(text).some((found) => matches(expected, found));
}
