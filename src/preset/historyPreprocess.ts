/**
 * History message preprocessing: strip <thinking> tags from historical
 * user/assistant messages before they enter the assembler.
 *
 * Rules:
 * - Only applies strip_thinking to history messages, NOT the current user message.
 * - Skips tool and system messages.
 * - For string content: applies strip_thinking directly.
 * - For array content: only processes text parts, preserves image_url etc.
 * - Returns NEW message objects (shallow copy), never mutates originals.
 */

import type { OpenAIChatMessage } from "../types";
import { HISTORY_RULES } from "./regexRules";
import { applyRegexRules } from "./regexPipeline";

/**
 * Preprocess a history message: strip <thinking> from visible text content.
 * Returns a new message object with cleaned content, or the original if no
 * changes were needed.
 */
function preprocessMessage(msg: OpenAIChatMessage): OpenAIChatMessage {
  if (msg.role !== "user" && msg.role !== "assistant") return msg;

  if (typeof msg.content === "string") {
    const cleaned = applyRegexRules(msg.content, HISTORY_RULES);
    if (cleaned === msg.content) return msg;
    return { ...msg, content: cleaned };
  }

  if (Array.isArray(msg.content)) {
    let changed = false;
    const newParts: unknown[] = [];

    for (const part of msg.content) {
      if (
        part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        const original = (part as Record<string, unknown>).text as string;
        const cleaned = applyRegexRules(original, HISTORY_RULES);
        if (cleaned !== original) {
          changed = true;
          newParts.push({ ...part, text: cleaned });
        } else {
          newParts.push(part);
        }
      } else {
        // Non-text parts (image_url, etc.) — pass through unchanged.
        newParts.push(part);
      }
    }

    if (!changed) return msg;
    return { ...msg, content: newParts };
  }

  return msg;
}

/**
 * Preprocess history messages: strip <thinking> from all user/assistant
 * messages in the history array.
 *
 * The caller must pass ONLY history messages (not the current user message).
 * This function does NOT touch the current user message.
 */
export function preprocessHistory(
  messages: OpenAIChatMessage[]
): OpenAIChatMessage[] {
  let changed = false;
  const result: OpenAIChatMessage[] = [];

  for (const msg of messages) {
    const cleaned = preprocessMessage(msg);
    if (cleaned !== msg) changed = true;
    result.push(cleaned);
  }

  return changed ? result : messages;
}
