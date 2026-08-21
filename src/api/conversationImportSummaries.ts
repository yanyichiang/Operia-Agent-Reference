import { authorizeConversationImportPrivileged } from "../memory/import/privilegedAuth";
import {
  ConversationImportSummaryError,
  IMPORT_SUMMARY_MAX_AUTONOMOUS_BUDGET_MICROUSD,
  planConversationImportSummaryCanary,
  runConversationImportSummaryCanary,
} from "../memory/import/summaryRunner";
import type { Env } from "../types";

const BODY_MAX_BYTES = 16 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex",
  } });
}

async function readBody(request: Request): Promise<{ limit?: number; offset?: number; budget_microusd?: number; generation?: number }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) throw new ConversationImportSummaryError("summary_body_too_large", 413);
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_MAX_BYTES) {
      await reader.cancel("summary_body_too_large");
      throw new ConversationImportSummaryError("summary_body_too_large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0) return {};
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as {
    limit?: number; offset?: number; budget_microusd?: number; generation?: number;
  }; }
  catch { throw new ConversationImportSummaryError("invalid_summary_request", 422); }
}

function route(pathname: string): { batchId: string; action: "plan" | "canary" | "batch" | "status" } | null {
  const match = pathname.match(/^\/v1\/conversation-imports\/privileged\/batches\/(cib_[a-f0-9]{32})\/summaries\/(plan|canary|batch|status)$/);
  return match ? { batchId: match[1], action: match[2] as "plan" | "canary" | "batch" | "status" } : null;
}

export async function handleConversationImportSummaryApi(request: Request, env: Env): Promise<Response> {
  if (env.WORKER_ROLE !== "memory") return json({ error: "conversation_import_summary_not_available" }, 404);
  if (env.CONVERSATION_IMPORT_SUMMARY_ENABLED?.trim().toLowerCase() !== "true") {
    return json({ error: "conversation_import_summary_disabled" }, 404);
  }
  const namespace = await authorizeConversationImportPrivileged(request, env);
  if (!namespace) return json({ error: "unauthorized" }, 401);
  const matched = route(new URL(request.url).pathname);
  if (!matched) return json({ error: "not_found" }, 404);
  try {
    if (request.method === "GET" && matched.action === "plan") {
      return json(await planConversationImportSummaryCanary(env, { namespace, batchId: matched.batchId, limit: 3 }));
    }
    if (request.method === "POST" && matched.action === "canary") {
      const body = await readBody(request);
      return json(await runConversationImportSummaryCanary(env, {
        namespace,
        batchId: matched.batchId,
        limit: body.limit,
        generation: body.generation,
        budgetMicrousd: Math.min(Number(body.budget_microusd) || IMPORT_SUMMARY_MAX_AUTONOMOUS_BUDGET_MICROUSD,
          IMPORT_SUMMARY_MAX_AUTONOMOUS_BUDGET_MICROUSD),
      }), 202);
    }
    if (request.method === "POST" && matched.action === "batch") {
      const body = await readBody(request);
      return json(await runConversationImportSummaryCanary(env, {
        namespace,
        batchId: matched.batchId,
        limit: body.limit,
        offset: body.offset,
        generation: body.generation,
        budgetMicrousd: Math.min(Number(body.budget_microusd) || IMPORT_SUMMARY_MAX_AUTONOMOUS_BUDGET_MICROUSD,
          IMPORT_SUMMARY_MAX_AUTONOMOUS_BUDGET_MICROUSD),
      }), 202);
    }
    if (request.method === "GET" && matched.action === "status") {
      const rows = await env.DB.prepare(`SELECT j.id,j.status,j.cursor,j.processed_count,j.error_count,j.error_code,j.updated_at,
          COUNT(c.id) AS model_calls,COALESCE(SUM(c.cost_microusd),0) AS cost_microusd,
          COALESCE(SUM(c.input_tokens),0) AS input_tokens,COALESCE(SUM(c.output_tokens),0) AS output_tokens,
          COALESCE(SUM(c.cache_read_tokens),0) AS cache_read_tokens,COALESCE(SUM(c.cache_creation_tokens),0) AS cache_creation_tokens
        FROM conversation_import_jobs j LEFT JOIN conversation_import_summary_model_calls c ON c.job_id=j.id AND c.status='completed'
        WHERE j.namespace=? AND j.batch_id=? AND j.kind='summarize'
        GROUP BY j.id ORDER BY j.created_at DESC LIMIT 10`).bind(namespace, matched.batchId).all();
      return json({ jobs: rows.results || [] });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    if (error instanceof ConversationImportSummaryError) return json({ error: error.code }, error.status);
    return json({ error: "conversation_import_summary_failed" }, 500);
  }
}
