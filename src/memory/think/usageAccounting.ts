export type ThinkStepUsageInput = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

export type ThinkStepUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

function finiteTokenCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

/**
 * Translate AI SDK 7 usage into the Anthropic-native accounting contract used
 * by Operia persistence and pricing. AI SDK inputTokens includes no-cache,
 * cache-read, and cache-write tokens; Operia stores those buckets separately.
 */
export function normalizeThinkStepUsage(usage: ThinkStepUsageInput): ThinkStepUsage {
  const cachedInputTokens = finiteTokenCount(usage.inputTokenDetails.cacheReadTokens);
  const cacheWriteTokens = finiteTokenCount(usage.inputTokenDetails.cacheWriteTokens);
  const normalizedInputTokens = finiteTokenCount(usage.inputTokens);
  const reportedNoCacheTokens = usage.inputTokenDetails.noCacheTokens;
  const inputTokens = Number.isFinite(reportedNoCacheTokens)
    ? finiteTokenCount(reportedNoCacheTokens)
    : Math.max(0, normalizedInputTokens - cachedInputTokens - cacheWriteTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
  };
}
