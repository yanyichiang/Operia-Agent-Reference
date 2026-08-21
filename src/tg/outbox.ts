import { nowIso } from "../utils/time";
import type { Env } from "../types";
import { sendTelegramIntent } from "./telegram";
import { openTgAttention, resolveTgAttention } from "./attention";
import {
  markNativeSafeRetryPending,
  markNativeTelegramRequestStarted,
  projectNativeBoundOutbox,
  publicationDeliveryAuthorityEnabled,
  readNativeTransportBinding,
  recordNativeTransportObservation,
  recoverNativeStaleSending,
  recoverNativeTerminalOutboxObservation,
  type NativeOutboxClaim,
  type NativeTransportBinding,
} from "./publicationDeliveryAuthority";

export type TgOutboxRow = { id: string; intent_key: string; chat_id: string; payload_json: string; status: string; attempts: number;
  lease_until:string | null; delivery_batch_key?: string | null; receipt_id?: string | null };

export type TgOutboxInput = { id: string; intentKey: string; chatId: string; payload: Record<string, unknown>;
  deliveryBatchKey?: string; receiptId?: string; renderVersion?: number; bubbleIndex?: number };
type TelegramIntentSender = typeof sendTelegramIntent;
const IDEMPOTENT_EDIT_MAX_ATTEMPTS = 3;
export const NATIVE_TELEGRAM_ATTEMPT_TIMEOUT_MS = 20_000;
export const NATIVE_OUTBOX_RECOVERY_MARGIN_MS = 10_000;
export const NATIVE_OUTBOX_CLAIM_LEASE_MS = 35_000;

// Native request-boundary invariant:
// - only the currently owned, unexpired claim may cross into Telegram;
// - the bounded preflight + request deadline ends before stale recovery may run;
// - after that boundary, an unestablished result is conservatively unknown.

class NativePostDeliveryPersistenceError extends Error {
  constructor(public readonly cause: unknown) {
    super("native_post_delivery_persistence_failed");
    this.name = "NativePostDeliveryPersistenceError";
  }
}

export type TgOutboxDeliveryOptions = {
  absoluteDeadlineMs?: number;
  requestTimeoutMs?: number;
};

async function readOutboxStatus(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT status FROM tg_agent_outbox WHERE id=?").bind(id).first<{ status: string }>();
  return row?.status ?? null;
}

async function syncReceiptDelivery(db: D1Database, receiptId: string | null | undefined): Promise<void> {
  if (!receiptId) return;
  const counts = await db.prepare(`SELECT
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='attention_required' THEN 1 ELSE 0 END) AS attention,
      COUNT(*) AS total
    FROM tg_agent_outbox WHERE receipt_id=?`).bind(receiptId)
    .first<{ sent: number; attention: number; total: number }>();
  const delivery = Number(counts?.attention || 0) > 0 ? "AttentionRequired"
    : Number(counts?.total || 0) > 0 && Number(counts?.sent || 0) === Number(counts?.total || 0) ? "Sent"
    : "Pending";
  await db.prepare(`UPDATE tg_system_receipts SET delivery_status=?,updated_at=? WHERE receipt_id=?`)
    .bind(delivery,nowIso(),receiptId).run();
}

function terminalDeliveryStatus(status: string | null): "sent" | "attention_required" | "noop" {
  if (status === "sent") return "sent";
  if (status === "attention_required") return "attention_required";
  return "noop";
}

