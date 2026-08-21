/**
 * Stream content filters with a small state machine for <thinking>/<think> tag stripping.
 *
 * Handles:
 * - <thinking>...</thinking> and <think>...</think> stripped across chunk boundaries
 * - unclosed <thinking>/<think> tags are treated as model formatting mistakes:
 *   the tag is removed, but the following visible text is flushed at stream end
 * - strip_solid_square: ■ → "" (single-char, immediate)
 *
 * Design:
 * - IDLE state: buffer characters that might be part of an opening think tag.
 *   If buffer matches an opening tag prefix, keep buffering.
 *   If buffer is a full opening tag, switch to INSIDE_THINKING.
 *   Otherwise flush via applySingleCharRules.
 * - INSIDE_THINKING state: consume everything until the matching close tag is found.
 *
 * IMPORTANT: reasoning_content is NOT processed here. This filter only
 * runs on visible content deltas. The caller is responsible for routing
 * reasoning_content around this filter.
 */

const THINKING_TAGS = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" }
] as const;

type StreamFilterState = "IDLE" | "INSIDE_THINKING";

export interface ThinkingFilterState {
  state: StreamFilterState;
  buffer: string;
  closeTag: string | null;
  thinkingContent: string;
  /** Legacy field kept so stream state remains wire-compatible across deploys. */
  pendingDash: boolean;
}

export function createThinkingFilterState(): ThinkingFilterState {
  return { state: "IDLE", buffer: "", closeTag: null, thinkingContent: "", pendingDash: false };
}

/**
 * Apply single-character stream rules to a character.
 * Returns the replacement string ("" to delete, or the character itself).
 */
function applySingleCharRules(ch: string): string {
  if (ch === "■") return "";
  return ch;
}

function matchingOpenTag(buffer: string): (typeof THINKING_TAGS)[number] | null {
  return THINKING_TAGS.find((tag) => tag.open === buffer) ?? null;
}

function isOpeningTagPrefix(buffer: string): boolean {
  return THINKING_TAGS.some((tag) => tag.open.startsWith(buffer));
}

function applyVisibleTextRules(text: string): string {
  return text.replace(/■/g, "");
}

/**
 * Process a single visible content chunk through the stream filter.
 *
 * Handles <thinking> tag stripping across chunk boundaries,
 * and ■ deletion.
 *
 * Returns the filtered text to send to the client, or null if
 * the entire chunk was consumed by thinking content.
 */
export function processStreamChunk(
  chunk: string,
  state: ThinkingFilterState
): string | null {
  if (!chunk) return null;

  let output = "";
  state.pendingDash = false;

  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];

    if (state.state === "IDLE") {
      // --- <thinking>/<think> tag detection ---
      state.buffer += ch;

      if (isOpeningTagPrefix(state.buffer)) {
        const tag = matchingOpenTag(state.buffer);
        if (tag) {
          state.state = "INSIDE_THINKING";
          state.closeTag = tag.close;
          state.thinkingContent = "";
          state.buffer = "";
        }
        continue;
      }

      // Buffer is NOT a prefix of a thinking tag. Flush characters.
      while (state.buffer.length > 0 && !isOpeningTagPrefix(state.buffer)) {
        output += applySingleCharRules(state.buffer[0]);
        state.buffer = state.buffer.slice(1);
      }

      const tag = matchingOpenTag(state.buffer);
      if (tag) {
        state.state = "INSIDE_THINKING";
        state.closeTag = tag.close;
        state.thinkingContent = "";
        state.buffer = "";
      }
      continue;
    }

    // INSIDE_THINKING state
    state.buffer += ch;

    const closeTag = state.closeTag || THINKING_TAGS[0].close;
    if (closeTag.startsWith(state.buffer)) {
      if (state.buffer === closeTag) {
        state.state = "IDLE";
        state.closeTag = null;
        state.thinkingContent = "";
        state.buffer = "";
      }
      continue;
    }

    // Not a prefix of the close tag. Keep it in case this was an unclosed
    // thinking tag that actually contains visible answer text.
    while (state.buffer.length > 0 && !closeTag.startsWith(state.buffer)) {
      state.thinkingContent += state.buffer[0];
      state.buffer = state.buffer.slice(1);
    }
  }

  // Flush any remaining buffer that's not a thinking-tag prefix.
  if (state.state === "IDLE" && state.buffer && !isOpeningTagPrefix(state.buffer)) {
    for (const bufCh of state.buffer) {
      output += applySingleCharRules(bufCh);
    }
    state.buffer = "";
  }

  return output || null;
}

/**
 * Legacy no-op. Kept so stream callers do not need a coordinated deploy.
 */
export function flushPendingDash(state: ThinkingFilterState): string {
  state.pendingDash = false;
  return "";
}

/**
 * Flush any visible text held by the stream filter at stream end.
 *
 * Complete thinking blocks are removed. If a model emits an opening think tag
 * and never closes it, treat that as a formatting failure and preserve the text
 * after the tag instead of deleting the whole answer.
 */
export function flushStreamFilter(state: ThinkingFilterState): string {
  let output = "";

  if (state.state === "INSIDE_THINKING") {
    output += applyVisibleTextRules(state.thinkingContent + state.buffer);
    state.state = "IDLE";
    state.closeTag = null;
    state.thinkingContent = "";
    state.buffer = "";
  } else if (state.buffer) {
    output += applyVisibleTextRules(state.buffer);
    state.buffer = "";
  }

  return output + flushPendingDash(state);
}
