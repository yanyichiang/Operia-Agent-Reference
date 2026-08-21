import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { createEmbedding } from "../memory/embedding";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories,
  searchVectorMemories,
  updateVectorMemory,
  vectorMetadataToMemoryRecord
} from "../memory/vectorStore";
import { runVectorDoctor } from "../memory/vectorDoctor";
import { json, openAiError } from "../utils/json";
import type { Env, KeyProfile, MemoryApiRecord } from "../types";
import { readBoolean, readJsonObject, readPositiveInt, readString } from "../utils/request";
import { listMemoriesPage } from "../db/memories";
import { getAnthropicCacheMode, getAnthropicCacheTtls } from "../proxy/anthropicAdapter";

interface CacheHealthRow {
  created_at: string;
  model: string | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  input_tokens: number | null;
  client_system_hash: string | null;
  cache_anchor_block: string | null;
  request_kind: string;
}

interface ModelAgg {
  model: string;
  requests: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
  prompt_token_total?: number;
  cache_read_share?: number;
}

interface HashAgg {
  client_system_hash: string;
  requests: number;
  cache_read_tokens: number;
}

interface RequestKindAgg {
  request_kind: string;
  requests: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CacheHealthSummary {
  total_requests: number;
  cache_hit_requests: number;
  cache_write_requests: number;
  cold_start_requests: number;
  cache_creation_total_tokens: number;
  cache_read_total_tokens: number;
  input_total_tokens: number;
  prompt_token_total: number;
  cache_hit_request_rate: number;
  cache_read_share: number;
  /** @deprecated Use cache_read_share. Kept for older diagnostics clients. */
  cache_read_ratio: number;
  policy: {
    prompt_cache_mode: string | null;
    stable_ttl: "5m" | "1h";
    conversation_ttl: "5m" | "1h";
    gateway_response_cache: "skipped_for_personalized_chat";
    evaluation_window: "24h_or_50_requests";
  };
  by_model: ModelAgg[];
  by_client_system_hash: HashAgg[];
  by_request_kind: RequestKindAgg[];
  recent: CacheHealthRow[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// All queries filter to Anthropic/Claude traffic only.
const ANTHROPIC_FILTER = "(provider = 'anthropic' OR lower(model) LIKE 'anthropic/%' OR lower(model) LIKE '%claude%')";
// Think releases before usage-v2 persisted AI SDK 7's aggregate inputTokens
// into input_tokens, even though cache read/write buckets were also stored.
// Normalize those historical rows so cache-health never double-counts them.
const NORMALIZED_INPUT_SQL = `CASE
  WHEN cache_mode LIKE 'think-0.15-%' AND cache_mode NOT LIKE '%-usage-v2'
    THEN MAX(COALESCE(input_tokens,0)-COALESCE(cache_read_tokens,0)-COALESCE(cache_creation_tokens,0),0)
  ELSE COALESCE(input_tokens,0)
END`;

function canReadDebug(profile: KeyProfile): boolean {
  return profile.scopes.includes("debug:read") || profile.scopes.includes("memory:write");
}

function embeddingNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function readEmbeddingModel(env: Env): string {
  return env.EMBEDDING_MODEL?.trim() || "workers-ai/@cf/baai/bge-m3";
}

function readEmbeddingProvider(model: string): string {
  if (model.startsWith("workers-ai/") || model.startsWith("worker/") || model.startsWith("@cf/")) return "workers-ai";
  return "openai-compatible";
}

function compactMatch(match: VectorizeMatch): Record<string, unknown> {
  const record = vectorMetadataToMemoryRecord(match, match.score);
  return {
    id: match.id,
    vector_namespace: match.namespace,
    score: match.score,
    namespace: record?.namespace,
    ref_id: record?.id,
    type: record?.type,
    content_preview: record?.content.slice(0, 120)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryVectorize(
  env: Env,
  vector: number[],
  namespace: string
): Promise<{ namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] }> {
  if (!env.VECTORIZE) return { namespaced: [], legacy: [] };

  const namespaced = await env.VECTORIZE.query(vector, {
    topK: 10,
    namespace,
    returnMetadata: "all"
  });
  const legacy = await env.VECTORIZE.query(vector, {
    topK: 10,
    returnMetadata: "all"
  });

  return {
    namespaced: namespaced.matches.map(compactMatch),
    legacy: legacy.matches.map(compactMatch)
  };
}

async function waitForVectorMemory(
  env: Env,
  memory: MemoryApiRecord,
  vector: number[],
  namespace: string
): Promise<{
  visible: boolean;
  attempts: number;
  getByPublicId: MemoryApiRecord | null;
  getByVectorId: MemoryApiRecord | null;
  directQuery: { namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] };
  apiSearch: MemoryApiRecord[];
}> {
  let getByPublicId: MemoryApiRecord | null = null;
  let getByVectorId: MemoryApiRecord | null = null;
  let directQuery: { namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] } = {
    namespaced: [],
    legacy: []
  };
  let apiSearch: MemoryApiRecord[] = [];

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    getByPublicId = await getVectorMemory(env, memory.id);
    getByVectorId = memory.vector_id ? await getVectorMemory(env, memory.vector_id) : null;
    directQuery = await queryVectorize(env, vector, namespace);
    apiSearch = await searchVectorMemories(env, {
      namespace,
      query: memory.content,
      topK: 10
    });

    const visible =
      Boolean(getByPublicId || getByVectorId) ||
      directQuery.namespaced.some((match) => match.id === memory.vector_id || match.ref_id === memory.id) ||
      directQuery.legacy.some((match) => match.id === memory.vector_id || match.ref_id === memory.id) ||
      apiSearch.some((item) => item.id === memory.id || item.vector_id === memory.vector_id);

    if (visible || attempt === 8) {
      return { visible, attempts: attempt, getByPublicId, getByVectorId, directQuery, apiSearch };
    }

    await delay(2500);
  }

  return { visible: false, attempts: 8, getByPublicId, getByVectorId, directQuery, apiSearch };
}

export async function handleVectorHealth(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!canReadDebug(auth.profile)) return openAiError("Missing required scope: debug:read", 403);

  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace")?.trim() || auth.profile.namespace;
  const phrase =
    url.searchParams.get("phrase")?.trim() ||
    `vector-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const model = readEmbeddingModel(env);
  const result: Record<string, unknown> = {
    ok: false,
    namespace,
    phrase,
    config: {
      embedding_model: model,
      embedding_provider: readEmbeddingProvider(model),
      embedding_dimensions_config: env.EMBEDDING_DIMENSIONS || null,
      vectorize_index_name: env.VECTORIZE_INDEX_NAME || "memo-kb",
      has_ai_binding: Boolean(env.AI),
      has_vectorize_binding: Boolean(env.VECTORIZE),
      has_cloudflare_api_config: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
    },
    checks: {}
  };

  let created: MemoryApiRecord | null = null;

  try {
    const vector = await createEmbedding(env, phrase);
    if (!vector) {
      result.checks = { embedding: { ok: false, error: "embedding_returned_null" } };
      return json(result, { status: 503 });
    }

    const checks: Record<string, unknown> = {
      embedding: {
        ok: true,
        dimensions: vector.length,
        norm: Number(embeddingNorm(vector).toFixed(6)),
        sample: vector.slice(0, 6)
      }
    };

    if (!env.VECTORIZE) {
      result.checks = { ...checks, vectorize: { ok: false, error: "missing_vectorize_binding" } };
      return json(result, { status: 503 });
    }

    const beforeQuery = await queryVectorize(env, vector, namespace);
    checks.before_query = beforeQuery;

    created = await createVectorMemory(env, {
      namespace,
      type: "debug",
      content: phrase,
      importance: 0.1,
      confidence: 1,
      tags: ["vector-health"],
      source: "debug"
    });
    checks.create = {
      ok: true,
      id: created.id,
      vector_id: created.vector_id
    };

    const visibility = await waitForVectorMemory(env, created, vector, namespace);
    checks.get = {
      attempts: visibility.attempts,
      by_id: Boolean(visibility.getByPublicId),
      by_vector_id: Boolean(visibility.getByVectorId),
      by_id_vector_id: visibility.getByPublicId?.vector_id || null,
      by_vector_id_vector_id: visibility.getByVectorId?.vector_id || null
    };

    checks.after_query = visibility.directQuery;
    checks.api_search = {
      count: visibility.apiSearch.length,
      hits: visibility.apiSearch.map((memory) => ({
        id: memory.id,
        vector_id: memory.vector_id,
        score: memory.score,
        type: memory.type,
        content_preview: memory.content.slice(0, 120)
      }))
    };

    checks.result = {
      ok: visibility.visible,
      reason: visibility.visible ? "canary_visible_after_write" : "canary_not_visible_after_write"
    };

    result.ok = visibility.visible;
    result.checks = checks;
    return json(result, { status: visibility.visible ? 200 : 500 });
  } catch (error) {
    result.checks = {
      ...(typeof result.checks === "object" && result.checks ? result.checks : {}),
      error: error instanceof Error ? error.message : String(error)
    };
    return json(result, { status: 500 });
  } finally {
    if (created?.id) {
      try {
        await deleteVectorMemory(env, created.id);
      } catch (error) {
        console.error("vector_health cleanup failed", error);
      }
    }
  }
}

export async function handleVectorReindex(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = readString(body.namespace) || auth.profile.namespace;
  const limit = readPositiveInt(body.limit, 50, 100);
  const cursor = readString(body.cursor);
  const dryRun = readBoolean(body.dry_run, true);
  const source = readString(body.source) === "d1" ? "d1" : "vectorize";
  const model = readEmbeddingModel(env);

  try {
    const d1Offset = Math.max(Number.parseInt(cursor || "0", 10) || 0, 0);
    const d1Page = source === "d1"
      ? await listMemoriesPage(env.DB, { namespace, status: "active", limit, offset: d1Offset })
      : null;
    const vectorPage = source === "vectorize"
      ? await listVectorMemories(env, { namespace, count: limit, cursor })
      : null;
    const records = d1Page?.records ?? vectorPage?.data ?? [];
    const rewritten: Array<{ id: string; vector_id: string | null; ok: boolean; error?: string }> = [];

    for (const memory of records) {
      if (dryRun) {
        rewritten.push({ id: memory.id, vector_id: memory.vector_id, ok: true });
        continue;
      }

      try {
        const updated = await updateVectorMemory(env, memory.id, {
          type: memory.type,
          content: memory.content,
          summary: memory.summary,
          importance: memory.importance,
          confidence: memory.confidence,
          pinned: Boolean(memory.pinned),
          tags: Array.isArray(memory.tags) ? memory.tags : safeStringArray(memory.tags),
          source: memory.source,
          sourceMessageIds: Array.isArray(memory.source_message_ids)
            ? memory.source_message_ids
            : safeStringArray(memory.source_message_ids),
          expiresAt: memory.expires_at
        });
        rewritten.push({
          id: memory.id,
          vector_id: updated?.vector_id || memory.vector_id,
          ok: Boolean(updated)
        });
      } catch (error) {
        rewritten.push({
          id: memory.id,
          vector_id: memory.vector_id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const failed = rewritten.filter((item) => !item.ok);
    return json({
      ok: failed.length === 0,
      data: {
        namespace,
        embedding_model: model,
        source,
        dry_run: dryRun,
        requested_limit: limit,
        listed_ids: records.length,
        matched_memories: records.length,
        rewritten_count: rewritten.length - failed.length,
        failed_count: failed.length,
        cursor: d1Page?.nextOffset?.toString() ?? vectorPage?.cursor ?? null,
        has_more: d1Page?.hasMore ?? vectorPage?.hasMore ?? false,
        total_count: vectorPage?.totalCount ?? null,
        rewritten,
        failed
      }
    }, { status: failed.length === 0 ? 200 : 500 });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

function safeStringArray(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// 清点 Vectorize/D1 一致性、揪出 v1 残留/孤儿向量，可选一键清掉 (只删 Vectorize，不动 D1)。
// 详见 memory/vectorDoctor.ts 头注释。auth 跟 handleVectorReindex 保持一致
// (要求 memory:write，因为 cleanup=true 会产生真实删除，即便默认是 dry-run 报告)。
export async function handleVectorDoctor(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = readString(body.namespace) || auth.profile.namespace;
  const limit = readPositiveInt(body.limit, 1000, 5000);
  // Defensive: cleanup only runs on an explicit boolean true, never on
  // truthy strings/numbers — accidental cleanup on prod vectors is the
  // one failure mode this endpoint cannot shrug off.
  const cleanup = body.cleanup === true;

  try {
    const report = await runVectorDoctor(env, { namespace, cleanup, limit });
    return json({ ok: true, data: report });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function getCacheHealthSummary(env: Env, windowHours = 24): Promise<CacheHealthSummary> {
    const boundedHours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
    const since = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();

    const summary = await env.DB.prepare(
      `SELECT
         COUNT(*) as total_requests,
         COALESCE(SUM(CASE WHEN cache_read_tokens > 0 THEN 1 ELSE 0 END), 0) as cache_hit_requests,
         COALESCE(SUM(CASE WHEN cache_creation_tokens > 0 THEN 1 ELSE 0 END), 0) as cache_write_requests,
         COALESCE(SUM(CASE WHEN cache_read_tokens = 0 AND cache_creation_tokens > 0 THEN 1 ELSE 0 END), 0) as cold_start_requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_total_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_total_tokens,
         COALESCE(SUM(${NORMALIZED_INPUT_SQL}), 0) as input_total_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}`
    ).bind(since).first<{
      total_requests: number;
      cache_hit_requests: number;
      cache_write_requests: number;
      cold_start_requests: number;
      cache_creation_total_tokens: number;
      cache_read_total_tokens: number;
      input_total_tokens: number;
    }>();

    const totalRequests = summary?.total_requests ?? 0;
    const cacheHitRequests = summary?.cache_hit_requests ?? 0;
    const cacheWriteRequests = summary?.cache_write_requests ?? 0;
    const coldStartRequests = summary?.cold_start_requests ?? 0;
    const cacheCreationTotal = summary?.cache_creation_total_tokens ?? 0;
    const cacheReadTotal = summary?.cache_read_total_tokens ?? 0;
    const inputTotal = summary?.input_total_tokens ?? 0;

    const byModel = await env.DB.prepare(
      `SELECT
         model,
         COUNT(*) as requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(${NORMALIZED_INPUT_SQL}), 0) as input_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       GROUP BY model
       ORDER BY requests DESC`
    ).bind(since).all<ModelAgg>();

    const byHash = await env.DB.prepare(
      `SELECT
         client_system_hash,
         COUNT(*) as requests,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
       FROM usage_logs
       WHERE created_at >= ? AND client_system_hash IS NOT NULL AND ${ANTHROPIC_FILTER}
       GROUP BY client_system_hash
       ORDER BY requests DESC`
    ).bind(since).all<HashAgg>();

    const byRequestKind = await env.DB.prepare(
      `SELECT
         request_kind,
         COUNT(*) as requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(${NORMALIZED_INPUT_SQL}), 0) as input_tokens,
         COALESCE(SUM(output_tokens), 0) as output_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       GROUP BY request_kind
       ORDER BY requests DESC`
    ).bind(since).all<RequestKindAgg>();

    const recent = await env.DB.prepare(
      `SELECT
         created_at, model, cache_read_tokens, cache_creation_tokens,
         ${NORMALIZED_INPUT_SQL} as input_tokens, client_system_hash, cache_anchor_block, request_kind
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       ORDER BY created_at DESC
       LIMIT 10`
    ).bind(since).all<CacheHealthRow>();

    const byModelResults = (byModel.results ?? []).map((row) => {
      const promptTotal = row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens;
      return { ...row, prompt_token_total: promptTotal, cache_read_share: ratio(row.cache_read_tokens, promptTotal) };
    });
    const promptTokenTotal = inputTotal + cacheReadTotal + cacheCreationTotal;
    const ttls = getAnthropicCacheTtls(env);
    return {
      total_requests: totalRequests,
      cache_hit_requests: cacheHitRequests,
      cache_write_requests: cacheWriteRequests,
      cold_start_requests: coldStartRequests,
      cache_creation_total_tokens: cacheCreationTotal,
      cache_read_total_tokens: cacheReadTotal,
      input_total_tokens: inputTotal,
      prompt_token_total: promptTokenTotal,
      cache_hit_request_rate: ratio(cacheHitRequests, totalRequests),
      cache_read_share: ratio(cacheReadTotal, promptTokenTotal),
      cache_read_ratio: ratio(cacheReadTotal, promptTokenTotal),
      policy: {
        prompt_cache_mode: getAnthropicCacheMode(env),
        stable_ttl: ttls.stable,
        conversation_ttl: ttls.conversation,
        gateway_response_cache: "skipped_for_personalized_chat",
        evaluation_window: "24h_or_50_requests",
      },
      by_model: byModelResults,
      by_client_system_hash: byHash.results ?? [],
      by_request_kind: byRequestKind.results ?? [],
      recent: recent.results ?? []
    };
}

export async function handleCacheHealth(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "debug:read");
  if (scopeError) return scopeError;

  try {
    const hours = Number(new URL(request.url).searchParams.get("hours")) || 24;
    const result = await getCacheHealthSummary(env, hours);

    return json(result);
  } catch (error) {
    console.error("cache_health query failed", error);
    return json({ error: "cache_health_query_failed" }, { status: 500 });
  }
}
