// Operia 记忆库 v2 召回管线 (母帖 #11 第 2/3 步)
// boot: 冷启动包 (L1 摘要 + 昨天日志 + top pinned 珍贵)，输出稳定、确定性排序。
// recall: 每轮动态召回 (黑话词面 → memories 向量 → world_fact → 长尾兜底)，闸三降权。
//
// 召回逻辑优先级 (母帖第三节，非物理摆放):
//   词面命中(黑话) → 核心(L1 摘要 + 命中珍贵) → 重要记忆+世界知识(向量) → 全空才落长尾
//
// 去重三闸:
//   闸一: 珍贵不进每轮 query 召回池，归 boot 固定供给 (这里 recall 不查 precious)。
//   闸二: 注入前与核心层去重 (recall 命中与 boot 内容做文本去重)。
//   闸三: last_injected_at 近期注入过的降权 (不动 importance)。

import {
  getDailyLog,
  listPrecious,
  listGlossary,
  fetchLongtailByIds,
  matchGlossary,
  markPreciousInjected
} from "../../db/v2";
import { searchMemoriesWithProvenance } from "../search";
import type { MemoryApiRecordWithProvenance } from "../search";
import { filterAndCompressMemoriesWithMeta } from "../filter";
import type { MemoryFilterCandidateTrace, MemoryFilterMeta } from "../filter";
import { createEmbedding } from "../embedding";
import type { Env } from "../../types";
import { sha256Hex } from "../../utils/hash";
import { hydrateEpisodicCandidates, searchEpisodicHybrid } from "../episodic";
import type { EpisodicCandidate } from "../episodic";
import {
  decideDynamicRecallNeed,
  persistDynamicRecallDecision,
  persistDynamicRecallOutcome,
  runVNext2ReadPath,
  type DynamicRecallDecision,
  type VNextReadPathResult,
} from "../vnext/recallRuntime";

// --- 开关 ---

export function isV2Enabled(env: Env): boolean {
  return env.MEMORY_LIFECYCLE_ENABLED !== "false";
}

// 闸三: 近期注入过的软排序系数。资格地板始终使用衰减前分数。
// 窗口/系数做成 env 可配，不配走默认 (30 分钟 / 0.85)。
function injectDecayWindowMs(env: Env): number {
  const mins = Number(env.MEMORY_INJECT_DECAY_WINDOW_MIN);
  return Number.isFinite(mins) && mins > 0 ? mins * 60 * 1000 : 30 * 60 * 1000;
}
function injectDecayFactor(env: Env): number {
  const f = Number(env.MEMORY_INJECT_DECAY_FACTOR);
  return Number.isFinite(f) && f >= 0.75 && f <= 1 ? f : 0.85;
}

const RECALL_POLICY_VERSION = "recall-v2-whitebox-p0.2-progressive";
const RECALL_INDEX_VERSION = "legacy-vectorize-d1-v2";
const RRF_K = 60;

function readFinalTopK(env: Env, override?: number): number {
  const raw = override ?? Number(env.MEMORY_FILTER_MAX_OUTPUT ?? 3);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 20) : 3;
}

function readCandidatePoolSize(env: Env, finalTopK: number): number {
  const raw = Number(env.MEMORY_FILTER_MAX_CANDIDATES ?? 12);
  const configured = Number.isFinite(raw) ? Math.floor(raw) : 12;
  return Math.min(Math.max(configured, finalTopK, 1), 50);
}

function readRecallMinScore(env: Env, override?: number): number {
  const raw = override ?? Number(env.RECALL_MIN_SCORE ?? 0.15);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.15;
}

function readSemanticSlots(env: Env, finalTopK: number): number {
  const raw = Number(env.MEMORY_RECALL_SEMANTIC_SLOTS ?? Math.ceil(finalTopK / 2));
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), finalTopK) : Math.ceil(finalTopK / 2);
}

function semanticMemoryLayer(type: string): 1 | 2 {
  return ["event", "relationship", "decision"].includes(type) ? 2 : 1;
}

function decayForLastInjected(
  lastInjectedAt: string | null,
  windowMs: number,
  factor: number,
  now = Date.now()
): number {
  if (!lastInjectedAt) return 1;
  const ts = Date.parse(lastInjectedAt);
  if (!Number.isFinite(ts)) return 1;
  if (now - ts > windowMs) return 1;
  return factor;
}

function filterDecision(trace: MemoryFilterCandidateTrace): RecallDecision {
  if (trace.decision === "selected") return "not_top_n";
  return trace.decision;
}

// =====================================================================
// 闸二: 注入前与核心层去重。
// 核心层 = boot 包里的 precious(L3)。
// 召回命中如果跟核心层内容高度重叠, 模型这轮已知道, 不重复喂。
// 用归一化文本的包含/重叠检测: 召回命中内容被核心层文本包含,
// 或与核心层某条 Jaccard 词集重叠超阈值, 则判为重复, 降到 0 分剔除。
// =====================================================================

