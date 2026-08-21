import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CacheEntryRecord {
  id: string;
  namespace: string;
  key: string;
  value_json: string | null;
  value_text: string | null;
  content_type: string | null;
  tags: string | null;
  size_bytes: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PutCacheEntryInput {
  namespace: string;
  key: string;
  value: unknown;
  contentType?: string | null;
  tags?: string[];
  ttlSeconds?: number | null;
}

function getExpiresAt(ttlSeconds?: number | null): string | null {
  if (ttlSeconds === null) return null;
  if (ttlSeconds === undefined) return null;
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function serializeValue(value: unknown): {
  valueJson: string | null;
  valueText: string | null;
  sizeBytes: number;
} {
  if (typeof value === "string") {
    return {
      valueJson: null,
      valueText: value,
      sizeBytes: new TextEncoder().encode(value).byteLength
    };
  }

  const json = JSON.stringify(value);
  return {
    valueJson: json,
    valueText: null,
    sizeBytes: new TextEncoder().encode(json).byteLength
  };
}

export function parseCacheEntryValue(record: CacheEntryRecord): unknown {
  if (record.value_json !== null) {
    try {
      return JSON.parse(record.value_json) as unknown;
    } catch {
      return null;
    }
  }

  return record.value_text;
}

export function isCacheEntryExpired(record: CacheEntryRecord, now = new Date()): boolean {
  return Boolean(record.expires_at && new Date(record.expires_at).getTime() <= now.getTime());
}

export async function putCacheEntry(db: D1Database, input: PutCacheEntryInput): Promise<CacheEntryRecord> {
  const now = nowIso();
  const serialized = serializeValue(input.value);
  const expiresAt = getExpiresAt(input.ttlSeconds);
  const tags = JSON.stringify(input.tags ?? []);
  const existing = await getCacheEntry(db, {
    namespace: input.namespace,
    key: input.key,
    includeExpired: true
  });
  const id = existing?.id || newId("cache");
  const createdAt = existing?.created_at || now;

  await db
    .prepare(
      `INSERT INTO cache_entries (
        id, namespace, key, value_json, value_text, content_type, tags,
        size_bytes, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value_json = excluded.value_json,
        value_text = excluded.value_text,
        content_type = excluded.content_type,
        tags = excluded.tags,
        size_bytes = excluded.size_bytes,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
    )
    .bind(
      id,
      input.namespace,
      input.key,
      serialized.valueJson,
      serialized.valueText,
      input.contentType ?? null,
      tags,
      serialized.sizeBytes,
      expiresAt,
      createdAt,
      now
    )
    .run();

  return {
    id,
    namespace: input.namespace,
    key: input.key,
    value_json: serialized.valueJson,
    value_text: serialized.valueText,
    content_type: input.contentType ?? null,
    tags,
    size_bytes: serialized.sizeBytes,
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: now
  };
}

export async function getCacheEntry(
  db: D1Database,
  input: { namespace: string; key: string; includeExpired?: boolean }
): Promise<CacheEntryRecord | null> {
  const record = await db
    .prepare("SELECT * FROM cache_entries WHERE namespace = ? AND key = ?")
    .bind(input.namespace, input.key)
    .first<CacheEntryRecord>();

  if (!record) return null;
  if (!input.includeExpired && isCacheEntryExpired(record)) return null;
  return record;
}

export async function deleteCacheEntry(
  db: D1Database,
  input: { namespace: string; key: string }
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM cache_entries WHERE namespace = ? AND key = ?")
    .bind(input.namespace, input.key)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
