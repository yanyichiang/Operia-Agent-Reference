import type { MemoryProductState, MemoryRecord } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export const MEMORY_STATUSES = ["active", "low_confidence", "archived", "expired", "superseded", "deleted"] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

const MEMORY_STATUS_SET = new Set<string>(MEMORY_STATUSES);

export function isMemoryStatus(value: string): value is MemoryStatus {
  return MEMORY_STATUS_SET.has(value);
}

export interface CreateMemoryInput {
  namespace: string;
  type: string;
  content: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  pinned?: boolean;
  tags?: string[];
  source?: string | null;
  sourceMessageIds?: string[];
  expiresAt?: string | null;
}

export interface ListMemoryFilters {
  namespace: string;
  type?: string;
  status?: string;
  pinned?: boolean;
  limit: number;
  offset?: number;
}

export interface ListMemoryPage {
  records: MemoryRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface UpdateMemoryInput {
  type?: string;
  content?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  pinned?: boolean;
  starred?: boolean;
  displayPinned?: boolean;
  tags?: string[];
  sourceMessageIds?: string[];
  expiresAt?: string | null;
}

export interface MemoryMutationContext {
  actor: string;
  source: string;
  authorizedBy?: string | null;
  operation: string;
  reason?: string | null;
}

interface MemoryProductPatch {
  deletedAt?: string | null;
  restoreDeadline?: string | null;
  statusBeforeDelete?: string | null;
}

const DEFAULT_MUTATION_CONTEXT: MemoryMutationContext = {
  actor: "memory-service",
  source: "memory.example.com",
  authorizedBy: null,
  operation: "memory.update",
  reason: null
};

function defaultProductState(memory: MemoryRecord): MemoryProductState {
  return {
    memory_id: memory.id,
    namespace: memory.namespace,
    revision: 1,
    starred: 0,
    display_pinned: 0,
    deleted_at: memory.status === "deleted" ? memory.updated_at : null,
    restore_deadline: null,
    status_before_delete: memory.status === "deleted" ? null : memory.status,
    updated_at: memory.updated_at
  };
}

export async function getMemoryProductState(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryProductState | null> {
  return await db.prepare(
    "SELECT * FROM memory_product_state WHERE namespace = ? AND memory_id = ?"
  ).bind(input.namespace, input.id).first<MemoryProductState>() ?? null;
}

export async function fetchMemoryProductStates(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryProductState[]> {
  const ids = [...new Set(input.ids.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows: MemoryProductState[] = [];
  for (let offset = 0; offset < ids.length; offset += 90) {
    const batch = ids.slice(offset, offset + 90);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db.prepare(
      `SELECT * FROM memory_product_state WHERE namespace = ? AND memory_id IN (${placeholders})`
    ).bind(input.namespace, ...batch).all<MemoryProductState>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

export async function ensureMemoryProductState(db: D1Database, memory: MemoryRecord): Promise<MemoryProductState> {
  const fallback = defaultProductState(memory);
  await db.prepare(`INSERT OR IGNORE INTO memory_product_state (
    memory_id, namespace, revision, starred, display_pinned,
    deleted_at, restore_deadline, status_before_delete, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      fallback.memory_id,
      fallback.namespace,
      fallback.revision,
      fallback.starred,
      fallback.display_pinned,
      fallback.deleted_at,
      fallback.restore_deadline,
      fallback.status_before_delete,
      fallback.updated_at
    ).run();
  return await getMemoryProductState(db, { namespace: memory.namespace, id: memory.id }) ?? fallback;
}

function snapshot(memory: MemoryRecord, state: MemoryProductState): Record<string, unknown> {
  return {
    id: memory.id,
    namespace: memory.namespace,
    type: memory.type,
    content: memory.content,
    summary: memory.summary,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status,
    runtime_pinned: Boolean(memory.pinned),
    starred: Boolean(state.starred),
    display_pinned: Boolean(state.display_pinned),
    tags: memory.tags,
    source: memory.source,
    source_message_ids: memory.source_message_ids,
    expires_at: memory.expires_at,
    deleted_at: state.deleted_at,
    restore_deadline: state.restore_deadline,
    revision: state.revision
  };
}

async function snapshotHash(value: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readableDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): string {
  if (!before) return JSON.stringify({ created: true, fields: Object.keys(after) });
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = { before: before[key], after: after[key] };
    }
  }
  return JSON.stringify(changed);
}

function assertStatusTransition(from: string, to: MemoryStatus, operation: string): void {
  if (!isMemoryStatus(from)) throw new Error("memory_current_status_invalid");
  if (!isMemoryStatus(to)) throw new Error("memory_status_invalid");
  if (from === to) return;
  if (to === "deleted") {
    if (operation !== "memory.soft_delete") throw new Error("memory_delete_requires_delete_action");
    return;
  }
  if (from === "deleted") {
    if (operation !== "memory.restore") throw new Error("memory_restore_requires_restore_action");
    return;
  }
  const allowed: Record<Exclude<MemoryStatus, "deleted">, MemoryStatus[]> = {
    active: ["low_confidence", "archived", "expired", "superseded"],
    low_confidence: ["active", "archived", "expired", "superseded"],
    archived: ["active", "expired", "superseded"],
    expired: ["active", "archived", "superseded"],
    superseded: ["archived", "expired"]
  };
  if (!allowed[from as Exclude<MemoryStatus, "deleted">]?.includes(to)) {
    throw new Error("memory_status_transition_invalid");
  }
}

export async function createMemory(db: D1Database, input: CreateMemoryInput): Promise<MemoryRecord> {
  const id = newId("mem");
  const now = nowIso();
  const vectorId = `mem_${id}`;
  const record: MemoryRecord = {
    id,
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    summary: input.summary ?? null,
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? "active",
    pinned: input.pinned ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    source: input.source ?? null,
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    vector_id: vectorId,
    last_recalled_at: null,
    recall_count: 0,
    created_at: now,
    updated_at: now,
    expires_at: input.expiresAt ?? null
  };

  const productState = defaultProductState(record);
  const after = snapshot(record, productState);
  const afterHash = await snapshotHash(after);
  await db.batch([
    db.prepare(
      `INSERT INTO memories (
        id, namespace, type, content, summary, importance, confidence, status,
        pinned, tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.summary,
      record.importance,
      record.confidence,
      record.status,
      record.pinned,
      record.tags,
      record.source,
      record.source_message_ids,
      record.vector_id,
      record.created_at,
      record.updated_at,
      record.expires_at
    ),
    db.prepare(`INSERT INTO memory_product_state (
      memory_id, namespace, revision, starred, display_pinned,
      deleted_at, restore_deadline, status_before_delete, updated_at
    ) VALUES (?, ?, 1, 0, 0, ?, ?, ?, ?)`)
      .bind(record.id, record.namespace, productState.deleted_at, productState.restore_deadline, productState.status_before_delete, record.updated_at),
    db.prepare(`INSERT INTO memory_revisions (
      id, memory_id, namespace, revision, operation, actor, source, authorized_by,
      before_hash, after_hash, diff_json, reason, created_at
    ) VALUES (?, ?, ?, 1, 'memory.create', 'memory-service', 'memory.example.com', NULL, NULL, ?, ?, 'created', ?)`)
      .bind(newId("mrev"), record.id, record.namespace, afterHash, readableDiff(null, after), now)
  ]);

  return record;
}

export async function listMemoriesPage(db: D1Database, filters: ListMemoryFilters): Promise<ListMemoryPage> {
  let sql = "SELECT * FROM memories WHERE namespace = ?";
  const binds: unknown[] = [filters.namespace];

  if (filters.type) {
    sql += " AND type = ?";
    binds.push(filters.type);
  }

  if (filters.status) {
    sql += " AND status = ?";
    binds.push(filters.status);
  }

  if (filters.pinned !== undefined) {
    sql += " AND pinned = ?";
    binds.push(filters.pinned ? 1 : 0);
  }

  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const limit = Math.max(Math.floor(filters.limit), 1);
  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?";
  binds.push(limit + 1, offset);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<MemoryRecord>();

  const rows = result.results ?? [];
  const records = rows.slice(0, limit);

  return {
    records,
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + records.length : null
  };
}

/**
 * Product-list projection. This is intentionally separate from listMemoriesPage:
 * display_pinned may reorder a UI list, but must never reorder model retrieval.
 */
export async function listMemoryProductPage(db: D1Database, filters: ListMemoryFilters): Promise<ListMemoryPage> {
  let sql = `SELECT m.* FROM memories m
    LEFT JOIN memory_product_state ps
      ON ps.memory_id = m.id AND ps.namespace = m.namespace
    WHERE m.namespace = ?`;
  const binds: unknown[] = [filters.namespace];
  if (filters.type) {
    sql += " AND m.type = ?";
    binds.push(filters.type);
  }
  if (filters.status) {
    sql += " AND m.status = ?";
    binds.push(filters.status);
  }
  if (filters.pinned !== undefined) {
    sql += " AND m.pinned = ?";
    binds.push(filters.pinned ? 1 : 0);
  }
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const limit = Math.max(Math.floor(filters.limit), 1);
  sql += " ORDER BY COALESCE(ps.display_pinned, 0) DESC, m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?";
  binds.push(limit + 1, offset);
  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  const rows = result.results ?? [];
  const records = rows.slice(0, limit);
  return {
    records,
    hasMore: rows.length > limit,
    nextOffset: rows.length > limit ? offset + records.length : null
  };
}

export async function listMemories(db: D1Database, filters: ListMemoryFilters): Promise<MemoryRecord[]> {
  const page = await listMemoriesPage(db, filters);
  return page.records;
}

export async function getMemoryById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  const record = await db
    .prepare("SELECT * FROM memories WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<MemoryRecord>();

  return record ?? null;
}

export async function fetchMemoriesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryRecord[]> {
  if (input.ids.length === 0) return [];

  const placeholders = input.ids.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
    .bind(input.namespace, ...input.ids)
    .all<MemoryRecord>();

  return result.results ?? [];
}

export async function updateMemory(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    patch: UpdateMemoryInput;
    expectedUpdatedAt?: string;
    expectedRevision?: number;
    mutation?: MemoryMutationContext;
    productPatch?: MemoryProductPatch;
  }
): Promise<MemoryRecord | null> {
  const existing = await getMemoryById(db, input);
  if (!existing) return null;
  const currentState = await ensureMemoryProductState(db, existing);
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== existing.updated_at) return null;
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentState.revision) return null;
  const mutation = input.mutation ?? DEFAULT_MUTATION_CONTEXT;
  if (input.patch.status !== undefined) assertStatusTransition(existing.status, input.patch.status, mutation.operation);
  const assignments: string[] = [];
  const binds: unknown[] = [];

  function set(column: string, value: unknown): void {
    assignments.push(`${column} = ?`);
    binds.push(value);
  }

  if (input.patch.type !== undefined) set("type", input.patch.type);
  if (input.patch.content !== undefined) set("content", input.patch.content);
  if (input.patch.summary !== undefined) set("summary", input.patch.summary);
  if (input.patch.importance !== undefined) set("importance", input.patch.importance);
  if (input.patch.confidence !== undefined) set("confidence", input.patch.confidence);
  if (input.patch.status !== undefined) set("status", input.patch.status);
  if (input.patch.pinned !== undefined) set("pinned", input.patch.pinned ? 1 : 0);
  if (input.patch.tags !== undefined) set("tags", JSON.stringify(input.patch.tags));
  if (input.patch.sourceMessageIds !== undefined) set("source_message_ids", JSON.stringify(input.patch.sourceMessageIds));
  if (input.patch.expiresAt !== undefined) set("expires_at", input.patch.expiresAt);

  const hasProductMutation = input.patch.starred !== undefined
    || input.patch.displayPinned !== undefined
    || input.productPatch !== undefined;
  if (assignments.length === 0 && !hasProductMutation) {
    return getMemoryById(db, input);
  }

  const now = nowIso();
  const nextRecord: MemoryRecord = {
    ...existing,
    ...(input.patch.type === undefined ? {} : { type: input.patch.type }),
    ...(input.patch.content === undefined ? {} : { content: input.patch.content }),
    ...(input.patch.summary === undefined ? {} : { summary: input.patch.summary }),
    ...(input.patch.importance === undefined ? {} : { importance: input.patch.importance }),
    ...(input.patch.confidence === undefined ? {} : { confidence: input.patch.confidence }),
    ...(input.patch.status === undefined ? {} : { status: input.patch.status }),
    ...(input.patch.pinned === undefined ? {} : { pinned: input.patch.pinned ? 1 : 0 }),
    ...(input.patch.tags === undefined ? {} : { tags: JSON.stringify(input.patch.tags) }),
    ...(input.patch.sourceMessageIds === undefined ? {} : { source_message_ids: JSON.stringify(input.patch.sourceMessageIds) }),
    ...(input.patch.expiresAt === undefined ? {} : { expires_at: input.patch.expiresAt }),
    ...(assignments.length === 0 ? {} : { updated_at: now })
  };
  const nextState: MemoryProductState = {
    ...currentState,
    revision: currentState.revision + 1,
    starred: input.patch.starred === undefined ? currentState.starred : input.patch.starred ? 1 : 0,
    display_pinned: input.patch.displayPinned === undefined ? currentState.display_pinned : input.patch.displayPinned ? 1 : 0,
    deleted_at: input.productPatch?.deletedAt === undefined ? currentState.deleted_at : input.productPatch.deletedAt,
    restore_deadline: input.productPatch?.restoreDeadline === undefined ? currentState.restore_deadline : input.productPatch.restoreDeadline,
    status_before_delete: input.productPatch?.statusBeforeDelete === undefined ? currentState.status_before_delete : input.productPatch.statusBeforeDelete,
    updated_at: now
  };
  const before = snapshot(existing, currentState);
  const after = snapshot(nextRecord, nextState);
  const [beforeHash, afterHash] = await Promise.all([snapshotHash(before), snapshotHash(after)]);
  const statements: D1PreparedStatement[] = [];
  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    binds.push(now);
    statements.push(db.prepare(
      `UPDATE memories SET ${assignments.join(", ")} WHERE namespace = ? AND id = ? AND updated_at = ?`
    ).bind(...binds, input.namespace, input.id, existing.updated_at));
  }
  const baseFreshnessClause = assignments.length > 0
    ? " AND EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND updated_at = ?)"
    : "";
  statements.push(db.prepare(`UPDATE memory_product_state SET
      revision = ?, starred = ?, display_pinned = ?, deleted_at = ?, restore_deadline = ?,
      status_before_delete = ?, updated_at = ?
    WHERE namespace = ? AND memory_id = ? AND revision = ?${baseFreshnessClause}`)
    .bind(
      nextState.revision,
      nextState.starred,
      nextState.display_pinned,
      nextState.deleted_at,
      nextState.restore_deadline,
      nextState.status_before_delete,
      nextState.updated_at,
      input.namespace,
      input.id,
      currentState.revision,
      ...(assignments.length > 0 ? [input.namespace, input.id, now] : [])
    ));
  statements.push(db.prepare(`INSERT INTO memory_revisions (
      id, memory_id, namespace, revision, operation, actor, source, authorized_by,
      before_hash, after_hash, diff_json, reason, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM memory_product_state
        WHERE namespace = ? AND memory_id = ? AND revision = ?
      )`)
    .bind(
      newId("mrev"),
      input.id,
      input.namespace,
      nextState.revision,
      mutation.operation,
      mutation.actor,
      mutation.source,
      mutation.authorizedBy ?? null,
      beforeHash,
      afterHash,
      readableDiff(before, after),
      mutation.reason ?? null,
      now,
      input.namespace,
      input.id,
      nextState.revision
    ));
  await db.batch(statements);
  const committedState = await getMemoryProductState(db, input);
  if (committedState?.revision !== nextState.revision) return null;
  return getMemoryById(db, input);
}

export async function softDeleteMemory(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    expectedUpdatedAt?: string;
    expectedRevision?: number;
    mutation?: Omit<MemoryMutationContext, "operation">;
  }
): Promise<MemoryRecord | null> {
  const existing = await getMemoryById(db, input);
  if (!existing) return null;
  if (existing.status === "deleted") throw new Error("memory_already_deleted");
  const deletedAt = nowIso();
  const restoreDeadline = new Date(Date.parse(deletedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  return updateMemory(db, {
    namespace: input.namespace,
    id: input.id,
    expectedUpdatedAt: input.expectedUpdatedAt,
    expectedRevision: input.expectedRevision,
    mutation: { ...(input.mutation ?? DEFAULT_MUTATION_CONTEXT), operation: "memory.soft_delete" },
    productPatch: {
      deletedAt,
      restoreDeadline,
      statusBeforeDelete: existing.status
    },
    patch: {
      status: "deleted"
    }
  });
}

export async function restoreMemory(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    expectedUpdatedAt?: string;
    expectedRevision?: number;
    mutation?: Omit<MemoryMutationContext, "operation">;
  }
): Promise<MemoryRecord | null> {
  const existing = await getMemoryById(db, input);
  if (!existing) return null;
  const state = await ensureMemoryProductState(db, existing);
  if (existing.status !== "deleted") throw new Error("memory_not_deleted");
  if (!state.status_before_delete || !isMemoryStatus(state.status_before_delete) || state.status_before_delete === "deleted") {
    throw new Error("memory_restore_state_unavailable");
  }
  if (!state.restore_deadline || Date.parse(state.restore_deadline) <= Date.now()) {
    throw new Error("memory_restore_window_expired");
  }
  return updateMemory(db, {
    namespace: input.namespace,
    id: input.id,
    expectedUpdatedAt: input.expectedUpdatedAt,
    expectedRevision: input.expectedRevision,
    mutation: { ...(input.mutation ?? DEFAULT_MUTATION_CONTEXT), operation: "memory.restore" },
    productPatch: { deletedAt: null, restoreDeadline: null, statusBeforeDelete: null },
    patch: { status: state.status_before_delete }
  });
}

export async function searchMemoriesByText(
  db: D1Database,
  input: { namespace: string; query: string; types?: string[]; limit: number }
): Promise<Array<MemoryRecord & { score: number }>> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 500);
  const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  let sql = "SELECT * FROM memories WHERE namespace = ? AND status = 'active'";
  const binds: unknown[] = [input.namespace];

  if (query) {
    sql += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')";
    binds.push(like, like, like, like);
  }

  if (input.types && input.types.length > 0) {
    sql += ` AND type IN (${input.types.map(() => "?").join(", ")})`;
    binds.push(...input.types);
  }

  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?";
  binds.push(input.limit);

  let result: D1Result<MemoryRecord>;
  try {
    result = await db
      .prepare(sql)
      .bind(...binds)
      .all<MemoryRecord>();
  } catch (error) {
    console.error("text memory search failed", error);
    return [];
  }

  const lowered = query.toLowerCase();
  return (result.results ?? []).map((record) => ({
    ...record,
    score: lowered && record.content.toLowerCase().includes(lowered) ? 0.75 : 0.5
  }));
}

export async function markMemoriesRecalled(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<void> {
  if (input.ids.length === 0) return;

  const placeholders = input.ids.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE memories
       SET last_recalled_at = ?, recall_count = recall_count + 1
       WHERE namespace = ? AND id IN (${placeholders})`
    )
    .bind(nowIso(), input.namespace, ...input.ids)
    .run();
}
