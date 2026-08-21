import type { ModelMessage, SystemModelMessage } from "ai";
import {
  applyMessageCacheBreakpoints,
  assembledToAnthropicMessages,
  assembledToAnthropicSystem,
} from "../../assembler/toAnthropic";
import type { AssembledPrompt, CacheBreakpoint } from "../../assembler/types";
import { getAnthropicCacheTtls } from "../../proxy/anthropicAdapter";
import { structuredThinkInstructions } from "./inputAdapter";

export type AssembledThinkInputEnv = {
  ANTHROPIC_CACHE_ENABLED?: string;
  ANTHROPIC_CACHE_TTL?: string;
  ANTHROPIC_CACHE_STABLE_TTL?: string;
  ANTHROPIC_CACHE_CONVERSATION_TTL?: string;
  MEMORY_THINK_CACHE_V3_MODE?: string;
};

export type AssembledThinkInput = {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  /** Breakpoints actually projected onto the Think wire. */
  cacheBreakpoints: CacheBreakpoint[];
};

function providerOptions(cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" }) {
  return cacheControl
    ? { anthropic: { cacheControl: { type: "ephemeral" as const, ...(cacheControl.ttl ? { ttl: cacheControl.ttl } : {}) } } }
    : undefined;
}

/**
 * The single production adapter from Prompt Assembler output to AI SDK 7
 * Think input. Tests import this function directly so cache placement cannot
 * drift behind a hand-written fixture.
 */
export function buildAssembledThinkInput(
  assembled: AssembledPrompt,
  env: AssembledThinkInputEnv,
): AssembledThinkInput {
  const cacheEnabled = env.ANTHROPIC_CACHE_ENABLED !== "false";
  const systemWire = assembledToAnthropicSystem(assembled.system_blocks);
  const { wire: messageWire, indexMap } = assembledToAnthropicMessages(assembled.messages);
  const cacheBreakpoints = env.MEMORY_THINK_CACHE_V3_MODE === "anchored_v3"
    ? assembled.meta.cache_breakpoints.filter((breakpoint) => breakpoint.reason !== "bridge")
    : [...assembled.meta.cache_breakpoints];

  if (cacheEnabled) {
    const ttls = getAnthropicCacheTtls(env as Parameters<typeof getAnthropicCacheTtls>[0]);
    for (const block of systemWire) {
      if (block.cache_control) block.cache_control = { type: "ephemeral", ttl: ttls.stable };
    }
    applyMessageCacheBreakpoints(
      messageWire,
      cacheBreakpoints,
      indexMap,
      { type: "ephemeral", ttl: ttls.conversation },
    );
  } else {
    for (const block of systemWire) delete block.cache_control;
  }

  const instructions = structuredThinkInstructions(systemWire);
  const messages = messageWire.map((message) => ({
    role: message.role,
    content: message.content.map((block) => ({
      type: "text" as const,
      text: block.type === "text" ? block.text : JSON.stringify(block),
      ...(block.cache_control ? { providerOptions: providerOptions(block.cache_control) } : {}),
    })),
  })) as ModelMessage[];

  return { instructions, messages, cacheBreakpoints };
}
