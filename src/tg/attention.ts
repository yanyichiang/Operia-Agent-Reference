import { nowIso } from "../utils/time";

export interface TgAttentionInput {
  dedupeKey: string;
  ownerDomain: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  objectId?: string;
  taskId?: string;
  canonicalLink?: string;
}

export interface TgAttentionRow {
  attention_id: string;
  dedupe_key: string;
  owner_domain: string;
  object_id: string | null;
  task_id: string | null;
  kind: string;
  severity: string;
  status: "open" | "resolved";
  summary: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolution: string | null;
  resolved_at: string | null;
  canonical_link: string | null;
}

export async function openTgAttention(db: D1Database, input: TgAttentionInput): Promise<string> {
  const now = nowIso();
  const id = `att_${crypto.randomUUID().replaceAll("-", "")}`;
  const row = await db.prepare(`INSERT INTO tg_attention
      (attention_id,dedupe_key,owner_domain,object_id,task_id,kind,severity,status,summary,
       occurrence_count,first_seen_at,last_seen_at,canonical_link)
    VALUES (?,?,?,?,?,?,?,'open',?,1,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      owner_domain=excluded.owner_domain,object_id=excluded.object_id,task_id=excluded.task_id,
      kind=excluded.kind,severity=excluded.severity,status='open',summary=excluded.summary,
      occurrence_count=CASE WHEN tg_attention.status='open' THEN tg_attention.occurrence_count+1 ELSE 1 END,
      first_seen_at=CASE WHEN tg_attention.status='open' THEN tg_attention.first_seen_at ELSE excluded.first_seen_at END,
      last_seen_at=excluded.last_seen_at,resolution=NULL,resolved_at=NULL,
      canonical_link=excluded.canonical_link
    RETURNING attention_id`)
    .bind(id,input.dedupeKey,input.ownerDomain,input.objectId ?? null,input.taskId ?? null,
      input.kind,input.severity,input.summary,now,now,input.canonicalLink ?? null)
    .first<{ attention_id: string }>();
  if (!row?.attention_id) throw new Error("tg_attention_upsert_failed");
  return row.attention_id;
}

export async function resolveTgAttention(db: D1Database, dedupeKey: string, resolution: string): Promise<boolean> {
  const now = nowIso();
  const row = await db.prepare(`UPDATE tg_attention SET status='resolved',resolution=?,resolved_at=?,last_seen_at=?
    WHERE dedupe_key=? AND status='open' RETURNING attention_id`)
    .bind(resolution.slice(0,500),now,now,dedupeKey).first<{ attention_id: string }>();
  return Boolean(row?.attention_id);
}

export async function listOpenTgAttention(db: D1Database, limit = 30): Promise<TgAttentionRow[]> {
  const rows = await db.prepare(`SELECT attention_id,dedupe_key,owner_domain,object_id,task_id,kind,severity,
      status,summary,occurrence_count,first_seen_at,last_seen_at,resolution,resolved_at,canonical_link
    FROM tg_attention WHERE status='open' ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT ?`)
    .bind(Math.max(1,Math.min(100,limit))).all<TgAttentionRow>();
  return rows.results ?? [];
}
