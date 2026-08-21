import type { TelegramIntent, TelegramRenderPlan } from "./richResultRenderer";

export type TelegramPrimaryOutcome =
  | { kind: "accepted"; messageId?: string }
  | { kind: "definitive_rejection"; status: 400 }
  | { kind: "permission_denied"; status: 401 | 403 }
  | { kind: "rate_limited"; status: 429; retryAfterSeconds?: number }
  | { kind: "outcome_unknown"; status?: number };

export type RichResultDeliveryDecision =
  | { kind: "complete"; messageId?: string }
  | { kind: "send_fallback"; intent: TelegramIntent; fallbackIndex: number }
  | { kind: "retry_primary"; retryAfterSeconds?: number }
  | { kind: "attention_required"; reason: string };

export async function attemptRichResultPrimary(
  plan: TelegramRenderPlan,
  send: (intent: TelegramIntent) => Promise<Response>,
): Promise<TelegramPrimaryOutcome> {
  try {
    const response = await send(plan.primary);
    if (response.ok) {
      try {
        const body = await response.json() as { result?: { message_id?: number | string } };
        const messageId = body.result?.message_id;
        return { kind: "accepted", ...(messageId === undefined ? {} : { messageId: String(messageId) }) };
      } catch {
        return { kind: "accepted" };
      }
    }
    if (response.status === 400) return { kind: "definitive_rejection", status: 400 };
    if (response.status === 401 || response.status === 403) return { kind: "permission_denied", status: response.status };
    if (response.status === 429) {
      let retryAfterSeconds: number | undefined;
      try {
        const body = await response.json() as { parameters?: { retry_after?: number } };
        if (Number.isInteger(body.parameters?.retry_after) && (body.parameters?.retry_after ?? 0) >= 0) retryAfterSeconds = body.parameters!.retry_after;
      } catch { /* A missing retry-after remains a bounded policy decision. */ }
      return { kind: "rate_limited", status: 429, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
    }
    return { kind: "outcome_unknown", status: response.status };
  } catch {
    return { kind: "outcome_unknown" };
  }
}

export function decideRichResultDelivery(
  plan: TelegramRenderPlan,
  outcome: TelegramPrimaryOutcome,
  fallbackIndex = 0,
): RichResultDeliveryDecision {
  if (outcome.kind === "accepted") return { kind: "complete", ...(outcome.messageId ? { messageId: outcome.messageId } : {}) };
  if (outcome.kind === "definitive_rejection") {
    const intent = plan.deterministicFallbacks[fallbackIndex];
    return intent
      ? { kind: "send_fallback", intent, fallbackIndex }
      : { kind: "attention_required", reason: "telegram_rich_result_fallback_exhausted" };
  }
  if (outcome.kind === "rate_limited") return { kind: "retry_primary", ...(outcome.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: outcome.retryAfterSeconds }) };
  if (outcome.kind === "permission_denied") return { kind: "attention_required", reason: `telegram_http_${outcome.status}` };
  return { kind: "attention_required", reason: "telegram_rich_result_outcome_unknown" };
}
