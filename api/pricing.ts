// Anthropic list prices per million tokens, used to show what an answer cost
// and what an eval run cost. Update them here when prices change.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface TokenCounts {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Dollars for one Claude call. Cache writes bill at 1.25× the input price and
// cache reads at 0.1×. Null for a model missing from the table, rather than
// a wrong number.
export function callCost(usage: TokenCounts): number | null {
  const price = PRICES[usage.model];
  if (!price) return null;
  return (
    (usage.input_tokens * price.input +
      (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * price.input * 0.1 +
      usage.output_tokens * price.output) /
    1e6
  );
}
