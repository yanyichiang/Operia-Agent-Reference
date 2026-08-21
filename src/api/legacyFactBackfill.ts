import { bearerAuthorized, json, readJsonObject } from "../agent/security";
import { createLegacyVNextBackfillRun } from "../memory/candidateJudge";
import type { Env } from "../types";

export async function handleLegacyFactBackfill(request: Request,env: Env): Promise<Response> {
  if (!env.MEMORY_VNEXT_BACKFILL_TOKEN) return new Response("Not found",{ status: 404 });
  if (request.method !== "POST") return new Response("Not found",{ status: 404 });
  if (!await bearerAuthorized(request,env.MEMORY_VNEXT_BACKFILL_TOKEN)) {
    return json({ error: "unauthorized" },{ status: 401 });
  }
  if (!env.MEMORY_QUEUE) return json({ error: "memory_queue_unavailable" },{ status: 503 });
  let body: Record<string,unknown>;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ error: "json_object_required" },{ status: 400 });
  }
  const namespace = typeof body.namespace === "string" && body.namespace.trim()
    ? body.namespace.trim().slice(0,160)
    : "default";
  const requestedRaw = typeof body.requested_count === "number" ? body.requested_count : 200;
  const requestedCount = Math.min(Math.max(Math.floor(requestedRaw),1),200);
  const run = await createLegacyVNextBackfillRun(env,namespace,{ requestedCount });
  await env.MEMORY_QUEUE.send({
    type: "legacy_vnext_backfill",
    namespace,
    runId: run.runId,
    remainingCandidates: run.requestedCount,
  });
  return json({
    accepted: true,
    run_id: run.runId,
    namespace,
    requested_count: run.requestedCount,
    model: run.model,
  },{ status: 202 });
}
