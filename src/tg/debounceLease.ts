const MIN_LEASE_SECONDS = 5;
const MAX_LEASE_SECONDS = 300;

export type TgDebounceLease = {
  acquired: boolean;
  leaseUntil: string;
  retryAfterMs: number;
};

export function boundedTgDebounceLeaseSeconds(value: number): number {
  return Math.max(MIN_LEASE_SECONDS, Math.min(MAX_LEASE_SECONDS, Math.ceil(value)));
}

/** Atomically acquire the single durable debounce leader slot for one chat. */
export async function acquireTgDebounceLease(
  db: D1Database,
  chatId: string,
  leaseToken: string,
  leaseSeconds: number,
  nowMs = Date.now(),
): Promise<TgDebounceLease> {
  const now = new Date(nowMs).toISOString();
  const leaseUntil = new Date(nowMs + boundedTgDebounceLeaseSeconds(leaseSeconds) * 1000).toISOString();
  const acquired = await db.prepare(`INSERT INTO tg_debounce_leases
    (chat_id,lease_token,lease_until,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE tg_debounce_leases.lease_until <= excluded.updated_at
    RETURNING lease_token,lease_until`)
    .bind(chatId,leaseToken,leaseUntil,now)
    .first<{ lease_token: string; lease_until: string }>();
  if (acquired?.lease_token === leaseToken) return { acquired:true,leaseUntil:acquired.lease_until,retryAfterMs:0 };
  const held = await db.prepare("SELECT lease_until FROM tg_debounce_leases WHERE chat_id=?")
    .bind(chatId).first<{ lease_until: string }>();
  const heldUntilMs = Date.parse(held?.lease_until ?? "");
  return {
    acquired:false,
    leaseUntil:held?.lease_until ?? now,
    retryAfterMs:Number.isFinite(heldUntilMs) ? Math.max(1_000,heldUntilMs-nowMs) : 1_000,
  };
}

export async function renewTgDebounceLease(
  db: D1Database,
  chatId: string,
  leaseToken: string,
  leaseSeconds: number,
  nowMs = Date.now(),
): Promise<boolean> {
  const now = new Date(nowMs).toISOString();
  const leaseUntil = new Date(nowMs + boundedTgDebounceLeaseSeconds(leaseSeconds) * 1000).toISOString();
  const renewed = await db.prepare(`UPDATE tg_debounce_leases SET lease_until=?,updated_at=?
    WHERE chat_id=? AND lease_token=? RETURNING lease_token`)
    .bind(leaseUntil,now,chatId,leaseToken).first<{ lease_token: string }>();
  return renewed?.lease_token === leaseToken;
}

export async function releaseTgDebounceLease(
  db: D1Database,
  chatId: string,
  leaseToken: string,
): Promise<void> {
  await db.prepare("DELETE FROM tg_debounce_leases WHERE chat_id=? AND lease_token=?")
    .bind(chatId,leaseToken).run();
}

/** Recover only this chat after both the inbox claim and chat lease expired. */
export async function recoverExpiredInboxClaimsForChat(
  db: D1Database,
  chatId: string,
  nowMs = Date.now(),
): Promise<number> {
  const result = await db.prepare(`UPDATE tg_inbox SET processed=0,claim_token=NULL,claim_lease_until=NULL
    WHERE chat_id=? AND processed=1 AND handed_off_at IS NULL
      AND claim_lease_until IS NOT NULL AND claim_lease_until <= ?`)
    .bind(chatId,new Date(nowMs).toISOString()).run();
  return result.meta.changes ?? 0;
}
