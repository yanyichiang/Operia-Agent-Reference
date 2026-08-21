import type { Env } from "../types";
import { createEmbedding, createEmbeddings } from "./embedding";

const EPISODIC_INDEX_VERSION = "episodic-v1";
const RRF_K = 60;
const VECTOR_TOP_K = 30;
const LEXICAL_TOP_K = 30;
const FUSED_TOP_K = 50;

type EpisodicRow = {
  id: string;
  namespace: string;
  conversation_id: string;
  canonical_message_id: string;
  role: "user" | "assistant";
  occurred_at_utc: string;
  vector_id: string;
  vector_status: "pending" | "ready" | "failed";
  vector_error_code: string | null;
  content: string;
};

export interface EpisodicCandidate extends EpisodicRow {
  channel_ranks: Record<string, number | null>;
  channel_scores: Record<string, number | null>;
  rrf_score: number;
  exact_match: boolean;
}

export interface EpisodicSearchResult {
  candidates: EpisodicCandidate[];
  channels_requested: string[];
  channels_completed: string[];
  channels_failed: Array<{ channel: string; code: string }>;
  index_version: string;
}

export interface EpisodicIndexResult {
  selected: number;
  indexed: number;
  failed: number;
  remaining: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function exactLikePattern(query: string): string | null {
  const pattern = `%${escapeLike(query)}%`;
  return new TextEncoder().encode(pattern).byteLength <= 50 ? pattern : null;
}

function ftsTerms(query: string): string[] {
  const compact = query.normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
  if (compact.length < 3) return [];
  const terms = new Set<string>();
  for (let index = 0; index <= compact.length - 3 && terms.size < 18; index += 1) {
    const term = compact.slice(index, index + 3);
    if (/^[\p{L}\p{N}]{3}$/u.test(term)) terms.add(term);
  }
  return [...terms];
}

function ftsExpression(query: string): string | null {
  const terms = ftsTerms(query);
  return terms.length > 0 ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
}

async function fetchRowsByProjectionIds(
  db: D1Database,
  namespace: string,
  ids: string[],
  excludedMessageId?: string | null,
): Promise<EpisodicRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT p.id,p.namespace,p.conversation_id,p.canonical_message_id,p.role,p.occurred_at_utc,
            p.vector_id,p.vector_status,p.vector_error_code,m.content
     FROM episodic_projections p
     JOIN messages m ON m.id=p.canonical_message_id
     WHERE p.namespace=? AND p.id IN (${placeholders})
       AND m.publication_state IN ('source_received','delivered')
       AND (? IS NULL OR p.canonical_message_id<>?)`
  ).bind(namespace, ...ids, excludedMessageId ?? null, excludedMessageId ?? null).all<EpisodicRow>();
  return result.results ?? [];
}

async function vectorChannel(
  env: Env,
  input: { namespace: string; query: string; excludedMessageId?: string | null; queryVector?: number[] | null },
): Promise<{ ranks: Map<string, number>; scores: Map<string, number>; failed: string | null }> {
  if (!env.VECTORIZE) return { ranks: new Map(), scores: new Map(), failed: "binding_missing" };
  const vector = input.queryVector === undefined ? await createEmbedding(env, input.query) : input.queryVector;
  if (!vector) return { ranks: new Map(), scores: new Map(), failed: "embedding_unavailable" };
  try {
    const result = await env.VECTORIZE.query(vector, {
      topK: VECTOR_TOP_K,
      namespace: input.namespace,
      returnMetadata: true,
      filter: { namespace: input.namespace, kind: "episodic", status: "active" } as VectorizeVectorMetadataFilter,
    } as Parameters<typeof env.VECTORIZE.query>[1]);
    const ranks = new Map<string, number>();
    const scores = new Map<string, number>();
    for (const match of result.matches ?? []) {
      const metadata = (match.metadata ?? {}) as Record<string, unknown>;
      const ref = typeof metadata.ref_id === "string" ? metadata.ref_id : match.id;
      if (!ref || metadata.canonical_message_id === input.excludedMessageId) continue;
      ranks.set(ref, ranks.size + 1);
      scores.set(ref, match.score);
    }
    return { ranks, scores, failed: null };
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message.slice(0, 120) : "vector_query_failed";
    return { ranks: new Map(), scores: new Map(), failed: code };
  }
}

async function ftsChannel(
  env: Env,
  input: { namespace: string; query: string; excludedMessageId?: string | null },
): Promise<{ ranks: Map<string, number>; scores: Map<string, number>; failed: string | null }> {
  const expression = ftsExpression(input.query);
  if (!expression) return { ranks: new Map(), scores: new Map(), failed: null };
  try {
    const result = await env.DB.prepare(
      `SELECT f.projection_id AS id,bm25(episodic_fts) AS score
       FROM episodic_fts f
       JOIN episodic_projections p ON p.id=f.projection_id
       WHERE episodic_fts MATCH ? AND f.namespace=?
         AND (? IS NULL OR p.canonical_message_id<>?)
       ORDER BY score ASC LIMIT ?`
    ).bind(expression, input.namespace, input.excludedMessageId ?? null, input.excludedMessageId ?? null, LEXICAL_TOP_K)
      .all<{ id: string; score: number }>();
    const ranks = new Map<string, number>();
    const scores = new Map<string, number>();
    for (const row of result.results ?? []) {
      ranks.set(row.id, ranks.size + 1);
      scores.set(row.id, -row.score);
    }
    return { ranks, scores, failed: null };
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message.slice(0, 120) : "fts_query_failed";
    return { ranks: new Map(), scores: new Map(), failed: code };
  }
}

async function exactChannel(
  env: Env,
  input: { namespace: string; query: string; excludedMessageId?: string | null },
): Promise<{ ranks: Map<string, number>; scores: Map<string, number>; failed: string | null }> {
  const pattern = exactLikePattern(input.query);
  if (!pattern) return { ranks: new Map(), scores: new Map(), failed: null };
  try {
    const result = await env.DB.prepare(
      `SELECT p.id
       FROM episodic_projections p JOIN messages m ON m.id=p.canonical_message_id
       WHERE p.namespace=? AND m.publication_state IN ('source_received','delivered')
         AND m.content LIKE ? ESCAPE '\\'
         AND (? IS NULL OR p.canonical_message_id<>?)
       ORDER BY p.occurred_at_utc DESC LIMIT 2`
    ).bind(input.namespace, pattern, input.excludedMessageId ?? null, input.excludedMessageId ?? null)
      .all<{ id: string }>();
    const ranks = new Map<string, number>();
    const scores = new Map<string, number>();
    for (const row of result.results ?? []) {
      ranks.set(row.id, ranks.size + 1);
      scores.set(row.id, 1);
    }
    return { ranks, scores, failed: null };
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message.slice(0, 120) : "exact_query_failed";
    return { ranks: new Map(), scores: new Map(), failed: code };
  }
}

export async function searchEpisodicHybrid(
  env: Env,
  input: { namespace: string; query: string; currentEventRef?: string | null; query_vector?: number[] | null },
): Promise<EpisodicSearchResult> {
  const excludedMessageId = input.currentEventRef?.startsWith("msg_") ? input.currentEventRef : null;
  const request = { namespace: input.namespace, query: input.query, excludedMessageId, queryVector: input.query_vector };
  const [vector, fts, exact] = await Promise.all([
    vectorChannel(env, request),
    ftsChannel(env, request),
    exactChannel(env, request),
  ]);
  const channels = { vector, fts, exact };
  const ids = new Set<string>();
  for (const channel of Object.values(channels)) for (const id of channel.ranks.keys()) ids.add(id);
  const rows = await fetchRowsByProjectionIds(env.DB, input.namespace, [...ids], excludedMessageId);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const candidates = [...ids].flatMap((id): EpisodicCandidate[] => {
    const row = rowById.get(id);
    if (!row) return [];
    const channelRanks: Record<string, number | null> = {};
    const channelScores: Record<string, number | null> = {};
    let rrfScore = 0;
    for (const [name, channel] of Object.entries(channels)) {
      const rank = channel.ranks.get(id) ?? null;
      channelRanks[name] = rank;
      channelScores[name] = channel.scores.get(id) ?? null;
      if (rank !== null) rrfScore += 1 / (RRF_K + rank);
    }
    return [{ ...row, channel_ranks: channelRanks, channel_scores: channelScores, rrf_score: rrfScore, exact_match: exact.ranks.has(id) }];
  }).sort((left, right) => {
    if (left.exact_match !== right.exact_match) return left.exact_match ? -1 : 1;
    if (left.rrf_score !== right.rrf_score) return right.rrf_score - left.rrf_score;
    return right.occurred_at_utc.localeCompare(left.occurred_at_utc);
  }).slice(0, FUSED_TOP_K);

  const failed = Object.entries(channels).flatMap(([channel, value]) => value.failed ? [{ channel, code: value.failed }] : []);
  return {
    candidates,
    channels_requested: ["vector", "fts", "exact"],
    channels_completed: Object.entries(channels).filter(([, value]) => !value.failed).map(([channel]) => channel),
    channels_failed: failed,
    index_version: EPISODIC_INDEX_VERSION,
  };
}

export async function hydrateEpisodicCandidates(
  db: D1Database,
  namespace: string,
  candidates: EpisodicCandidate[],
): Promise<Array<EpisodicCandidate & { hydrated_event_refs: string[] }>> {
  return Promise.all(candidates.slice(0, 6).map(async (candidate) => {
    const result = await db.prepare(
      `WITH ranked AS (
         SELECT id,role,content,created_at,
                row_number() OVER (ORDER BY created_at,id) AS rn
         FROM messages
         WHERE namespace=? AND conversation_id=? AND role IN ('user','assistant')
           AND publication_state IN ('source_received','delivered')
       ), target AS (SELECT rn FROM ranked WHERE id=? )
       SELECT id,role,content,created_at FROM ranked,target
       WHERE ranked.rn BETWEEN target.rn-1 AND target.rn+1
       ORDER BY ranked.rn`
    ).bind(namespace, candidate.conversation_id, candidate.canonical_message_id)
      .all<{ id: string; role: "user" | "assistant"; content: string; created_at: string }>();
    const events = result.results ?? [];
    return {
      ...candidate,
      content: events.map((event) => `[${event.created_at}][${event.role}] ${event.content}`).join("\n"),
      hydrated_event_refs: events.map((event) => event.id),
    };
  }));
}

export const MEMORY_STRUCTURAL_HYDRATION_VERSION = "memory-structural-hydration-v2.0.0";

export interface StructurallyHydratedEpisodicCandidate extends EpisodicCandidate {
  hydrated_event_refs: string[];
  structural_edge_ids: string[];
  target_only: boolean;
}

/**
 * vNext.2 hydration follows explicit evidence structure only. An event with no
 * reply/tool/composite/sibling edge remains target-only; chronological ±1 is
 * deliberately not a fallback.
 */
export async function hydrateEpisodicCandidatesStructurally(
  db: D1Database,
  namespace: string,
  candidates: EpisodicCandidate[],
): Promise<StructurallyHydratedEpisodicCandidate[]> {
  return Promise.all(candidates.slice(0, 12).map(async (candidate) => {
    const target = await db.prepare(`SELECT id,conversation_id,role,content,created_at
      FROM messages WHERE id=? AND namespace=?
        AND publication_state IN ('source_received','delivered')`)
      .bind(candidate.canonical_message_id,namespace)
      .first<{ id: string; conversation_id: string; role: "user" | "assistant"; content: string; created_at: string }>();
    if (!target) return { ...candidate,hydrated_event_refs: [],structural_edge_ids: [],target_only: true };
    const targetRefs = await db.prepare(`SELECT evidence_ref_id FROM memory_evidence_refs
      WHERE canonical_event_id=? AND conversation_id=? AND sensitivity='normal'`)
      .bind(target.id,target.conversation_id).all<{ evidence_ref_id: string }>();
    const refIds = (targetRefs.results ?? []).map((row) => row.evidence_ref_id);
    let structuralRows: Array<{
      structural_edge_id: string;
      from_evidence_ref_id: string;
      to_evidence_ref_id: string;
      from_event_id: string;
      to_event_id: string;
    }> = [];
    if (refIds.length > 0) {
      const marks = refIds.map(() => "?").join(",");
      const result = await db.prepare(`SELECT e.structural_edge_id,e.from_evidence_ref_id,e.to_evidence_ref_id,
          rf.canonical_event_id AS from_event_id,rt.canonical_event_id AS to_event_id
        FROM memory_evidence_structural_edges e
        JOIN memory_evidence_refs rf ON rf.evidence_ref_id=e.from_evidence_ref_id
        JOIN memory_evidence_refs rt ON rt.evidence_ref_id=e.to_evidence_ref_id
        WHERE (e.from_evidence_ref_id IN (${marks}) OR e.to_evidence_ref_id IN (${marks}))
          AND e.edge_kind IN ('REPLY_TO','QUESTION_ANSWER','TOOL_CALL_RESULT','ATOMIC_SIBLING','MINIMAL_EXCHANGE')
          AND rf.conversation_id=? AND rt.conversation_id=?
          AND rf.sensitivity='normal' AND rt.sensitivity='normal'
        ORDER BY e.edge_ordinal,e.structural_edge_id`)
        .bind(...refIds,...refIds,target.conversation_id,target.conversation_id).all<typeof structuralRows[number]>();
      structuralRows = result.results ?? [];
    }
    const eventIds = [...new Set([
      target.id,
      ...structuralRows.flatMap((row) => [row.from_event_id,row.to_event_id]),
    ])];
    const marks = eventIds.map(() => "?").join(",");
    const eventResult = await db.prepare(`SELECT id,role,content,created_at FROM messages
      WHERE id IN (${marks}) AND namespace=? AND conversation_id=?
        AND publication_state IN ('source_received','delivered')
      ORDER BY created_at,id`).bind(...eventIds,namespace,target.conversation_id)
      .all<{ id: string; role: "user" | "assistant"; content: string; created_at: string }>();
    const events = eventResult.results ?? [];
    return {
      ...candidate,
      content: events.map((event) => `[${event.created_at}][${event.role}] ${event.content}`).join("\n"),
      hydrated_event_refs: events.map((event) => event.id),
      structural_edge_ids: structuralRows.map((row) => row.structural_edge_id),
      target_only: structuralRows.length === 0,
    };
  }));
}

export async function indexPendingEpisodic(
  env: Env,
  input: { namespace?: string; limit?: number; includeFailed?: boolean } = {},
): Promise<EpisodicIndexResult> {
  if (!env.VECTORIZE) return { selected: 0, indexed: 0, failed: 0, remaining: 0 };
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 50);
  const statuses = input.includeFailed ? "('pending','failed')" : "('pending')";
  const binds: unknown[] = [];
  let namespaceClause = "";
  if (input.namespace) {
    namespaceClause = "AND p.namespace=?";
    binds.push(input.namespace);
  }
  binds.push(limit);
  const rows = await env.DB.prepare(
    `SELECT p.id,p.namespace,p.canonical_message_id,p.role,p.occurred_at_utc,p.vector_id,m.content
     FROM episodic_projections p JOIN messages m ON m.id=p.canonical_message_id
     WHERE p.vector_status IN ${statuses} AND m.publication_state IN ('source_received','delivered') ${namespaceClause}
     ORDER BY p.occurred_at_utc ASC LIMIT ?`
  ).bind(...binds).all<Pick<EpisodicRow, "id" | "namespace" | "canonical_message_id" | "role" | "occurred_at_utc" | "vector_id" | "content">>();
  const selected = rows.results ?? [];
  const vectors: VectorizeVector[] = [];
  const failedIds: string[] = [];
  const embeddings = await createEmbeddings(env, selected.map((row) => row.content));
  for (const [index, row] of selected.entries()) {
    const vector = embeddings[index];
    if (!vector) {
      failedIds.push(row.id);
      continue;
    }
    vectors.push({
      id: row.vector_id,
      namespace: row.namespace,
      values: vector,
      metadata: {
        namespace: row.namespace,
        kind: "episodic",
        status: "active",
        ref_id: row.id,
        canonical_message_id: row.canonical_message_id,
        role: row.role,
        occurred_at_utc: row.occurred_at_utc,
      },
    });
  }
  if (vectors.length > 0) await env.VECTORIZE.upsert(vectors);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const vector of vectors) {
    statements.push(env.DB.prepare(
      "UPDATE episodic_projections SET vector_status='ready',vector_error_code=NULL,indexed_at_utc=?,updated_at=? WHERE vector_id=?"
    ).bind(now, now, vector.id));
  }
  for (const id of failedIds) {
    statements.push(env.DB.prepare(
      "UPDATE episodic_projections SET vector_status='failed',vector_error_code='embedding_unavailable',updated_at=? WHERE id=?"
    ).bind(now, id));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM episodic_projections WHERE vector_status IN ('pending','failed')${input.namespace ? " AND namespace=?" : ""}`
  ).bind(...(input.namespace ? [input.namespace] : [])).first<{ count: number }>();
  return { selected: selected.length, indexed: vectors.length, failed: failedIds.length, remaining: remainingRow?.count ?? 0 };
}

export async function episodicIndexStatus(db: D1Database, namespace: string): Promise<Record<string, number>> {
  const result = await db.prepare(
    "SELECT vector_status AS status,COUNT(*) AS count FROM episodic_projections WHERE namespace=? GROUP BY vector_status"
  ).bind(namespace).all<{ status: string; count: number }>();
  return Object.fromEntries((result.results ?? []).map((row) => [row.status, row.count]));
}
