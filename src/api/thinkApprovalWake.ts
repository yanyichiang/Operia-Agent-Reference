import { authenticate } from "../auth/apiKey";
import {
  enqueueThinkApprovalContinuation,
  readThinkApprovalContinuationByTicket,
  reserveThinkApprovalDecision,
  stopThinkApprovalContinuation,
  thinkApprovalAuthorityScopeHash,
  type ThinkApprovalDecisionScope,
} from "../memory/think/approvalContinuation";
import { completeProductionThinkTask } from "../memory/think/productionAgentGatewayClient";
import type { Env } from "../types";

export async function handleThinkApprovalWake(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "<MEMORY_SERVICE>.internal") {
    return json({ error: "not_found" }, 404);
  }
  const auth = await authenticate(request, env);
  if (!auth.ok || auth.keyName !== "TG_CHAT_API_KEY") return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json<unknown>();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const decisionScope = body.decisionScope === "once" || body.decisionScope === "task" || body.decisionScope === "reject"
    ? body.decisionScope as ThinkApprovalDecisionScope : null;
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const scopeKind = body.scopeKind === "private" || body.scopeKind === "qa_room" ? body.scopeKind : null;
  const threadKey = typeof body.threadKey === "string" ? body.threadKey : "";
  if (!ticketId || !decisionScope || !ownerId || !chatId || !scopeKind || !threadKey) {
    const hasStopLocator = typeof body.taskId === "string" || typeof body.ticketId === "string";
    if (body.action !== "stop" || !hasStopLocator || !ownerId || !chatId || !scopeKind || !threadKey) {
      return json({ error: "think_approval_wake_invalid" }, 400);
    }
  }
  const authorityScopeHash = await thinkApprovalAuthorityScopeHash({ ownerId, chatId, scopeKind, threadKey });
  if (body.action === "stop") {
    const stopped = await stopThinkApprovalContinuation({
      env,
      ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
      ...(typeof body.ticketId === "string" ? { ticketId: body.ticketId } : {}),
      authorityScopeHash,
    });
    if (!stopped) return json({ error: "think_approval_projection_not_found" }, 404);
    if (env.OPERIA_THINK) {
      const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(stopped.think_instance_id)) as unknown as {
        setName(name: string): Promise<void>;
        stopApprovalContinuation(input: { requestId: string }): Promise<void>;
      };
      try {
        await think.setName(stopped.think_instance_id);
        await think.stopApprovalContinuation({ requestId: stopped.request_id });
      } catch (error) {
        console.error("operia_think_approval_stop_cleanup_degraded", { code: String(error).slice(0, 160) });
      }
    }
    await completeProductionThinkTask({ env, thinkTaskId: stopped.think_task_id, authorityScopeHash }).catch((error) => {
      console.error("operia_think_approval_task_grant_cleanup_degraded", { code: String(error).slice(0, 160) });
    });
    await enqueueThinkApprovalContinuation(env, stopped.approval_ref);
    return json({ ok: true, approvalRef: stopped.approval_ref, status: "stopped" }, 202);
  }
  if (!decisionScope) return json({ error: "think_approval_wake_invalid" }, 400);
  const row = await reserveThinkApprovalDecision({ env, ticketId, decisionScope, authorityScopeHash });
  if (!row) {
    const existing = await readThinkApprovalContinuationByTicket(env.DB, ticketId);
    if (existing) {
      return json({ error: "think_approval_projection_not_actionable", status: existing.status }, 409);
    }
    return json({ error: "think_approval_projection_not_found" }, 404);
  }
  await enqueueThinkApprovalContinuation(env, row.approval_ref);
  return json({ ok: true, approvalRef: row.approval_ref, status: row.status }, 202);
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
