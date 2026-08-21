import { authenticate } from "../auth/apiKey";
import { enqueueThinkCodeModeContinuation, readThinkCodeModeContinuation, stopThinkCodeModeContinuation } from "../memory/think/codeModeContinuation";
import { thinkApprovalAuthorityScopeHash } from "../memory/think/approvalContinuation";
import { completeProductionThinkTask, resumeProductionCodeMode } from "../memory/think/productionAgentGatewayClient";
import type { Env } from "../types";

export async function handleThinkCodeModeWake(request: Request, env: Env): Promise<Response> {
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
  const ref = typeof body.codemodeRef === "string" ? body.codemodeRef : "";
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const scopeKind = body.scopeKind === "private" || body.scopeKind === "qa_room" ? body.scopeKind : null;
  const threadKey = typeof body.threadKey === "string" ? body.threadKey : "";
  if (body.action !== "stop" || !/^tcm_[a-f0-9]{32}$/.test(ref)
    || !ownerId || !chatId || !scopeKind || !threadKey) return json({ error: "think_codemode_wake_invalid" }, 400);
  const row = await readThinkCodeModeContinuation(env.DB, ref);
  if (!row) return json({ error: "think_codemode_projection_not_found" }, 404);
  const authorityScopeHash = await thinkApprovalAuthorityScopeHash({ ownerId, chatId, scopeKind, threadKey });
  if (authorityScopeHash !== row.authority_scope_hash) return json({ error: "think_codemode_scope_mismatch" }, 403);
  const stopped = await stopThinkCodeModeContinuation(env, ref);
  if (!stopped || stopped.status !== "stopped") {
    return json({ error: "think_codemode_stop_too_late", codemodeRef: ref, status: stopped?.status ?? "missing" }, 409);
  }
  await resumeProductionCodeMode({ env, executionId: row.agent_execution_id,
    authorityScopeHash: row.authority_scope_hash, action: "stop" }).catch((error) => {
      console.error("operia_think_codemode_agent_stop_degraded", { code: String(error).slice(0,160) });
    });
  if (env.OPERIA_THINK) {
    const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(row.think_instance_id)) as unknown as {
      setName(name: string): Promise<void>;
      stopCodeModeContinuation(input: { requestId: string }): Promise<void>;
    };
    try {
      await think.setName(row.think_instance_id);
      await think.stopCodeModeContinuation({ requestId: row.request_id });
    } catch (error) {
      console.error("operia_think_codemode_stop_cleanup_degraded", { code: String(error).slice(0,160) });
    }
  }
  await completeProductionThinkTask({ env, thinkTaskId: row.request_id,
    authorityScopeHash: row.authority_scope_hash }).catch((error) => {
    console.error("operia_think_codemode_task_grant_cleanup_degraded", { code: String(error).slice(0,160) });
  });
  await enqueueThinkCodeModeContinuation(env, stopped.codemode_ref);
  return json({ ok: true, codemodeRef: ref, status: "stopped" }, 202);
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
