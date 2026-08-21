import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { episodicIndexStatus, indexPendingEpisodic } from "../memory/episodic";
import { runRecall } from "../memory/v2/recall";
import { readMemoryVnext2Inspector } from "../memory/vnext/inspector";
import {
  approveSubjectProposal,
  decideSubjectProposal,
  subjectStudioSnapshot,
} from "../memory/subjectCore";
import type { Env } from "../types";
import { sha256Hex } from "../utils/hash";
import { json, openAiError } from "../utils/json";
import { readJsonObject, readPositiveInt, readString, resolveNamespace } from "../utils/request";

function expectedRevision(request: Request, body: Record<string, unknown>): number | null {
  const ifMatch = request.headers.get("if-match")?.replaceAll('"', "").trim();
  const raw = ifMatch || body.revision;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

async function handleSubjectStudio(request: Request, env: Env, profile: Parameters<typeof requireScope>[0]): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  return json({ data: await subjectStudioSnapshot(env.DB, namespace) });
}

async function handleSubjectDecision(
  request: Request,
  env: Env,
  profile: Parameters<typeof requireScope>[0],
  keyName: string,
  id: string,
  decision: "approve" | "reject" | "later",
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;
  const body = (await readJsonObject(request)) ?? {};
  const namespace = resolveNamespace(profile, body.namespace);
  const revision = expectedRevision(request, body);
  if (!revision) return openAiError("proposal revision or If-Match is required", 428, "precondition_required");
  try {
    if (decision === "approve") {
      const core = await approveSubjectProposal(env.DB, { namespace, id, expectedRevision: revision, actor: keyName });
      return json({ data: core });
    }
    await decideSubjectProposal(env.DB, {
      namespace,
      id,
      expectedRevision: revision,
      decision: decision === "reject" ? "rejected" : "later",
      actor: keyName,
    });
    return json({ data: { id, status: decision === "reject" ? "rejected" : "later" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "subject_proposal_decision_failed";
    const status = message.includes("revision") ? 412 : message.includes("not_found") ? 404 : 409;
    return openAiError(message, status, "subject_core_error");
  }
}

async function handleEpisodicIndex(request: Request, env: Env, profile: Parameters<typeof requireScope>[0]): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;
  const body = (await readJsonObject(request)) ?? {};
  const namespace = resolveNamespace(profile, body.namespace);
  const limit = readPositiveInt(body.limit, 20, 50);
  const result = await indexPendingEpisodic(env, { namespace, limit, includeFailed: body.include_failed === true });
  return json({ data: result, status: await episodicIndexStatus(env.DB, namespace) });
}

async function handleRecallRuns(request: Request, env: Env, profile: Parameters<typeof requireScope>[0]): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const namespaceHash = await sha256Hex(namespace);
  const limit = readPositiveInt(url.searchParams.get("limit"), 20, 100);
  const runs = await env.DB.prepare(
    `SELECT id,current_event_ref,policy_version,index_version,reranker_version,channels_requested_json,
            channels_completed_json,channels_failed_json,available_count,injected_count,injection_bytes,
            started_at_utc,completed_at_utc
     FROM recall_runs WHERE namespace_hash=? ORDER BY started_at_utc DESC LIMIT ?`
  ).bind(namespaceHash, limit).all<Record<string, unknown>>();
  const runIds = (runs.results ?? []).map((run) => String(run.id));
  let candidates: Array<Record<string, unknown>> = [];
  if (runIds.length > 0) {
    const placeholders = runIds.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT c.*,coalesce(m.content,msg.content) AS content,coalesce(m.type,'episodic') AS resolved_type,
              p.canonical_message_id,p.occurred_at_utc
       FROM recall_candidate_traces c
       LEFT JOIN memories m ON m.id=c.candidate_ref AND m.namespace=?
       LEFT JOIN episodic_projections p ON p.id=c.candidate_ref AND p.namespace=?
       LEFT JOIN messages msg ON msg.id=p.canonical_message_id
       WHERE c.run_id IN (${placeholders}) ORDER BY c.created_at DESC,c.final_rank ASC`
    ).bind(namespace, namespace, ...runIds).all<Record<string, unknown>>();
    candidates = result.results ?? [];
  }
  return json({ data: { runs: runs.results ?? [], candidates, episodic_index: await episodicIndexStatus(env.DB, namespace) } });
}

async function handleExpectedProbe(request: Request, env: Env, profile: Parameters<typeof requireScope>[0]): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;
  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);
  const query = readString(body.query);
  const expectedText = readString(body.expected_text) || query;
  if (!query || !expectedText) return openAiError("query is required", 400);
  const namespace = resolveNamespace(profile, body.namespace);
  const like = `%${expectedText.replace(/[\\%_]/g, "\\$&")}%`;
  const canonical = await env.DB.prepare(
    `SELECT m.id,p.id AS projection_id,p.vector_status,p.vector_error_code
     FROM messages m LEFT JOIN episodic_projections p ON p.canonical_message_id=m.id
     WHERE m.namespace=? AND m.role IN ('user','assistant')
       AND m.publication_state IN ('source_received','delivered') AND m.content LIKE ? ESCAPE '\\'
     ORDER BY m.created_at DESC LIMIT 20`
  ).bind(namespace, like).all<{ id: string; projection_id: string | null; vector_status: string | null; vector_error_code: string | null }>();
  const canonicalRows = canonical.results ?? [];
  if (canonicalRows.length === 0) {
    return json({ data: { status: "canonical_absent", query, expected_text: expectedText, canonical_count: 0 } });
  }
  const projectionIds = canonicalRows.flatMap((row) => row.projection_id ? [row.projection_id] : []);
  if (projectionIds.length === 0) {
    return json({ data: { status: "projection_missing", query, expected_text: expectedText, canonical_count: canonicalRows.length } });
  }
  const recall = await runRecall(env, {
    namespace,
    query,
    k: 6,
    request_id: `probe:${crypto.randomUUID()}`,
    current_event_ref: "probe",
  });
  const hit = recall.hits.find((candidate) => projectionIds.includes(candidate.id));
  const trace = recall.trace?.candidates.find((candidate) => projectionIds.includes(candidate.candidate_ref));
  const failed = canonicalRows.filter((row) => row.vector_status === "failed");
  const pending = canonicalRows.filter((row) => row.vector_status === "pending");
  const status = hit ? "candidate_selected"
    : trace?.decision === "rerank_cut" ? "rerank_cut"
      : trace?.decision === "not_top_n" ? "candidate_pool_cut"
        : failed.length === canonicalRows.length ? "index_failed"
          : pending.length === canonicalRows.length ? "index_pending"
            : trace?.decision ?? "channel_missed";
  return json({
    data: {
      status,
      query,
      expected_text: expectedText,
      canonical_count: canonicalRows.length,
      projection_count: projectionIds.length,
      matched_projection_id: hit?.id ?? null,
      trace: trace ?? null,
      channels: recall.trace?.run ? {
        requested: recall.trace.run.channels_requested,
        completed: recall.trace.run.channels_completed,
        failed: recall.trace.run.channels_failed,
      } : null,
      index: await episodicIndexStatus(env.DB, namespace),
    },
  });
}

async function handleVnext2Inspector(request: Request, env: Env, profile: Parameters<typeof requireScope>[0]): Promise<Response> {
  const memoryScopeError = requireScope(profile, "memory:read");
  if (memoryScopeError) return memoryScopeError;
  const debugScopeError = requireScope(profile, "debug:read");
  if (debugScopeError) return debugScopeError;
  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const namespaceHash = await sha256Hex(namespace);
  const limit = readPositiveInt(url.searchParams.get("limit"), 20, 100);
  return json({ data: await readMemoryVnext2Inspector({ db: env.DB,namespace,namespaceHash,limit }) });
}

export async function handleMemoryIntelligence(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/subject/studio") {
    return handleSubjectStudio(request, env, auth.profile);
  }
  const proposalMatch = /^\/v1\/subject\/proposals\/([^/]+)\/(approve|reject|later)$/.exec(url.pathname);
  if (request.method === "POST" && proposalMatch) {
    return handleSubjectDecision(request, env, auth.profile, auth.keyName, decodeURIComponent(proposalMatch[1]), proposalMatch[2] as "approve" | "reject" | "later");
  }
  if (request.method === "POST" && url.pathname === "/v1/episodic/index") {
    return handleEpisodicIndex(request, env, auth.profile);
  }
  if (request.method === "GET" && url.pathname === "/v1/recall/runs") {
    return handleRecallRuns(request, env, auth.profile);
  }
  if (request.method === "POST" && url.pathname === "/v1/recall/probe") {
    return handleExpectedProbe(request, env, auth.profile);
  }
  if (request.method === "GET" && url.pathname === "/v1/memory/intelligence/vnext2") {
    return handleVnext2Inspector(request, env, auth.profile);
  }
  return openAiError("Not found", 404);
}
