import { authenticate } from "../auth/apiKey";
import { thinkApprovalAuthorityScopeHash } from "../memory/think/approvalContinuation";
import {
  claimThinkSdkActionDecision,
  readThinkSdkActionProjection,
  releaseThinkSdkActionDecisionClaim,
} from "../memory/think/sdkActionProjection";
import { enqueueThinkSdkActionDecision } from "../queue/producer";
import type { Env } from "../types";

export async function handleThinkSdkActionDecision(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "<MEMORY_SERVICE>.internal") return json({ error: "not_found" }, 404);
  const auth = await authenticate(request, env);
  if (!auth.ok || auth.keyName !== "TG_CHAT_API_KEY") return json({ error: "unauthorized" }, 401);
  const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const approvalRef = typeof body.approvalRef === "string" && /^tsa_[a-f0-9]{32}$/.test(body.approvalRef) ? body.approvalRef : "";
  const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const scopeKind = body.scopeKind === "private" || body.scopeKind === "qa_room" ? body.scopeKind : null;
  const threadKey = typeof body.threadKey === "string" ? body.threadKey : "";
  if (!approvalRef || !decision || !ownerId || !chatId || !scopeKind || !threadKey) return json({ error: "think_sdk_action_decision_invalid" }, 422);
  const authorityScopeHash = await thinkApprovalAuthorityScopeHash({ ownerId, chatId, scopeKind, threadKey });
  const row = await claimThinkSdkActionDecision({ db: env.DB, approvalRef, authorityScopeHash, decision });
  if (!row) {
    const existing = await readThinkSdkActionProjection(env.DB, approvalRef);
    if (!existing) return json({ error: "think_sdk_action_not_found", status: "missing" }, 404);
    if (existing.authority_scope_hash !== authorityScopeHash) {
      return json({ error: "think_sdk_action_scope_mismatch", status: existing.status }, 403);
    }
    if (existing.status === "pending_approval" && Date.parse(existing.expires_at) <= Date.now()) {
      return json({ error: "think_sdk_action_expired", status: "expired" }, 410);
    }
    return json({ error: "think_sdk_action_not_actionable", status: existing.status }, 409);
  }
  try {
    await enqueueThinkSdkActionDecision(env,approvalRef,0,0);
    return json({ ok: true, approvalRef, status: "decision_pending", decision }, 202);
  } catch (error) {
    const code = String(error instanceof Error ? error.message : error).replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 160);
    await releaseThinkSdkActionDecisionClaim(env.DB,approvalRef,code || "think_sdk_action_enqueue_failed");
    return json({ error: code || "think_sdk_action_enqueue_failed", status:"pending_approval" }, 503);
  }
}

function json(value: unknown, status: number) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
