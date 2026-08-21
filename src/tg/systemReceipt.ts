import type { Env } from "../types";
import { canonicalJsonHash } from "../contracts/operiaProduct";
import { nowIso } from "../utils/time";
import { deliverTgOutbox, enqueueTgOutboxBatch } from "./outbox";
import { splitIntoBubbles } from "./telegram";

export type ActionOutcome = "Succeeded" | "Failed" | "Partial" | "Unknown";

export interface TgSystemReceiptInput {
  idempotencyKey: string;
  actionId: string;
  ownerDomain: string;
  actorId: string;
  requester: string;
  operation: string;
  outcome: ActionOutcome;
  target: { type: string; id: string };
  text: string;
  actorKind?: "owner" | "operia" | "codex" | "service";
  authorizedBy?: string;
  rootTaskId?: string;
  completed?: string[];
  unexecuted?: string[];
  unknown?: string[];
  errorCode?: string;
  nextStep?: string;
  canonicalLink?: string;
}

export interface TgSystemReceiptDelivery {
  receiptId: string;
  outcome: ActionOutcome;
  deliveryStatus: "Sent" | "AttentionRequired";
}

export async function deliverTgSystemReceipt(
  env: Env,
  chatId: string,
  input: TgSystemReceiptInput,
): Promise<TgSystemReceiptDelivery> {
  const now = nowIso();
  const proposedId = `rcpt_${crypto.randomUUID().replaceAll("-", "")}`;
  const requestHash = await canonicalJsonHash({ chatId, ...input });
  await env.DB.prepare(`INSERT INTO tg_system_receipts
      (receipt_id,idempotency_key,request_hash,action_id,root_task_id,owner_domain,actor_kind,actor_id,requester,
       authorized_by,source_surface,target_type,target_id,operation,outcome,completed_json,unexecuted_json,
       unknown_json,error_code,next_step,canonical_link,delivery_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'telegram',?,?,?,?,?,?,?,?,?,?,'Pending',?,?)
    ON CONFLICT(idempotency_key) DO NOTHING`)
    .bind(proposedId,input.idempotencyKey,requestHash,input.actionId,input.rootTaskId ?? null,input.ownerDomain,
      input.actorKind ?? "owner",input.actorId,input.requester,input.authorizedBy ?? null,
      input.target.type,input.target.id,input.operation,input.outcome,JSON.stringify(input.completed ?? []),
      JSON.stringify(input.unexecuted ?? []),JSON.stringify(input.unknown ?? []),input.errorCode ?? null,
      input.nextStep ?? null,input.canonicalLink ?? null,now,now).run();
  const receipt = await env.DB.prepare(`SELECT receipt_id,request_hash,outcome,delivery_status FROM tg_system_receipts
    WHERE idempotency_key=?`).bind(input.idempotencyKey).first<{
      receipt_id: string; request_hash: string; outcome: ActionOutcome; delivery_status: "Pending" | "Sent" | "AttentionRequired";
    }>();
  if (!receipt) throw new Error("tg_system_receipt_persist_failed");
  if (receipt.request_hash !== requestHash) throw new Error("tg_system_receipt_idempotency_conflict");
  if (receipt.delivery_status === "Sent" || receipt.delivery_status === "AttentionRequired") {
    return { receiptId: receipt.receipt_id, outcome: receipt.outcome, deliveryStatus: receipt.delivery_status };
  }
  const bubbles = splitIntoBubbles(input.text);
  if (bubbles.length === 0) bubbles.push("操作没有可显示的结果，请查看对应状态页。");
  const ids = await enqueueTgOutboxBatch(env.DB,bubbles.map((text,index) => ({
    id: crypto.randomUUID(),
    intentKey: `tg-receipt:${receipt.receipt_id}:v1:${index}`,
    chatId,
    payload: { text },
    receiptId: receipt.receipt_id,
    renderVersion: 1,
    bubbleIndex: index,
  })));
  let attention = false;
  for (const id of ids) {
    const result = await deliverTgOutbox(env,id);
    if (result === "attention_required" || result === "pending" || result === "noop") attention = true;
  }
  const deliveryStatus = attention ? "AttentionRequired" : "Sent";
  await env.DB.prepare(`UPDATE tg_system_receipts SET delivery_status=?,updated_at=? WHERE receipt_id=?`)
    .bind(deliveryStatus,nowIso(),receipt.receipt_id).run();
  return { receiptId: receipt.receipt_id, outcome: receipt.outcome, deliveryStatus };
}
