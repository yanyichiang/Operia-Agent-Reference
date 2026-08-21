import { listMemoriesPage } from "../db/memories";
import { fetchMemoryLifecycleRows } from "../db/v2";
import type { Env, MemoryApiRecord, MemoryRecord } from "../types";
import { createEmbedding } from "./embedding";
import { toMemoryApiRecord } from "./search";

export interface MemoryExportInput {
  namespace: string;
  type?: string | null;
  format?: string | null;
}

export interface MemoryExportRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface MemoryExportResult {
  data: MemoryExportRecord[];
  meta: {
    namespace: string;
    type: string | null;
    format: "json";
    count: number;
    exported_at: string;
    source: "vectorize" | "d1";
    vectorize: {
      index_name: string;
      phase1_ids_found: number;
      phase2_fetched: number;
      error?: string;
    };
  };
}

// getByIds batch size — keep small to stay well under any internal limits.
const GETBYIDS_BATCH = 50;
const EXPORT_PAGE_SIZE = 1000;

function getIndexName(env: Env): string {
  return env.VECTORIZE_INDEX_NAME?.trim() || "memo-kb";
}

function readMetadataText(metadata: Record<string, unknown>): string {
  const fields = ["content", "text", "memory", "summary", "document", "chunk", "value", "title"];
  for (const field of fields) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readMetadataString(metadata: Record<string, unknown>, field: string): string | null {
  const value = metadata[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readMetadataNumber(metadata: Record<string, unknown>, field: string, fallback: number): number {
  const value = metadata[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readMetadataBoolean(metadata: Record<string, unknown>, field: string): boolean {
  const value = metadata[field];
  return value === true || value === "true";
}

function readMetadataStringArray(metadata: Record<string, unknown>, field: string): string[] {
  const value = metadata[field];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return [value.trim()];
    }
  }
  return [];
}

function vectorMatchToExportRecord(match: VectorizeMatch): MemoryExportRecord {
  const metadata = ((match.metadata || {}) as Record<string, unknown>) || {};
  const refId = readMetadataString(metadata, "ref_id");
  const id = refId || (match.id.startsWith("mem_") ? match.id.slice("mem_".length) : match.id);
  const content = readMetadataText(metadata);

  return {
    id,
    content,
    metadata: {
      namespace: readMetadataString(metadata, "namespace"),
      type: readMetadataString(metadata, "type") || "note",
      summary: readMetadataString(metadata, "summary"),
      importance: readMetadataNumber(metadata, "importance", 0.5),
      confidence: readMetadataNumber(metadata, "confidence", 0.8),
      status: readMetadataString(metadata, "status") || "active",
      pinned: readMetadataBoolean(metadata, "pinned"),
      tags: readMetadataStringArray(metadata, "tags"),
      source: readMetadataString(metadata, "source_id") || readMetadataString(metadata, "source"),
      source_message_ids: readMetadataStringArray(metadata, "source_message_ids"),
      vector_id: match.id,
      created_at: readMetadataString(metadata, "created_at"),
      updated_at: readMetadataString(metadata, "updated_at"),
      expires_at: readMetadataString(metadata, "expires_at"),
      score: match.score,
      raw: metadata
    }
  };
}

/**
 * Two-phase Vectorize export:
 *
 * Phase 1 — discover all vector IDs:
 *   query(zeroVector, {topK:1000, returnMetadata:'indexed'})
 *   'indexed' metadata (not 'all') lifts the topK≤50 restriction.
 *   This returns IDs + indexed fields (namespace, status, type, pinned, kind)
 *   but NOT content. That's fine — we only need the IDs here.
 *
 * Phase 2 — fetch full metadata for each ID:
 *   getByIds(batch) in chunks of 50.
 *   getByIds returns full metadata including content, with no topK limit.
 *
 * If Vectorize errors at any phase, we report it. We do NOT silently fall
 * back to D1 (D1 contains deleted/superseded garbage — 520 deleted rows).
 */
async function exportFromVectorize(
  env: Env,
  input: { namespace: string; type?: string | null }
): Promise<{
  records: MemoryExportRecord[];
  phase1Ids: number;
  phase2Fetched: number;
  error?: string;
}> {
  if (!env.VECTORIZE) {
    return { records: [], phase1Ids: 0, phase2Fetched: 0, error: "missing_vectorize_binding" };
  }

  // --- Phase 1: discover all vector IDs via indexed-metadata query ---
  const probe = await createEmbedding(env, "memory export probe");
  if (!probe || probe.length === 0) {
    return { records: [], phase1Ids: 0, phase2Fetched: 0, error: "embedding_unavailable" };
  }
  const zeroVector = probe.map(() => 0);

  const filter: VectorizeVectorMetadataFilter = { namespace: input.namespace };
  if (input.type) filter.type = input.type;

  let phase1Ids: string[] = [];
  try {
    const result = await env.VECTORIZE.query(zeroVector, {
      topK: 1000,
      namespace: input.namespace,
      returnMetadata: "indexed",
      returnValues: false,
      filter
    });
    phase1Ids = (result.matches ?? []).map((m) => m.id);
  } catch (err) {
    return {
      records: [],
      phase1Ids: 0,
      phase2Fetched: 0,
      error: `phase1_query_failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  if (phase1Ids.length === 0) {
    return { records: [], phase1Ids: 0, phase2Fetched: 0 };
  }

  // --- Phase 2: fetch full metadata (incl content) via getByIds in batches ---
  const records: MemoryExportRecord[] = [];
  let phase2Fetched = 0;

  for (let i = 0; i < phase1Ids.length; i += GETBYIDS_BATCH) {
    const batch = phase1Ids.slice(i, i + GETBYIDS_BATCH);
    try {
      const vectors = await env.VECTORIZE.getByIds(batch);
      phase2Fetched += vectors.length;
      for (const v of vectors) {
        // getByIds returns VectorizeMatch-shaped objects with metadata
        records.push(vectorMatchToExportRecord(v as unknown as VectorizeMatch));
      }
    } catch (err) {
      // Partial result — return what we have plus the error
      return {
        records,
        phase1Ids: phase1Ids.length,
        phase2Fetched,
        error: `phase2_getbyids_failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  return { records, phase1Ids: phase1Ids.length, phase2Fetched };
}

// D1 fallback — only used when Vectorize is completely unavailable.
// Filters to status='active' to avoid dumping deleted/superseded garbage.
async function listActiveMemoryRecords(
  env: Env,
  input: { namespace: string; type?: string | null }
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await listMemoriesPage(env.DB, {
      namespace: input.namespace,
      type: input.type || undefined,
      status: "active",
      limit: EXPORT_PAGE_SIZE,
      offset
    });

    records.push(...page.records);
    if (!page.hasMore || page.nextOffset === null) break;
    offset = page.nextOffset;
  }

  return records;
}

function toD1ExportRecord(record: MemoryApiRecord): MemoryExportRecord {
  const { id, content, score: _score, ...metadata } = record;
  return { id, content, metadata };
}

async function exportFromD1(env: Env, input: { namespace: string; type?: string | null }): Promise<MemoryExportRecord[]> {
  const records = await listActiveMemoryRecords(env, input);
  const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, records.map((record) => record.id));
  const lifecycleByMemoryId = new Map(lifecycleRows.map((row) => [row.memory_id, row]));

  return records.map((record) =>
    toD1ExportRecord(toMemoryApiRecord(record, undefined, lifecycleByMemoryId.get(record.id) ?? null))
  );
}

export async function exportMemories(env: Env, input: MemoryExportInput): Promise<MemoryExportResult> {
  const format = (input.format || "json").trim().toLowerCase();
  if (format !== "json") {
    throw new Error("Only format=json is supported");
  }

  const vectorize = await exportFromVectorize(env, {
    namespace: input.namespace,
    type: input.type
  });

  // Use Vectorize data if we got any (even partial).
  // Only fall back to D1 if Vectorize is completely unavailable (no binding
  // or embedding failure) AND returned zero records.
  let data: MemoryExportRecord[];
  let source: "vectorize" | "d1";

  if (vectorize.records.length > 0 || !vectorize.error) {
    data = vectorize.records;
    source = "vectorize";
  } else {
    data = await exportFromD1(env, { namespace: input.namespace, type: input.type });
    source = "d1";
  }

  return {
    data,
    meta: {
      namespace: input.namespace,
      type: input.type || null,
      format: "json",
      count: data.length,
      exported_at: new Date().toISOString(),
      source,
      vectorize: {
        index_name: getIndexName(env),
        phase1_ids_found: vectorize.phase1Ids,
        phase2_fetched: vectorize.phase2Fetched,
        ...(vectorize.error ? { error: vectorize.error } : {})
      }
    }
  };
}
