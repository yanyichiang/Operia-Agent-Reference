import type { TokenUsage } from "../../types";

function requiredToken(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`summary_usage_${name}_missing`);
  return Number(value);
}

/**
 * Claude Opus 4.6 standard global endpoint price snapshot, expressed directly
 * in micro-USD per token: input=5, output=25, 1h cache write=10,
 * cache read=0.5. The caller persists the resulting integer charge estimate
 * with the provider usage checkpoint.
 */
export function calculateOpus46CostMicrousd(usage: TokenUsage | undefined): number {
  const input = requiredToken(usage?.input_tokens ?? usage?.prompt_tokens, "input");
  const output = requiredToken(usage?.output_tokens ?? usage?.completion_tokens, "output");
  const cacheRead = requiredToken(usage?.cache_read_input_tokens ?? 0, "cache_read");
  const cacheCreate = requiredToken(usage?.cache_creation_input_tokens ?? 0, "cache_creation");
  return Math.ceil(input * 5 + output * 25 + cacheRead * 0.5 + cacheCreate * 10);
}
