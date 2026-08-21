import type { SystemModelMessage } from "ai";

export type ThinkSystemWireBlock = {
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

function cacheProviderOptions(cacheControl: ThinkSystemWireBlock["cache_control"]) {
  return cacheControl
    ? { anthropic: { cacheControl: { type: "ephemeral" as const, ...(cacheControl.ttl ? { ttl: cacheControl.ttl } : {}) } } }
    : undefined;
}

/** Preserve assembler-owned Anthropic cache breakpoints at the AI SDK 7 boundary. */
export function structuredThinkInstructions(blocks: ReadonlyArray<ThinkSystemWireBlock>): SystemModelMessage[] {
  return blocks.map((block) => ({
    role: "system" as const,
    content: block.text,
    ...(block.cache_control ? { providerOptions: cacheProviderOptions(block.cache_control) } : {}),
  }));
}

export function prependThinkPolicy(policy: string, instructions: ReadonlyArray<SystemModelMessage>): SystemModelMessage[] {
  return [{ role: "system", content: policy }, ...instructions];
}
