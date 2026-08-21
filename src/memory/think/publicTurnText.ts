export type SessionMessageLike = { parts?: readonly unknown[] };

export function sessionMessageText(message: SessionMessageLike | undefined): string {
  if (!message?.parts) return "";
  return message.parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

/**
 * A Think ChatResponseResult message is the persisted assistant transcript for
 * the whole turn. Live Telegram turns use the exact admitted ordinary-text
 * stream as canonical text; legacy barrier turns use the captured final step.
 * Missing authoritative text fails closed instead of falling back to the
 * aggregate transcript.
 */
export function resolvePublicTurnText(input: {
  message: SessionMessageLike | undefined;
  finalStepAuthoritative: boolean;
  finalStepText: string | null;
  /** Exact ordinary text deltas already admitted to the live public stream. */
  liveStreamText?: string | null;
}): string {
  if (typeof input.liveStreamText === "string" && input.liveStreamText.trim()) {
    return input.liveStreamText;
  }
  return input.finalStepAuthoritative ? input.finalStepText ?? "" : sessionMessageText(input.message);
}
