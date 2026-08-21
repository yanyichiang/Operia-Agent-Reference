/**
 * assemble — main entry point for the v4 Prompt Assembler.
 *
 * Converts an OpenAIChatRequest into an AssembledPrompt.
 * The adapters (anthropic/openai) consume the output via the
 * buildAnthropicRequestFromAssembled / buildOpenAIRequestFromAssembled helpers.
 *
 * Determinism: given the same request + pre-fetched data, the output is
 * bit-for-bit identical across calls. No timestamps, no request ids.
 */

import type {
  MemoryApiRecord,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "../types";
import type { BootPackage } from "../memory/v2/recall";
import type { ConversationSummaryPatch } from "../memory/conversationFreshness";
import type { SubjectCoreBlock } from "../memory/subjectCore";
import type { AssembledPrompt, AssemblerContext, DynamicMemoryCarriers, ExactTurnClock } from "./types";
import { assemble as assembleBlocks } from "./blocks";
import { getContinuationMode } from "../tools/continuation";

// ---------------------------------------------------------------------------
// Input for assemble — pre-fetched data, no DB calls here
// ---------------------------------------------------------------------------

export interface AssembleInput {
  /** The incoming OpenAI-compatible chat request. */
  request: OpenAIChatRequest;

  /**
   * Pre-filtered pinned memories of type "persona" or "identity".
   * Caller is responsible for filtering and initial sort;
   * the assembler applies its own deterministic sort as a safety net.
   */
  pinnedPersonaMemories: MemoryApiRecord[] | null;

  /** Owner-approved stable Subject Core projections. */
  subjectCore?: SubjectCoreBlock[];

  /** v2 boot package (yesterday_log + precious + glossary). null = v1 path. */
  boot: BootPackage | null;

  /** Optional exact owner-local clock for the current turn. */
  turnClock?: ExactTurnClock | null;

  /** RAG hits for the current round (v1) or recall hits (v2). */
  ragMemories: MemoryApiRecord[];

  /** vNext.2 evidence/model/Point carriers, already rendered and hashed. */
  dynamicMemoryCarriers?: DynamicMemoryCarriers | null;

  /** Keep the stable MB1 codebook byte-inert until MB1 injection is explicitly enabled. */
  mb1CodebookEnabled?: boolean;

  /** Memory-owner validated rolling-summary projection for this turn only. */
  conversationSummaryPatch?: ConversationSummaryPatch | null;

  /** Vision assistant output (image present + main model non-multimodal). */
  visionOutput: string | null;
}

// ---------------------------------------------------------------------------
// assemble() — main entry
// ---------------------------------------------------------------------------

/**
 * Build an AssembledPrompt from an OpenAI request + pre-fetched context data.
 *
 * The caller (adapter) is responsible for:
 * - Fetching pinnedPersonaMemories from D1
 * - Running RAG search for ragMemories
 * - Running vision model for visionOutput
 * - Converting AssembledPrompt to Anthropic/OpenAI wire format
 */
export function assemble(input: AssembleInput): AssembledPrompt {
  const { request } = input;
  const continuationMode = getContinuationMode(request.messages);

  const ctx: AssemblerContext = {
    systemMessages: extractSystemMessages(request.messages),
    pinnedPersonaMemories: input.pinnedPersonaMemories,
    subjectCore: input.subjectCore ?? [],
    boot: input.boot,
    turnClock: input.turnClock ?? null,
    ragMemories: input.ragMemories,
    dynamicMemoryCarriers: input.dynamicMemoryCarriers ?? null,
    mb1CodebookEnabled: input.mb1CodebookEnabled ?? false,
    conversationSummaryPatch: input.conversationSummaryPatch ?? null,
    visionOutput: input.visionOutput,
    historyMessages: extractHistoryMessages(request.messages, continuationMode.isContinuation),
    currentUserMessage: extractLastUserMessage(request.messages, continuationMode.isContinuation),
  };

  return assembleBlocks(ctx);
}

// ---------------------------------------------------------------------------
// Message extraction helpers
// ---------------------------------------------------------------------------

function extractSystemMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  return messages.filter((m) => m.role === "system");
}

/**
 * All user/assistant messages EXCEPT the last user message.
 * Skips system and tool messages.
 * Preserves original message objects (no content flattening).
 */
function extractHistoryMessages(
  messages: OpenAIChatMessage[],
  isContinuation: boolean
): OpenAIChatMessage[] {
  // Find the index of the last user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: OpenAIChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;
    if (!isContinuation && i === lastUserIdx) continue;
    result.push(msg);
  }

  return result;
}

/**
 * The last user message, preserving original content (including image_url).
 * Returns null if no user message exists.
 */
function extractLastUserMessage(
  messages: OpenAIChatMessage[],
  isContinuation: boolean
): OpenAIChatMessage | null {
  if (isContinuation) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return null;
}

// Re-export for adapter convenience
export { assembleBlocks };
export type { AssembledPrompt, AssemblerContext };
