import { nowIso } from "../utils/time";

export interface TgChatConfig {
  model: string;
  pendingCommand: string | null;
  pendingPayload: string | null;
  pendingActionId: string | null;
  pendingNonce: string | null;
  pendingRevision: number;
  pendingExpiresAt: string | null;
  voicePolicy: "off" | "auto";
  voiceOnce: boolean;
  voiceModel: VoiceModel;
}

export interface TgPendingAction {
  actionId: string;
  nonce: string;
  revision: number;
  command: string;
  payload: string | null;
  expiresAt: string;
}

const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export type VoiceModel = "realtime" | "quality" | "expressive";

export function normalizeVoiceModel(value: unknown): VoiceModel {
  return value === "realtime" || value === "quality" ? value : "expressive";
}

export async function getChatConfig(db: D1Database, chatId: string): Promise<TgChatConfig> {
  const row = await db
    .prepare(`SELECT model,pending_command,pending_payload,pending_action_id,pending_nonce,
      pending_revision,pending_expires_at,voice_policy,voice_once,voice_model
      FROM tg_chat_config WHERE chat_id = ?`)
    .bind(chatId)
    .first<{ model: string; pending_command: string | null; pending_payload: string | null;
      pending_action_id: string | null; pending_nonce: string | null; pending_revision: number;
      pending_expires_at: string | null; voice_policy: string; voice_once: number; voice_model: string }>();
  const pendingFresh = Boolean(row?.pending_command && row.pending_action_id && row.pending_nonce
    && row.pending_expires_at && Date.parse(row.pending_expires_at) > Date.now());
  return {
    model: row?.model || "companion",
    pendingCommand: pendingFresh ? row?.pending_command ?? null : null,
    pendingPayload: pendingFresh ? row?.pending_payload ?? null : null,
    pendingActionId: pendingFresh ? row?.pending_action_id ?? null : null,
    pendingNonce: pendingFresh ? row?.pending_nonce ?? null : null,
    pendingRevision: Number(row?.pending_revision || 0),
    pendingExpiresAt: pendingFresh ? row?.pending_expires_at ?? null : null,
    voicePolicy: row?.voice_policy === "auto" ? "auto" : "off",
    voiceOnce: row?.voice_once === 1,
    voiceModel: normalizeVoiceModel(row?.voice_model),
  };
}

export async function setVoiceMode(db: D1Database, chatId: string, mode: "off" | "once" | "auto", voiceModel?: VoiceModel): Promise<void> {
  const policy = mode === "auto" ? "auto" : "off";
  const once = mode === "once" ? 1 : 0;
  const selected = voiceModel ?? "expressive";
  await db.prepare(`INSERT INTO tg_chat_config (chat_id,voice_policy,voice_once,voice_model,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET voice_policy=excluded.voice_policy,voice_once=excluded.voice_once,
      voice_model=CASE WHEN ? THEN excluded.voice_model ELSE tg_chat_config.voice_model END,updated_at=excluded.updated_at`)
    .bind(chatId, policy, once, selected, nowIso(), voiceModel ? 1 : 0).run();
}

export async function consumeVoiceOnce(db: D1Database, chatId: string): Promise<boolean> {
  const row = await db.prepare("UPDATE tg_chat_config SET voice_once=0,updated_at=? WHERE chat_id=? AND voice_once=1 RETURNING chat_id")
    .bind(nowIso(), chatId).first<{ chat_id: string }>();
  return Boolean(row);
}

export async function setChatModel(db: D1Database, chatId: string, model: string): Promise<void> {
  await db.prepare(
    `INSERT INTO tg_chat_config (chat_id, model, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`
  ).bind(chatId, model, nowIso()).run();
}

export async function setPendingCommand(
  db: D1Database,
  chatId: string,
  command: string | null,
  payload: string | null = null
): Promise<TgPendingAction | null> {
  const actionId = command ? `pa_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` : null;
  const nonce = command ? crypto.randomUUID().replaceAll("-", "").slice(0, 16) : null;
  const expiresAt = command ? new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString() : null;
  const row = await db.prepare(
    `INSERT INTO tg_chat_config
       (chat_id,pending_command,pending_payload,pending_action_id,pending_nonce,pending_revision,pending_expires_at,updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       pending_command = excluded.pending_command,
       pending_payload = excluded.pending_payload,
       pending_action_id = excluded.pending_action_id,
       pending_nonce = excluded.pending_nonce,
       pending_revision = tg_chat_config.pending_revision + 1,
       pending_expires_at = excluded.pending_expires_at,
       updated_at = excluded.updated_at`
  ).bind(chatId, command, payload, actionId, nonce, expiresAt, nowIso()).run();
  void row;
  if (!command || !actionId || !nonce || !expiresAt) return null;
  const current = await db.prepare(`SELECT pending_revision FROM tg_chat_config WHERE chat_id=?`)
    .bind(chatId).first<{ pending_revision: number }>();
  return { actionId, nonce, revision: Number(current?.pending_revision || 1), command, payload, expiresAt };
}

export async function consumePendingCommand(
  db: D1Database,
  chatId: string,
  expected: { command: string; actionId: string; nonce: string; revision: number; payload?: string | null; expiresAt?: string },
): Promise<TgPendingAction | null> {
  const now = nowIso();
  const row = await db.prepare(`UPDATE tg_chat_config SET
      pending_command=NULL,pending_payload=NULL,pending_action_id=NULL,pending_nonce=NULL,
      pending_expires_at=NULL,pending_revision=pending_revision+1,updated_at=?
    WHERE chat_id=? AND pending_command=? AND pending_action_id=? AND pending_nonce=?
      AND pending_revision=? AND pending_expires_at>?
    RETURNING chat_id`)
    .bind(now,chatId,expected.command,expected.actionId,expected.nonce,expected.revision,now)
    .first<{ chat_id: string }>();
  if (!row) return null;
  return {
    actionId: expected.actionId,
    nonce: expected.nonce,
    revision: expected.revision,
    command: expected.command,
    payload: expected.payload ?? null,
    expiresAt: expected.expiresAt ?? now,
  };
}

export async function getTgSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value_json FROM tg_settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  if (!row) return fallback;
  try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
}

export async function setTgSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(`INSERT INTO tg_settings (key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify(value), nowIso()).run();
}

export async function recordTgEvent(
  db: D1Database,
  input: { chatId?: string; eventType: string; status: string; metadata?: Record<string, unknown> }
): Promise<void> {
  await db.prepare(
    "INSERT INTO tg_events (chat_id, event_type, status, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    input.chatId ?? null,
    input.eventType,
    input.status,
    JSON.stringify(input.metadata ?? {}),
    nowIso()
  ).run();
}