const DEDUP_OVERLAP_THRESHOLD = 0.6; // 词集重叠率上限, 超过判重复

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(s: string): Set<string> {
  // 简单分词: 英文按非字母数字拆, 中文按字拆 (BM25 级别不需要精细)。
  const norm = normalizeText(s);
  const tokens = new Set<string>();
  for (const word of norm.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    if (word.length >= 2) tokens.add(word);
  }
  // 中文逐字
  for (const ch of norm) {
    if (/[\u4e00-\u9fff]/.test(ch)) tokens.add(ch);
  }
  return tokens;
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

// 构建核心层指纹: precious 的文本词集, 供闸二比对。
export interface CoreFingerprint {
  preciousTokens: Set<string>[];
}

export function buildCoreFingerprint(preciousContents: string[]): CoreFingerprint {
  return {
    preciousTokens: preciousContents.filter(Boolean).map(tokenize)
  };
}

// 判断一条召回命中是否与核心层重复。
function isDuplicateWithCore(content: string, core: CoreFingerprint): boolean {
  const hitTokens = tokenize(content);
  if (hitTokens.size === 0) return false;

  for (const pt of core.preciousTokens) {
    if (jaccardOverlap(hitTokens, pt) >= DEDUP_OVERLAP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// =====================================================================
// boot: 冷启动包，输出稳定 + 确定性排序
// SessionStart 调一次。客户端可塞进缓存前缀吃命中 (母帖第二节)。
// =====================================================================

export interface BootPackage {
  yesterday_log: { date: string; title: string; summary: string } | null;
  precious: Array<{ id: string; content: string; created_at: string }>;
  glossary: Array<{ term: string; definition: string; aliases: string[] }>;
  schema_version: string;
  cache_prefix_end: true;
}

const BOOT_SCHEMA_VERSION = "v3-0";

export async function buildBootPackage(
  env: Env,
  input: { namespace: string }
): Promise<BootPackage> {
  const preciousRows = await listPrecious(env.DB, {
    namespace: input.namespace,
    limit: 20
  });

  // boot 要全量 glossary (冷启动把所有黑话定义塞进)，不是 query 命中。
  const allGlossary = await listAllGlossary(env, input.namespace);

  // 确定性排序: precious 按 created_at 升序 (老的在前，稳定的在前)。
  const precious = preciousRows
    .map((r) => ({ id: r.id, content: r.content, created_at: r.created_at }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // 闸三对 precious 也记账: boot 被调 = precious 被注入, 记 last_injected_at。
  // 防的是某条 precious 因太相关而被 recall 侧逻辑反复塞 (虽然闸一已把 precious 移出
  // recall 池, 但 boot 每次冷启动都调, 记账让 precious 的注入节奏也可观测、可衰减)。
  if (precious.length > 0) {
    await markPreciousInjected(env.DB, {
      namespace: input.namespace,
      ids: precious.map((p) => p.id)
    });
  }

  // 昨天的日志 (dream 产出)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayLabel = new Intl.DateTimeFormat("en-CA", {
    timeZone: "<YOUR_TIMEZONE>",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(yesterday);
  const dailyLog = await getDailyLog(env.DB, { namespace: input.namespace, date: yesterdayLabel });

  return {
    yesterday_log: dailyLog ? { date: dailyLog.date, title: dailyLog.title, summary: dailyLog.summary } : null,
    precious,
    glossary: allGlossary,
    schema_version: BOOT_SCHEMA_VERSION,
    cache_prefix_end: true
  };
}

// 服务端自建核心层指纹: 读 precious, 供闸二在调用方没传指纹时用。
async function buildCoreFingerprintFromDb(
  env: Env,
  namespace: string
): Promise<CoreFingerprint> {
  const preciousRows = await listPrecious(env.DB, { namespace, limit: 50 });
  return buildCoreFingerprint(preciousRows.map((r) => r.content));
}

async function listAllGlossary(
  env: Env,
  namespace: string
): Promise<Array<{ term: string; definition: string; aliases: string[] }>> {
  const rows = await listGlossary(env.DB, { namespace });
  return rows
    .map((r) => {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(r.aliases ?? "[]") as unknown;
        if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        aliases = [];
      }
      return { term: r.term, definition: r.definition, aliases };
    })
    .sort((a, b) => a.term.localeCompare(b.term));
}

// =====================================================================
// recall: 每轮动态召回
// UserPromptSubmit 调。闸一: 不查 precious (归 boot)。
// =====================================================================

export interface RecallInput {
  namespace: string;
  query: string;
  k?: number;
  types?: string[];
  min_score?: number;
  request_id?: string;
  current_event_ref?: string;
  // 闸二: 调用方传 boot 包的核心层指纹, recall 命中与之去重。
  // 不传则跳过闸二 (向后兼容第 2 步行为)。
  core_fingerprint?: CoreFingerprint;
  dynamic_recall_context?: {
    live_context_sufficient?: boolean;
    explicit_private_history_dependency?: boolean;
    requested_personalization?: boolean;
  };
  /** Chat assembly owns the final outcome when it needs the actual MB1 packet. */
  defer_dynamic_outcome?: boolean;
  /** Keep the observational vNext read off the authoritative recall deadline. */
  defer_vnext_shadow?: boolean;
}

export interface VNextReadShadowInput {
  runId: string;
  namespace: string;
  namespaceHash: string;
  query: string;
  queryHash: string;
  startedAtUtc: string;
  factSeeds: Array<{ legacyMemoryId: string; retrievalScore: number; retrievalRank: number }>;
  episodicSeeds: EpisodicCandidate[];
  maxSelected: number;
  shadowOnly: true;
}

export interface RecallHit {
  id: string;
  content: string;
  type: string;
  score: number;
  source_layer: "glossary" | "memory" | "episodic" | "longtail";
  // 闸二标记: 被核心层去重剔除的命中, 供调试/面板观察。
  deduped_against_core?: boolean;
  // --- provenance (additive)：命中出处，供面板观察清 v2 存量 vs legacy 残留。 ---
  // D1 memories.source 列值 (extract/dream/judge/doctor_rebuild_v2 等)；longtail 固定 "longtail"；无法确定为 null。
  source: string | null;
  // 是否有有效 D1 记录背书 (排除已删除/legacy 孤儿向量)。longtail 命中本来就来自 D1，恒为 true。
  backed: boolean;
  // 与 source_layer 中 memory/longtail 对应，供面板按类型统计 (不含 glossary，glossary 命中走单独的 glossary_hits)。
  kind: "memory" | "episodic" | "longtail";
}

export type RecallDecision =
  | "injected"
  | "not_top_n"
  | "rerank_cut"
  | "duplicate"
  | "current_version_won"
  | "historical_only"
  | "scope_mismatch"
  | "privacy_boundary"
  | "repeat_suppressed"
  | "below_threshold"
  | "token_budget"
  | "source_unavailable";

export type RecallCandidatePendingDecision = RecallDecision | "selected_for_assembly";

export interface RecallCandidateTrace {
  candidate_ref: string;
  source_layer: "current_fact" | "episodic";
  channel_ranks: Record<string, number | null>;
  channel_scores: Record<string, number | null>;
  rrf_score: number;
  score_components: Record<string, number>;
  pre_rerank_rank: number | null;
  rerank_score: number | null;
  post_rerank_rank: number | null;
  fact_key_hash: string | null;
  fact_status: string | null;
  duplicate_group: string | null;
  hydrated_event_refs: string[];
  final_rank: number | null;
  decision: RecallCandidatePendingDecision;
  decision_stage: string;
}

export interface RecallTraceBundle {
  run: {
    id: string;
    request_id_hash: string;
    namespace_hash: string;
    current_event_ref: string;
    query_hash: string;
    policy_version: string;
    index_version: string;
    reranker_version: string | null;
    channels_requested: string[];
    channels_completed: string[];
    channels_failed: Array<{ channel: string; code: string }>;
    available_count: number;
    injected_count: number;
    injection_bytes: number;
    started_at_utc: string;
    completed_at_utc: string;
  };
  candidates: RecallCandidateTrace[];
}

export interface RecallResult {
  hits: RecallHit[];
  glossary_hits: Array<{ term: string; definition: string }>;
  trace: RecallTraceBundle | null;
  /** In-process handoff to the Assembler; API handlers must not serialize it. */
  vnext_runtime?: VNextReadPathResult | null;
  /** Observational vNext work that a request handler must schedule with waitUntil. */
  vnext_shadow_input?: VNextReadShadowInput | null;
  /** In-process handoff used to bind the final outcome to the rendered packet. */
  dynamic_need_runtime?: DynamicRecallDecision | null;
  meta: {
    decayed_ids: string[];
    deduped_ids: string[];
    floored_ids: string[];
    floored_count: number;
    min_score: number;
    total: number;
    // --- provenance (additive) ---
    // 本次响应里没有 D1 背书的命中数 (RECALL_REQUIRE_D1_BACKING=true 时应恒为 0，因为已被丢弃而非透传)
    unbacked_count: number;
    // RECALL_REQUIRE_D1_BACKING=true 时，因严格过滤被丢弃的孤儿向量命中数
    unbacked_dropped: number;
    policy_version: string;
    candidate_pool_size: number;
    recently_injected_ids: string[];
    filter: MemoryFilterMeta | null;
    channel: "vector" | "legacy_text_fallback" | "none";
    semantic_slots: number;
    selected_semantic_count: number;
    selected_episodic_count: number;
    dynamic_recall?: {
      decision_id: string;
      need: DynamicRecallDecision["need"];
      mode: "SHADOW" | "ENFORCED";
      outcome: "BYPASSED" | "FOUND" | "EMPTY" | "MISS" | "DEGRADED";
      reason_codes: string[];
      query_lanes: string[];
      deterministic_floor_required: boolean;
    } | null;
    vnext_read?: {
      run_id: string;
      query_plan_hash: string;
      requested_state_view: VNextReadPathResult["requestedStateView"];
      seed_count: number;
      expanded_count: number;
      selected_count: number;
      complete_bundle_count: number;
      artifact_hash: string;
      mode: "SHADOW";
    } | null;
  };
}

export async function runRecall(env: Env, input: RecallInput): Promise<RecallResult> {
  const query = input.query.trim();
  if (!query) {
    const minScore = readRecallMinScore(env, input.min_score);
    return {
      hits: [],
      glossary_hits: [],
      trace: null,
      meta: {
        decayed_ids: [], deduped_ids: [], floored_ids: [], floored_count: 0, min_score: minScore, total: 0,
        unbacked_count: 0, unbacked_dropped: 0,
        policy_version: RECALL_POLICY_VERSION,
        candidate_pool_size: 0,
        recently_injected_ids: [],
        filter: null,
        channel: "none",
        semantic_slots: 0,
        selected_semantic_count: 0,
        selected_episodic_count: 0,
      }
    };
  }
  const minScore = readRecallMinScore(env, input.min_score);
  const startedAtUtc = new Date().toISOString();
  const runId = crypto.randomUUID();
  const requestId = input.request_id?.trim() || runId;
  const requestIdHash = await sha256Hex(requestId);
  const namespaceHash = await sha256Hex(input.namespace);
  const queryHash = await sha256Hex(query);
  const dynamicNeedMode: "SHADOW" | "ENFORCED" | null = env.MEMORY_DYNAMIC_NEED_ENFORCE_ENABLED === "true"
    ? "ENFORCED"
    : env.MEMORY_DYNAMIC_NEED_SHADOW_ENABLED === "true"
      ? "SHADOW"
      : null;
  const dynamicDecision = dynamicNeedMode ? await decideDynamicRecallNeed({
    currentRequest: query,
    requestIdentity: requestIdHash,
    liveContextSufficient: input.dynamic_recall_context?.live_context_sufficient === true,
    explicitPrivateHistoryDependency: input.dynamic_recall_context?.explicit_private_history_dependency === true,
    requestedPersonalization: input.dynamic_recall_context?.requested_personalization === true,
  }) : null;
  if (dynamicDecision && dynamicNeedMode) {
    try {
      await persistDynamicRecallDecision({
        db: env.DB,decision: dynamicDecision,requestIdHash,namespaceHash,queryHash,
        liveContextSufficient: input.dynamic_recall_context?.live_context_sufficient === true,
        mode: dynamicNeedMode,createdAtUtc: startedAtUtc,
      });
    } catch (error) {
      if (dynamicNeedMode === "ENFORCED") throw error;
      console.error("dynamic recall need shadow persistence failed", {
        code: error instanceof Error ? error.message.slice(0,120) : "dynamic_need_shadow_persist_failed",
      });
    }
  }
  if (dynamicDecision?.need === "BYPASS" && dynamicNeedMode === "ENFORCED") {
    await persistDynamicRecallOutcome({
      db: env.DB,decision: dynamicDecision,status: "BYPASSED",candidateCount: 0,selectedGroupCount: 0,
      packetHash: null,reasonCode: dynamicDecision.reasonCodes[0] ?? "BYPASS",elapsedMs: Date.now() - Date.parse(startedAtUtc),
      createdAtUtc: new Date().toISOString(),
    });
    return {
      hits: [],glossary_hits: [],
      trace: {
        run: {
          id: runId,request_id_hash: requestIdHash,namespace_hash: namespaceHash,
          current_event_ref: input.current_event_ref?.trim() || "unavailable",query_hash: queryHash,
          policy_version: RECALL_POLICY_VERSION,index_version: "dynamic-need-bypass",reranker_version: null,
          channels_requested: [],channels_completed: [],channels_failed: [],available_count: 0,injected_count: 0,
          injection_bytes: 0,started_at_utc: startedAtUtc,completed_at_utc: new Date().toISOString(),
        },
        candidates: [],
      },
      meta: {
        decayed_ids: [],deduped_ids: [],floored_ids: [],floored_count: 0,min_score: minScore,total: 0,
        unbacked_count: 0,unbacked_dropped: 0,policy_version: RECALL_POLICY_VERSION,candidate_pool_size: 0,
        recently_injected_ids: [],filter: null,channel: "none",semantic_slots: 0,
        selected_semantic_count: 0,selected_episodic_count: 0,
        dynamic_recall: {
          decision_id: dynamicDecision.decisionId,need: dynamicDecision.need,mode: dynamicNeedMode,
          outcome: "BYPASSED",reason_codes: dynamicDecision.reasonCodes,query_lanes: dynamicDecision.queryLanes,
          deterministic_floor_required: dynamicDecision.deterministicFloorRequired,
        },
      },
    };
  }

  // 1. 黑话词面命中 (L5，不进向量，走词面)
  const [glossaryRows, queryVector] = await Promise.all([
    matchGlossary(env.DB, { namespace: input.namespace, query }),
    createEmbedding(env, query).catch((error) => {
      console.error("recall shared embedding failed", {
        code: error instanceof Error && error.message ? error.message.slice(0, 120) : "embedding_failed",
      });
      return null;
    }),
  ]);
  const glossaryHits = glossaryRows.map((r) => ({ term: r.term, definition: r.definition }));

  // 2. memories 向量召回 (L4 + L6 world_fact，active only) 与 verbatim
  // episodic 三通道并行。episodic 的 FTS/exact floor 不依赖模型或 embedding。
  //    闸一: 不查 precious。precious 归 boot 固定供给, 不进每轮 query 召回池。
  const k = readFinalTopK(env, input.k);
  const candidatePoolSize = readCandidatePoolSize(env, k);
  const [searchResult, episodicSearch] = await Promise.all([
    searchMemoriesWithProvenance(env, {
      namespace: input.namespace,
      query,
      types: input.types,
      topK: candidatePoolSize,
      mark_recalled: false,
      query_vector: queryVector,
    }),
    env.MEMORY_EPISODIC_READ_ENABLED === "false"
      ? Promise.resolve({ candidates: [] as EpisodicCandidate[], channels_requested: [], channels_completed: [], channels_failed: [], index_version: "episodic-disabled" })
      : searchEpisodicHybrid(env, {
          namespace: input.namespace,
          query,
          currentEventRef: input.current_event_ref,
          query_vector: queryVector,
        }),
  ]);
  const rawMemories: MemoryApiRecordWithProvenance[] = searchResult.records;
  // 严格模式下 (RECALL_REQUIRE_D1_BACKING=true) 已经在 search 层丢弃的孤儿向量命中数。
  const unbackedDropped = searchResult.unbacked_dropped;

  // 2.5. vNext.2 starts from raw lane seeds, before legacy filtering and
  // Top-K. Chat defers observational work so it cannot consume the legacy
  // recall deadline; an explicitly enabled MB1 injection remains fail-closed.
  let vnextRead: VNextReadPathResult | null = null;
  let vnextShadowInput: VNextReadShadowInput | null = null;
  if (env.MEMORY_VNEXT_READ_SHADOW_ENABLED === "true") {
    const factLaneEnabled = !dynamicDecision || dynamicDecision.queryLanes.includes("fact_revision");
    const episodicLaneEnabled = !dynamicDecision || dynamicDecision.queryLanes.includes("episodic");
    const vnextInput: VNextReadShadowInput = {
      runId,namespace: input.namespace,namespaceHash,query,queryHash,startedAtUtc,
        factSeeds: factLaneEnabled ? rawMemories.map((memory,index) => ({
          legacyMemoryId: memory.id,retrievalScore: memory.score ?? 0,retrievalRank: index + 1,
        })) : [],
        episodicSeeds: episodicLaneEnabled ? episodicSearch.candidates : [],maxSelected: k,shadowOnly: true,
    };
    if (input.defer_vnext_shadow && env.MEMORY_MB1_INJECT_ENABLED !== "true") {
      vnextShadowInput = vnextInput;
    } else {
      try {
        vnextRead = await runVNext2ReadPath({ env,...vnextInput });
      } catch (error) {
        if (env.MEMORY_MB1_INJECT_ENABLED === "true") throw error;
        console.error("memory vnext2 read shadow failed", {
          code: error instanceof Error ? error.message.slice(0,160) : "vnext2_read_shadow_failed",
          run_id: runId,
        });
      }
    }
  }

  // Legacy carrier remains unchanged until the MB1 injection gate is enabled.
  const filtered = await filterAndCompressMemoriesWithMeta(env, {
    query,memories: rawMemories,max_output: k,
  });
  const memories = filtered.data as MemoryApiRecordWithProvenance[];
  const hydratedEpisodic = await hydrateEpisodicCandidates(
    env.DB,
    input.namespace,
    episodicSearch.candidates.slice(0, 6),
  );

  // 3. 闸三: last_injected_at 近期注入过的降权 (不动 importance)
  const windowMs = injectDecayWindowMs(env);
  const factor = injectDecayFactor(env);
  const decayedIds: string[] = [];
  const baseScoreById = new Map<string, number>();
  const repeatFactorById = new Map<string, number>();
  const scored: RecallHit[] = memories.map((m) => {
    const decay = decayForLastInjected(m.last_injected_at ?? null, windowMs, factor);
    if (decay < 1) decayedIds.push(m.id);
    const baseScore = m.score ?? 0;
    baseScoreById.set(m.id, baseScore);
    repeatFactorById.set(m.id, decay);
    return {
      id: m.id,
      content: m.content,
      type: m.type,
      score: baseScore * decay,
      source_layer: "memory" as const,
      source: m.source ?? null,
      backed: m.backed,
      kind: "memory" as const
    };
  });
  const episodicScored: RecallHit[] = (env.MEMORY_EPISODIC_INJECT_ENABLED === "false" ? [] : hydratedEpisodic).map((candidate) => {
    const score = Math.min(1, 0.45 + candidate.rrf_score * 12 + (candidate.exact_match ? 0.25 : 0));
    baseScoreById.set(candidate.id, score);
    repeatFactorById.set(candidate.id, 1);
    return {
      id: candidate.id,
      content: candidate.content,
      type: "episodic",
      score,
      source_layer: "episodic" as const,
      source: "canonical_message",
      backed: true,
      kind: "episodic" as const,
    };
  });

  // 4. 闸二: 注入前与核心层去重。
  //    调用方传 core_fingerprint (boot 包的 precious 文本指纹)；
  //    不传则服务端自己建 (读 precious), 保证闸二默认生效。
  //    recall 命中与之高度重叠的降到 0 分剔除, 不重复喂。
  const dedupedIds: string[] = [];
  const core = input.core_fingerprint ?? (await buildCoreFingerprintFromDb(env, input.namespace));
  const recallPool = [...scored, ...episodicScored]
    .sort((left, right) => right.score - left.score);
  const afterDedup = core
    ? recallPool.filter((h) => {
        if (isDuplicateWithCore(h.content, core)) {
          dedupedIds.push(h.id);
          return false;
        }
        return true;
      })
    : recallPool;

  // 5. 长尾兜底 (L6): 只有 glossary + memories 闸二后全空才落 longtail。
  //    母帖逻辑优先级"全空才落长尾"——glossary 命中也算"前面非空"，
  //    有确定词面答案时不再追兜底，避免把 longtail 混进已有黑话答案的请求。
  let longtailHits: RecallHit[] = [];
  if (afterDedup.length === 0 && glossaryHits.length === 0) {
    longtailHits = await recallLongtailFallback(env, input, queryVector);
    for (const hit of longtailHits) {
      baseScoreById.set(hit.id, hit.score);
      repeatFactorById.set(hit.id, 1);
    }
  }

  const beforeFloor = [...afterDedup, ...longtailHits]
    .sort((a, b) => b.score - a.score);
  const flooredIds: string[] = [];
  const eligibleHits = beforeFloor.filter((hit) => {
      // Continuous-turn repeat decay is a soft ordering component only. The
      // eligibility floor always uses the pre-decay score, so a relevant hit
      // cannot disappear via the old `0.15 decay × 0.15 floor` interaction.
      if ((baseScoreById.get(hit.id) ?? hit.score) >= minScore) return true;
      flooredIds.push(hit.id);
      return false;
    });
  const semanticSlots = readSemanticSlots(env, k);
  const semanticHits = eligibleHits.filter((hit) => hit.kind === "memory");
  const episodicHits = eligibleHits.filter((hit) => hit.kind !== "memory");
  const selectedSemantic = semanticHits.slice(0, semanticSlots);
  const selectedEpisodic = episodicHits.slice(0, k - selectedSemantic.length);
  const remainingSlots = k - selectedSemantic.length - selectedEpisodic.length;
  const allHits = [
    ...selectedSemantic,
    ...selectedEpisodic,
    ...semanticHits.slice(semanticSlots, semanticSlots + remainingSlots),
  ];

  const finalRankById = new Map(allHits.map((hit, index) => [hit.id, index + 1]));
  const filterTraceById = new Map(filtered.candidate_trace.map((item) => [item.id, item]));
  const retrievalChannel = searchResult.channel.selected;
  const candidateTraces: RecallCandidateTrace[] = await Promise.all(rawMemories.map(async (memory, index) => {
    const item = filterTraceById.get(memory.id) ?? {
      id: memory.id,
      input_rank: index + 1,
      prepared_rank: null,
      rerank_score: null,
      post_rerank_rank: null,
      decision: "source_unavailable" as const,
      decision_stage: "prepare" as const,
    };
    const finalRank = finalRankById.get(memory.id) ?? null;
    let decision: RecallCandidatePendingDecision;
    let decisionStage: string = item.decision_stage;
    if (item.decision !== "selected") {
      decision = filterDecision(item);
    } else if (dedupedIds.includes(memory.id)) {
      decision = "duplicate";
      decisionStage = "core_dedup";
    } else if (flooredIds.includes(memory.id)) {
      decision = "below_threshold";
      decisionStage = "final_floor";
    } else if (finalRank !== null) {
      decision = "selected_for_assembly";
      decisionStage = "final_selection";
    } else {
      decision = "not_top_n";
      decisionStage = "final_top_n";
    }
    const retrievalScore = typeof memory.score === "number" ? memory.score : 0;
    const rankingScore = baseScoreById.get(memory.id) ?? retrievalScore;
    const repeatFactor = repeatFactorById.get(memory.id) ?? 1;
    return {
      candidate_ref: memory.id,
      source_layer: "current_fact",
      channel_ranks: { [retrievalChannel]: index + 1 },
      channel_scores: { [retrievalChannel]: retrievalScore },
      rrf_score: 1 / (RRF_K + index + 1),
      score_components: {
        retrieval_score: retrievalScore,
        repeat_factor: repeatFactor,
        memory_layer: semanticMemoryLayer(memory.type),
        final_score: rankingScore * repeatFactor,
      },
      pre_rerank_rank: item.prepared_rank,
      rerank_score: item.rerank_score,
      post_rerank_rank: item.post_rerank_rank,
      fact_key_hash: memory.fact_key ? await sha256Hex(memory.fact_key) : null,
      fact_status: memory.fact_key ? memory.status : null,
      duplicate_group: dedupedIds.includes(memory.id) ? "persona_precious_core" : null,
      hydrated_event_refs: [],
      final_rank: finalRank,
      decision,
      decision_stage: decisionStage,
    };
  }));
  const hydratedById = new Map(hydratedEpisodic.map((candidate) => [candidate.id, candidate]));
  for (const rawCandidate of episodicSearch.candidates) {
    const hydratedCandidate = hydratedById.get(rawCandidate.id);
    const candidate = hydratedCandidate ?? rawCandidate;
    const finalRank = finalRankById.get(candidate.id) ?? null;
    const injectionDisabled = env.MEMORY_EPISODIC_INJECT_ENABLED === "false";
    const hydrationCut = !hydratedById.has(candidate.id);
    const decision = injectionDisabled ? "not_top_n" as const
      : hydrationCut ? "not_top_n" as const
      : dedupedIds.includes(candidate.id) ? "duplicate" as const
      : flooredIds.includes(candidate.id) ? "below_threshold" as const
        : finalRank !== null ? "selected_for_assembly" as const : "not_top_n" as const;
    candidateTraces.push({
      candidate_ref: candidate.id,
      source_layer: "episodic",
      channel_ranks: candidate.channel_ranks,
      channel_scores: candidate.channel_scores,
      rrf_score: candidate.rrf_score,
      score_components: {
        rrf_score: candidate.rrf_score,
        exact_boost: candidate.exact_match ? 0.25 : 0,
        memory_layer: 0,
        final_score: baseScoreById.get(candidate.id) ?? 0,
      },
      pre_rerank_rank: null,
      rerank_score: null,
      post_rerank_rank: null,
      fact_key_hash: null,
      fact_status: null,
      duplicate_group: dedupedIds.includes(candidate.id) ? "persona_precious_core" : null,
      hydrated_event_refs: hydratedCandidate?.hydrated_event_refs ?? [],
      final_rank: finalRank,
      decision,
      decision_stage: injectionDisabled ? "episodic_injection_disabled"
        : hydrationCut ? "hydration_budget"
        : dedupedIds.includes(candidate.id) ? "core_dedup"
        : flooredIds.includes(candidate.id) ? "final_floor"
          : finalRank !== null ? "final_selection" : "final_top_n",
    });
  }
  for (const [index, hit] of longtailHits.entries()) {
    const finalRank = finalRankById.get(hit.id) ?? null;
    candidateTraces.push({
      candidate_ref: hit.id,
      source_layer: "episodic",
      channel_ranks: { longtail: index + 1 },
      channel_scores: { longtail: hit.score },
      rrf_score: 1 / (RRF_K + index + 1),
      score_components: { longtail_score: hit.score, repeat_factor: 1, memory_layer: 0, final_score: hit.score },
      pre_rerank_rank: null,
      rerank_score: null,
      post_rerank_rank: null,
      fact_key_hash: null,
      fact_status: null,
      duplicate_group: null,
      hydrated_event_refs: [],
      final_rank: finalRank,
      decision: flooredIds.includes(hit.id) ? "below_threshold"
        : finalRank !== null ? "selected_for_assembly" : "not_top_n",
      decision_stage: flooredIds.includes(hit.id) ? "final_floor"
        : finalRank !== null ? "final_selection" : "final_top_n",
    });
  }

  const vectorFailed = searchResult.channel.vector_status === "failed";
  const trace: RecallTraceBundle = {
    run: {
      id: runId,
      request_id_hash: requestIdHash,
      namespace_hash: namespaceHash,
      current_event_ref: input.current_event_ref?.trim() || "unavailable",
      query_hash: queryHash,
      policy_version: RECALL_POLICY_VERSION,
      index_version: `${RECALL_INDEX_VERSION}+${episodicSearch.index_version}`,
      reranker_version: filtered.meta.reranker_model ?? filtered.meta.model ?? null,
      channels_requested: ["memory_vector", ...episodicSearch.channels_requested],
      channels_completed: [
        ...(vectorFailed ? [] : ["memory_vector"]),
        ...(searchResult.channel.fallback_used ? ["legacy_text_fallback"] : []),
        ...episodicSearch.channels_completed,
      ],
      channels_failed: [
        ...(vectorFailed ? [{ channel: "memory_vector", code: searchResult.channel.vector_failure_code ?? "vector_failed" }] : []),
        ...episodicSearch.channels_failed,
      ],
      available_count: candidateTraces.length,
      injected_count: 0,
      injection_bytes: 0,
      started_at_utc: startedAtUtc,
      completed_at_utc: new Date().toISOString(),
    },
    candidates: candidateTraces,
  };

  let dynamicOutcome: "FOUND" | "EMPTY" | "MISS" | null = null;
  if (dynamicDecision && dynamicNeedMode) {
    dynamicOutcome = allHits.length > 0 ? "FOUND" : dynamicDecision.need === "REQUIRED" ? "MISS" : "EMPTY";
    const legacyPacketHash = allHits.length > 0
      ? await sha256Hex(JSON.stringify(allHits.map((hit) => ({ id: hit.id,content: hit.content,type: hit.type }))))
      : null;
    if (!input.defer_dynamic_outcome) {
      try {
        await persistDynamicRecallOutcome({
          db: env.DB,decision: dynamicDecision,status: dynamicOutcome,candidateCount: candidateTraces.length,
          selectedGroupCount: allHits.length,packetHash: legacyPacketHash,
          reasonCode: dynamicOutcome === "MISS" ? "PRIVATE_HISTORY_EVIDENCE_NOT_FOUND" : dynamicOutcome,
          elapsedMs: Date.now() - Date.parse(startedAtUtc),createdAtUtc: new Date().toISOString(),
        });
      } catch (error) {
        if (dynamicNeedMode === "ENFORCED") throw error;
        console.error("dynamic recall need shadow outcome persistence failed", {
          code: error instanceof Error ? error.message.slice(0,120) : "dynamic_need_shadow_outcome_failed",
        });
      }
    }
  }
  return {
    hits: allHits,
    glossary_hits: glossaryHits,
    trace,
    vnext_runtime: vnextRead,
    vnext_shadow_input: vnextShadowInput,
    dynamic_need_runtime: dynamicDecision,
    meta: {
      decayed_ids: decayedIds,
      deduped_ids: dedupedIds,
      floored_ids: flooredIds,
      floored_count: flooredIds.length,
      min_score: minScore,
      total: allHits.length,
      unbacked_count: allHits.filter((h) => !h.backed).length,
      unbacked_dropped: unbackedDropped,
      policy_version: RECALL_POLICY_VERSION,
      candidate_pool_size: candidatePoolSize,
      recently_injected_ids: decayedIds,
      filter: filtered.meta,
      channel: searchResult.channel.selected,
      semantic_slots: semanticSlots,
      selected_semantic_count: allHits.filter((hit) => hit.kind === "memory").length,
      selected_episodic_count: allHits.filter((hit) => hit.kind === "episodic").length,
      dynamic_recall: dynamicDecision && dynamicNeedMode && dynamicOutcome ? {
        decision_id: dynamicDecision.decisionId,need: dynamicDecision.need,mode: dynamicNeedMode,
        outcome: dynamicOutcome,reason_codes: dynamicDecision.reasonCodes,query_lanes: dynamicDecision.queryLanes,
        deterministic_floor_required: dynamicDecision.deterministicFloorRequired,
      } : null,
      vnext_read: vnextRead ? {
        run_id: vnextRead.runId,query_plan_hash: vnextRead.queryPlanHash,
        requested_state_view: vnextRead.requestedStateView,
        seed_count: vnextRead.expansion.seedCandidateRefs.length,
        expanded_count: vnextRead.expansion.addedCandidates.length,
        selected_count: vnextRead.candidates.filter((item) => item.selected).length,
        complete_bundle_count: vnextRead.evidenceBundles.filter((item) => item.completeness === "complete").length,
        artifact_hash: vnextRead.artifactHash,mode: "SHADOW",
      } : null,
    }
  };
}

// 长尾兜底: 母帖第六节"只在前面全空时兜底"。
// 优先走向量兜底 (Vectorize 按 kind:"longtail" 过滤查),向量索引还没数据时
// 退回 content LIKE 占位。dream 第 4 步填 longtail 向量后, 这条路径自动生效。
async function recallLongtailFallback(env: Env, input: RecallInput, queryVector: number[] | null): Promise<RecallHit[]> {
  const vectorHits = await recallLongtailByVector(env, input, queryVector);
  if (vectorHits.length > 0) return vectorHits;
  return recallLongtailByLike(env, input);
}

// 向量兜底: longtail 在 dream 第 4 步种向量后, 按 kind:"longtail" 召回。
// 向量库没数据 (第 2/3 步) 或 embedding 不可用时返回空, 触发 LIKE 占位分支。
async function recallLongtailByVector(
  env: Env,
  input: RecallInput,
  queryVector: number[] | null,
): Promise<RecallHit[]> {
  if (!env.VECTORIZE || !input.query.trim()) return [];
  const vector = queryVector;
  if (!vector) return [];
  try {
    const result = await env.VECTORIZE.query(vector, {
      topK: 5,
      namespace: input.namespace,
      returnMetadata: true,
      filter: { namespace: input.namespace, kind: "longtail" } as VectorizeVectorMetadataFilter
    } as unknown as Parameters<typeof env.VECTORIZE.query>[1]);
    const matches = (result?.matches ?? []) as Array<{
      id: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>;
    const candidateIds = matches.flatMap((match) => candidateLongtailIds(match));
    const rows = await fetchLongtailByIds(env.DB, { namespace: input.namespace, ids: candidateIds });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    return matches.flatMap((match) => {
      for (const id of candidateLongtailIds(match)) {
        const row = rowById.get(id);
        if (!row) continue;
        return [{
          id: row.id,
          content: row.content,
          type: "longtail",
          score: match.score,
          source_layer: "longtail" as const,
          // longtail 表本身就是 D1 行 (fetchLongtailByIds 命中才走到这里)，不经 memories.source，天然有背书。
          source: "longtail",
          backed: true,
          kind: "longtail" as const
        }];
      }
      return [];
    });
  } catch (error) {
    console.error("v2 longtail vector recall failed", error);
    return [];
  }
}

function candidateLongtailIds(match: { id: string; metadata?: Record<string, unknown> }): string[] {
  const ids: string[] = [];
  const refId = match.metadata?.ref_id;
  if (typeof refId === "string" && refId.trim()) ids.push(refId.trim());
  if (match.id.trim()) {
    ids.push(match.id.trim());
    if (match.id.startsWith("lt_lt_")) ids.push(match.id.slice("lt_".length));
  }
  return [...new Set(ids)];
}

// LIKE 占位兜底: longtail 表第 2/3 步还没向量索引时, 按 content LIKE 子串匹配。
// dream 第 4 步种向量后, recallLongtailByVector 会先命中, 这条路径退居二线。
async function recallLongtailByLike(
  env: Env,
  input: RecallInput
): Promise<RecallHit[]> {
  const like = `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
  let result: D1Result<{ id: string; content: string }>;
  try {
    result = await env.DB
      .prepare(
        `SELECT id, content FROM longtail WHERE namespace = ? AND content LIKE ? ESCAPE '\\'
         ORDER BY ts DESC LIMIT 5`
      )
      .bind(input.namespace, like)
      .all<{ id: string; content: string }>();
  } catch {
    return [];
  }
  return (result.results ?? []).map((r) => ({
    id: r.id,
    content: r.content,
    type: "longtail",
    score: 0.1,
    source_layer: "longtail" as const,
    source: "longtail",
    backed: true,
    kind: "longtail" as const
  }));
}