export async function enqueueTgOutboxBatch(db: D1Database, inputs: TgOutboxInput[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const now = nowIso();
  const results = await db.batch<{ id:string }>(inputs.map((input) => db.prepare(`INSERT INTO tg_agent_outbox
    (id,intent_key,chat_id,payload_json,status,attempts,delivery_batch_key,receipt_id,render_version,bubble_index,created_at,updated_at)
    VALUES (?,?,?,?, 'pending',0,?,?,?,?,?,?)
    ON CONFLICT(intent_key) DO UPDATE SET
      delivery_batch_key=COALESCE(tg_agent_outbox.delivery_batch_key,excluded.delivery_batch_key),
      receipt_id=COALESCE(tg_agent_outbox.receipt_id,excluded.receipt_id),
      render_version=CASE WHEN tg_agent_outbox.receipt_id IS NULL THEN excluded.render_version ELSE tg_agent_outbox.render_version END,
      bubble_index=COALESCE(tg_agent_outbox.bubble_index,excluded.bubble_index),
      status=CASE
        WHEN tg_agent_outbox.status IN ('pending','attention_required') AND tg_agent_outbox.last_error='telegram_http_400' THEN 'pending'
        ELSE tg_agent_outbox.status END,
      payload_json=CASE
        WHEN tg_agent_outbox.status IN ('pending','attention_required') AND tg_agent_outbox.last_error='telegram_http_400' THEN excluded.payload_json
        ELSE tg_agent_outbox.payload_json END,
      last_error=CASE
        WHEN tg_agent_outbox.status IN ('pending','attention_required') AND tg_agent_outbox.last_error='telegram_http_400' THEN NULL
        ELSE tg_agent_outbox.last_error END,
      updated_at=CASE
        WHEN tg_agent_outbox.status IN ('pending','attention_required') AND tg_agent_outbox.last_error='telegram_http_400' THEN excluded.updated_at
        ELSE tg_agent_outbox.updated_at END
    RETURNING id`).bind(input.id,input.intentKey,input.chatId,JSON.stringify(input.payload),input.deliveryBatchKey ?? null,
      input.receiptId ?? null,input.renderVersion ?? 1,input.bubbleIndex ?? null,now,now)));
  return results.map((result) => {
    const row = result.results?.[0];
    if (!row?.id) throw new Error("outbox_insert_failed");
    return row.id;
  });
}

export async function enqueueTgOutbox(db: D1Database, input: TgOutboxInput): Promise<string> {
  const [id] = await enqueueTgOutboxBatch(db,[input]);
  if (!id) throw new Error("outbox_insert_failed");
  return id;
}

export async function claimTgOutbox(
  db: D1Database,
  id: string,
  leaseMs = 30_000,
  recoverExpiredSending = true,
  nowMs = Date.now(),
): Promise<TgOutboxRow | null> {
  const now = new Date(nowMs).toISOString(); const lease = new Date(nowMs + leaseMs).toISOString();
  if (recoverExpiredSending) {
    await db.prepare(`UPDATE tg_agent_outbox SET
      status=CASE WHEN json_extract(payload_json,'$.method')='editMessageText' AND attempts<?
        THEN 'pending' ELSE 'attention_required' END,
      last_error=CASE WHEN json_extract(payload_json,'$.method')='editMessageText' AND attempts<?
        THEN 'telegram_edit_outcome_unknown_retryable' ELSE 'send_outcome_unknown' END,
      lease_until=NULL,updated_at=?
      WHERE id=? AND status='sending' AND lease_until < ?`)
      .bind(IDEMPOTENT_EDIT_MAX_ATTEMPTS,IDEMPOTENT_EDIT_MAX_ATTEMPTS,now,id,now).run();
  }
  return db.prepare(`UPDATE tg_agent_outbox SET status='leased',lease_until=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND (status='pending' OR (status='leased' AND lease_until < ?))
    RETURNING id,intent_key,chat_id,payload_json,status,attempts,lease_until,delivery_batch_key,receipt_id`)
    .bind(lease, now, id, now).first<TgOutboxRow>();
}

export async function claimNativeTgOutbox(
  db: D1Database,
  id: string,
  nowMs = Date.now(),
): Promise<TgOutboxRow | null> {
  return claimTgOutbox(db,id,NATIVE_OUTBOX_CLAIM_LEASE_MS,false,nowMs);
}

function nativeClaim(row: TgOutboxRow): NativeOutboxClaim | null {
  return row.lease_until
    ? {outboxId:row.id,attempt:row.attempts,leaseUntil:row.lease_until}
    : null;
}

function nativeAttemptDeadlineMs(row: TgOutboxRow, options: TgOutboxDeliveryOptions): number {
  const now = Date.now();
  const requestedTimeout = Math.max(1,Math.min(
    NATIVE_TELEGRAM_ATTEMPT_TIMEOUT_MS,
    options.requestTimeoutMs ?? NATIVE_TELEGRAM_ATTEMPT_TIMEOUT_MS,
  ));
  const leaseDeadline = Date.parse(row.lease_until ?? "")-NATIVE_OUTBOX_RECOVERY_MARGIN_MS;
  return Math.min(
    now+requestedTimeout,
    options.absoluteDeadlineMs ?? Number.POSITIVE_INFINITY,
    leaseDeadline,
  );
}

function nativeLocalRejection(error: unknown): string | null {
  const code = error instanceof Error ? error.message : String(error);
  return /^(?:telegram_(?:intent_method_not_allowed|reply_markup_invalid|web_app_button_invalid))$/.test(code)
    ? code : null;
}

async function deliverNativeClaimedOutbox(
  env: Env,
  row: TgOutboxRow,
  binding: NativeTransportBinding,
  sendIntent: TelegramIntentSender,
  options: TgOutboxDeliveryOptions,
): Promise<"sent" | "pending" | "attention_required" | "noop"> {
  const claim = nativeClaim(row);
  if (!claim) return "noop";
  const requestDeadlineMs = nativeAttemptDeadlineMs(row,options);
  if (!Number.isFinite(requestDeadlineMs) || requestDeadlineMs <= Date.now()) {
    return await markNativeSafeRetryPending(env.DB,{
      claim,expectedSourceState:"leased",errorCode:"telegram_native_attempt_deadline_elapsed",
    }) ? "pending" : "noop";
  }
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort("tg_outbox_send_deadline"),
    Math.max(1,requestDeadlineMs-Date.now()),
  );
  let requestStarted = false;
  const onTelegramRequestStart = async (): Promise<void> => {
    if (requestStarted) return;
    if (controller.signal.aborted || Date.now() >= requestDeadlineMs
      || !await markNativeTelegramRequestStarted(env.DB,claim)) {
      throw new Error("tg_outbox_send_lease_lost");
    }
    requestStarted = true;
  };
  const record = async (
    evidenceClass:"sent" | "rejected" | "unknown",
    legacyErrorCode:string | null,
    transportMessageId?:string,
  ): Promise<boolean> => {
    const result = await recordNativeTransportObservation(env,{
      binding,claim,expectedSourceState:requestStarted ? "sending" : "leased",
      evidenceClass,transportMessageId,legacyErrorCode,
    });
    return result.kind !== "lost_ownership";
  };
  const safelyPend = async (errorCode: string): Promise<"pending" | "noop"> => {
    const changed = await markNativeSafeRetryPending(env.DB,{
      claim,expectedSourceState:requestStarted ? "sending" : "leased",errorCode,
    });
    return changed ? "pending" : "noop";
  };
  let method = "sendMessage";
  try {
    const payload = JSON.parse(row.payload_json) as Record<string,unknown>;
    method = typeof payload.method === "string" ? payload.method : "sendMessage";
    const result = await sendIntent(env,row.chat_id,payload,{
      signal:controller.signal,
      onTelegramRequestStart,
    });
    if (result.accepted) {
      if (!requestStarted) {
        throw new NativePostDeliveryPersistenceError(new Error("telegram_request_boundary_missing"));
      }
      try {
        if (!await record("sent",null,result.messageId)) return "noop";
      } catch (error) {
        throw new NativePostDeliveryPersistenceError(error);
      }
      await resolveTgAttention(env.DB,`telegram.delivery:${row.id}`,"telegram_delivery_confirmed")
        .catch(() => false);
      await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
      return "sent";
    }

    const definitiveRejection = result.error === "telegram_http_400"
      || result.error === "telegram_intent_method_not_allowed";
    if (definitiveRejection) {
      try {
        if (!await record("rejected",result.error ?? "telegram_delivery_rejected")) return "noop";
      } catch (error) {
        throw new NativePostDeliveryPersistenceError(error);
      }
      await openTgAttention(env.DB,{
        dedupeKey:`telegram.delivery:${row.id}`,
        ownerDomain:"tgbot.example.com",objectId:row.id,kind:"telegram_delivery_rejected",
        severity:"warning",summary:"Telegram 明确拒绝了这条投递；原 intent 已冻结，修复必须创建新 intent。",
        canonicalLink:"https://tgbot.example.com/admin#delivery",
      }).catch(() => undefined);
      await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
      return "attention_required";
    }
    if (!requestStarted) {
      const pending = await safelyPend(result.error ?? "telegram_preflight_retryable");
      if (pending === "pending") await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
      return pending;
    }
    if (binding.effectSafety === "idempotent_edit" && claim.attempt < IDEMPOTENT_EDIT_MAX_ATTEMPTS) {
      const pending = await safelyPend(result.error ?? "telegram_edit_outcome_unknown_retryable");
      if (pending === "pending") await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
      return pending;
    }
    if (!await record("unknown","telegram_send_outcome_unknown")) return "noop";
    await openTgAttention(env.DB,{
      dedupeKey:`telegram.delivery:${row.id}`,
      ownerDomain:"tgbot.example.com",objectId:row.id,kind:"telegram_delivery_unknown",
      severity:"warning",summary:"Telegram 投递结果未知；不会自动重放。",
      canonicalLink:"https://tgbot.example.com/admin#delivery",
    }).catch(() => undefined);
    await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
    return "attention_required";
  } catch (error) {
    if (error instanceof NativePostDeliveryPersistenceError) throw error.cause;
    const localRejection = !requestStarted ? nativeLocalRejection(error) : null;
    if (localRejection) {
      try {
        if (!await record("rejected",localRejection)) return "noop";
      } catch (persistenceError) {
        throw persistenceError;
      }
      await openTgAttention(env.DB,{
        dedupeKey:`telegram.delivery:${row.id}`,
        ownerDomain:"tgbot.example.com",objectId:row.id,kind:"telegram_delivery_rejected",
        severity:"warning",summary:"本地 Telegram 校验确定性拒绝了这条投递；修复必须创建新 intent。",
        canonicalLink:"https://tgbot.example.com/admin#delivery",
      }).catch(() => undefined);
      await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
      return "attention_required";
    }
    const retryableEdit = binding.effectSafety === "idempotent_edit"
      && claim.attempt < IDEMPOTENT_EDIT_MAX_ATTEMPTS;
    if (!requestStarted) {
      return safelyPend("telegram_preflight_retryable");
    }
    if (retryableEdit) {
      return safelyPend("telegram_edit_outcome_unknown_retryable");
    }
    const exceptionKind = error instanceof DOMException && error.name === "AbortError"
      ? "abort" : error instanceof TypeError ? "type_error" : error instanceof Error ? "error" : "unknown";
    console.warn("tg_outbox_send_outcome_unknown",{
      outboxId:row.id,method,exceptionKind,retryable:false,nativeAuthority:true,
    });
    if (!await record("unknown","telegram_send_outcome_unknown")) return "noop";
    await openTgAttention(env.DB,{
      dedupeKey:`telegram.delivery:${row.id}`,
      ownerDomain:"tgbot.example.com",objectId:row.id,kind:"telegram_delivery_unknown",
      severity:"warning",summary:"Telegram 投递结果未知；不会自动重放。",
      canonicalLink:"https://tgbot.example.com/admin#delivery",
    }).catch(() => undefined);
    await syncReceiptDelivery(env.DB,row.receipt_id).catch(() => undefined);
    return "attention_required";
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function deliverTgOutbox(
  env: Env,
  id: string,
  sendIntent: TelegramIntentSender = sendTelegramIntent,
  options: TgOutboxDeliveryOptions = {},
): Promise<"sent" | "pending" | "attention_required" | "noop"> {
  const nativeAuthority = publicationDeliveryAuthorityEnabled(env);
  const absoluteDeadlineMs = options.absoluteDeadlineMs;
  if (absoluteDeadlineMs !== undefined && absoluteDeadlineMs <= Date.now()) {
    const terminal = terminalDeliveryStatus(await readOutboxStatus(env.DB, id));
    return terminal === "noop" ? "pending" : terminal;
  }
  // A persisted native intent keeps its delivery authority if the rollout flag
  // is later disabled. The stable native id prefix avoids publication-table IO
  // for ordinary flag-off legacy outbox rows.
  const nativeBinding = nativeAuthority || id.startsWith("tg-native:")
    ? await readNativeTransportBinding(env.DB,id) : null;
  if (nativeBinding) {
    const recoveredTerminal = await recoverNativeTerminalOutboxObservation(env,id);
    if (recoveredTerminal) return recoveredTerminal;
    const recovered = await recoverNativeStaleSending(env,id);
    if (recovered) return recovered;
  }
  const row = nativeBinding
    ? await claimNativeTgOutbox(env.DB,id)
    : await claimTgOutbox(env.DB,id);
  if (!row) {
    if (nativeBinding) {
      const recoveredTerminal = await recoverNativeTerminalOutboxObservation(env,id);
      if (recoveredTerminal) return recoveredTerminal;
    }
    const terminal = terminalDeliveryStatus(await readOutboxStatus(env.DB,id));
    if (nativeBinding && terminal !== "noop") await projectNativeBoundOutbox(env.DB,id);
    return terminal;
  }
  if (nativeBinding) {
    return deliverNativeClaimedOutbox(env,row,nativeBinding,sendIntent,options);
  }
  const now = nowIso();
  const sendLease = await env.DB.prepare(`UPDATE tg_agent_outbox SET status='sending',updated_at=?
    WHERE id=? AND status='leased' RETURNING id`).bind(now, id).first<{id:string}>();
  if (!sendLease) return terminalDeliveryStatus(await readOutboxStatus(env.DB, id));
  const requestDeadlineMs = options.requestTimeoutMs === undefined
    ? absoluteDeadlineMs
    : Date.now() + Math.max(1, options.requestTimeoutMs);
  const controller = requestDeadlineMs === undefined ? null : new AbortController();
  const deadlineTimer = controller && requestDeadlineMs !== undefined
    ? setTimeout(() => controller.abort("tg_outbox_send_deadline"), Math.max(1, requestDeadlineMs - Date.now()))
    : null;
  let method = "sendMessage";
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    method = typeof payload.method === "string" ? payload.method : "sendMessage";
    const result = controller
      ? await sendIntent(env, row.chat_id, payload, { signal: controller.signal })
      : await sendIntent(env, row.chat_id, payload);
    if (!result.accepted) {
      const definitiveRejection = result.error === "telegram_http_400";
      const pending = await env.DB.prepare(`UPDATE tg_agent_outbox SET status=?,last_error=?,
        lease_until=NULL,updated_at=? WHERE id=? AND status='sending' RETURNING id`)
        .bind(definitiveRejection ? "attention_required" : "pending", result.error, nowIso(), id).first<{id:string}>();
      if (pending && definitiveRejection) {
        await openTgAttention(env.DB, {
          dedupeKey: `telegram.delivery:${id}`,
          ownerDomain: "tgbot.example.com", objectId: id, kind: "telegram_delivery_rejected",
          severity: "warning", summary: "Telegram 明确拒绝了这条投递；需要修复 payload 后再决定是否重建。",
          canonicalLink: "https://tgbot.example.com/admin#delivery",
        });
      }
      await syncReceiptDelivery(env.DB,row.receipt_id);
      return pending ? definitiveRejection ? "attention_required" : "pending" : terminalDeliveryStatus(await readOutboxStatus(env.DB, id));
    }
    const sent = await env.DB.prepare(`UPDATE tg_agent_outbox SET status='sent',telegram_message_id=?,
      lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='sending' RETURNING id`)
      .bind(result.messageId ?? null, nowIso(), id).first<{id:string}>();
    if (sent) {
      await resolveTgAttention(env.DB,`telegram.delivery:${id}`,"telegram_delivery_confirmed");
      await syncReceiptDelivery(env.DB,row.receipt_id);
      return "sent";
    }
    return terminalDeliveryStatus(await readOutboxStatus(env.DB, id)) === "sent" ? "sent" : "attention_required";
  } catch (error) {
    const retryableEdit = method === "editMessageText" && row.attempts < IDEMPOTENT_EDIT_MAX_ATTEMPTS;
    const exceptionKind = error instanceof DOMException && error.name === "AbortError"
      ? "abort" : error instanceof TypeError ? "type_error" : error instanceof Error ? "error" : "unknown";
    console.warn("tg_outbox_send_outcome_unknown", { outboxId:id,method,exceptionKind,retryable:retryableEdit });
    const retry = retryableEdit
      ? await env.DB.prepare(`UPDATE tg_agent_outbox SET status='pending',
          last_error='telegram_edit_outcome_unknown_retryable',lease_until=NULL,updated_at=?
          WHERE id=? AND status='sending' RETURNING id`).bind(nowIso(),id).first<{id:string}>()
      : null;
    if (retry) return "pending";
    const attention = await env.DB.prepare(`UPDATE tg_agent_outbox SET status='attention_required',
      last_error='telegram_send_outcome_unknown',lease_until=NULL,updated_at=?
      WHERE id=? AND status='sending' RETURNING id`).bind(nowIso(),id).first<{id:string}>();
    if (attention) {
      await openTgAttention(env.DB, {
        dedupeKey: `telegram.delivery:${id}`,
        ownerDomain: "tgbot.example.com",
        objectId: id,
        kind: "telegram_delivery_unknown",
        severity: "warning",
        summary: "Telegram 投递结果未知；不会自动重放。",
        canonicalLink: "https://tgbot.example.com/admin#delivery",
      });
    }
    await syncReceiptDelivery(env.DB,row.receipt_id);
    return attention ? "attention_required" : terminalDeliveryStatus(await readOutboxStatus(env.DB,id));
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

export async function resumePendingTgOutbox(env: Env, limit = 20): Promise<number> {
  const unresolved = await env.DB.prepare(`SELECT id FROM tg_agent_outbox WHERE status='attention_required'
    ORDER BY updated_at DESC LIMIT ?`).bind(limit).all<{ id: string }>();
  for (const row of unresolved.results ?? []) {
    const now = nowIso();
    await env.DB.prepare(`INSERT OR IGNORE INTO tg_attention
      (attention_id,dedupe_key,owner_domain,object_id,kind,severity,status,summary,
       occurrence_count,first_seen_at,last_seen_at,canonical_link)
      VALUES (?,?, 'tgbot.example.com',?,'telegram_delivery_attention','warning','open',?,1,?,?,?)`)
      .bind(`att_${crypto.randomUUID().replaceAll("-","")}`,`telegram.delivery:${row.id}`,row.id,
        "Telegram 投递需要人工检查；系统不会盲目重放。",now,now,
        "https://tgbot.example.com/admin#delivery").run();
  }
  const rows = await env.DB.prepare(`SELECT id FROM tg_agent_outbox
    WHERE delivery_batch_key IS NULL AND (status='pending'
      OR (status='leased' AND (lease_until IS NULL OR lease_until < ?))
      OR (status='sending' AND lease_until IS NOT NULL AND lease_until < ?))
    ORDER BY updated_at LIMIT ?`)
    .bind(nowIso(), nowIso(), limit).all<{ id: string }>();
  let sent = 0;
  for (const row of rows.results ?? []) {
    if (await deliverTgOutbox(env, row.id) === "sent") sent += 1;
  }
  return sent;
}
