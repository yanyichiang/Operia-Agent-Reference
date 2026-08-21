import type { Env, QueueMessage } from "../types";
import { newId } from "../utils/ids";
import { isV2Enabled } from "../memory/v2/recall";
import { prepareNightReviewRun } from "../memory/vnext/nightReviewRuntime";

/**
 * Send a queue message. Uses real Cloudflare Queue when MEMORY_QUEUE binding
 * is available; falls back to direct handleQueueMessage for local dev / no-queue.
 */
async function sendQueueMessage(
  env: Env,
  message: QueueMessage,
  options?: { delaySeconds?: number }
): Promise<void> {
  if (await isAgentRoomQueueMessage(env, message)) {
    if (!env.TG_ROOM_QUEUE) throw new Error("tg_room_queue_binding_missing");
    await env.TG_ROOM_QUEUE.send(message, options);
    return;
  }
  if (env.MEMORY_QUEUE) {
    await env.MEMORY_QUEUE.send(message, options);
  } else {
    // Dynamic loading keeps the existing local direct fallback without
    // creating a producer <-> consumer module cycle for Gate-D follow-ups.
    const { handleQueueMessage } = await import("./consumer");
    await handleQueueMessage(message, env);
  }
}

async function chatIdForQueueMessage(env: Env, message: QueueMessage): Promise<string | null> {
  if (message.type === "tg_process") return message.chatId;
  if (message.type === "tg_inference_ready") {
    const batchKey = message.idempotencyKey.replace(/^tg:/, "");
    if (!/^[a-f0-9]{64}$/.test(batchKey)) return null;
    const row = await env.DB.prepare("SELECT chat_id FROM tg_chat_inference_runs WHERE batch_key=?")
      .bind(batchKey).first<{ chat_id: string }>();
    return row?.chat_id || null;
  }
  if (["tg_inference_resume", "tg_inference_watchdog", "tg_conversation_append", "tg_inference_delivery"].includes(message.type)) {
    const batchKey = (message as { batchKey: string }).batchKey;
    const row = await env.DB.prepare("SELECT chat_id FROM tg_chat_inference_runs WHERE batch_key=?")
      .bind(batchKey).first<{ chat_id: string }>();
    return row?.chat_id || null;
  }
  return null;
}

export async function isAgentRoomQueueMessage(env: Env, message: QueueMessage): Promise<boolean> {
  const chatId = await chatIdForQueueMessage(env, message);
  if (!chatId?.startsWith("-")) return false;
  const room = await env.DB.prepare("SELECT 1 AS found FROM tg_agent_rooms WHERE chat_id=? AND status='active'")
    .bind(chatId).first<{ found: number }>();
  return room?.found === 1;
}

export async function enqueueTgProcess(env: Env, chatId: string, delaySeconds: number): Promise<void> {
  await sendQueueMessage(env, { type: "tg_process", chatId }, { delaySeconds });
}

/** Webhook handoff must never fall back to running inference in the HTTP invocation. */
export async function enqueueTgProcessFromWebhook(env: Env, chatId: string, delaySeconds: number): Promise<void> {
  const message: QueueMessage = { type: "tg_process", chatId };
  if (await isAgentRoomQueueMessage(env, message)) {
    if (!env.TG_ROOM_QUEUE) throw new Error("tg_room_queue_binding_missing");
    await env.TG_ROOM_QUEUE.send(message, { delaySeconds });
    return;
  }
  if (!env.MEMORY_QUEUE) throw new Error("tg_process_queue_binding_missing");
  await env.MEMORY_QUEUE.send(message, { delaySeconds });
}

export async function enqueueTgInferenceResume(env: Env, batchKey: string, delaySeconds: number): Promise<void> {
  await sendQueueMessage(env, { type: "tg_inference_resume", batchKey }, { delaySeconds });
}

export async function enqueueTgInferenceReady(env: Env, idempotencyKey: string): Promise<void> {
  if (!/^tg:[a-f0-9]{64}$/.test(idempotencyKey)) return;
  const message: QueueMessage = { type: "tg_inference_ready", idempotencyKey };
  if (await isAgentRoomQueueMessage(env, message)) {
    if (!env.TG_ROOM_QUEUE) throw new Error("tg_room_queue_binding_missing");
    await env.TG_ROOM_QUEUE.send(message);
    return;
  }
  if (!env.TG_QUEUE) return;
  await env.TG_QUEUE.send(message);
}

export async function enqueueTgInferenceWatchdog(
  env: Env,
  batchKey: string,
  probe: number,
  delaySeconds: number,
): Promise<void> {
  if (!env.MEMORY_QUEUE && delaySeconds > 0) return;
  await sendQueueMessage(env, { type: "tg_inference_watchdog", batchKey, probe }, { delaySeconds });
}

export async function enqueueTgConversationAppend(env: Env, batchKey: string): Promise<void> {
  await sendQueueMessage(env, { type: "tg_conversation_append", batchKey });
}

export async function enqueueTgInferenceDelivery(
  env: Env,
  batchKey: string,
  delaySeconds = 0,
): Promise<void> {
  // The local no-Queue fallback executes synchronously. A delayed watchdog in
  // that mode would recurse before the current delivery can advance.
  if (!env.MEMORY_QUEUE && delaySeconds > 0) return;
  await sendQueueMessage(env, { type: "tg_inference_delivery", batchKey }, { delaySeconds });
}

export async function enqueueThinkSdkActionDecision(
  env: Env,
  approvalRef: string,
  attempt = 0,
  delaySeconds = 0,
): Promise<void> {
  // Approval callbacks must never fall back to synchronous SDK execution in
  // the HTTP invocation. Missing Queue admission is a visible 503 and the D1
  // reservation is released by the caller.
  if (!env.MEMORY_QUEUE) throw new Error("think_sdk_action_decision_queue_binding_missing");
  await env.MEMORY_QUEUE.send({ type: "think_sdk_action_decision", approvalRef, attempt }, { delaySeconds });
}

export async function enqueueThinkSdkActionState(
  env: Env,
  requestId: string,
  attempt = 0,
  delaySeconds = 0,
): Promise<void> {
  // A local direct fallback may project an immediate terminal hook, but it
  // cannot emulate a delayed watchdog without recursively spinning.
  if (!env.MEMORY_QUEUE && delaySeconds > 0) return;
  await sendQueueMessage(env, { type: "think_sdk_action_state", requestId, attempt }, { delaySeconds });
}

export async function enqueueHrsThinkRecovery(
  env: Env,
  executionId: string,
  attempt = 0,
  delaySeconds = 1,
): Promise<boolean> {
  // Durable Think recovery must never recurse synchronously in a no-Queue
  // development process. The minute scanner remains a second durable wake.
  if (!env.MEMORY_QUEUE) return false;
  await env.MEMORY_QUEUE.send({ type:"hrs_think_recover",executionId,attempt },{
    delaySeconds:Math.max(0,Math.min(900,Math.floor(delaySeconds))),
  });
  return true;
}

export async function enqueueMemoryMaintenanceIfNeeded(
  env: Env,
  input: {
    namespace: string;
    conversationId: string;
    fromMessageId?: string;
    toMessageId: string;
    source: string;
  }
): Promise<void> {
  if (env.ENABLE_AUTO_MEMORY === "false") return;
  if (isV2Enabled(env)) {
    if (env.MEMORY_EPISODIC_WRITE_ENABLED === "false") return;
    await sendQueueMessage(env, { type: "episodic_index", namespace: input.namespace });
    return;
  }
  if ((env.MEMORY_MODE || "external") === "none") return;
  if (!input.fromMessageId) return;

  const message: QueueMessage = {
    type: "memory_maintenance",
    namespace: input.namespace,
    conversationId: input.conversationId,
    fromMessageId: input.fromMessageId,
    toMessageId: input.toMessageId,
    source: input.source,
    idempotencyKey: newId("idem")
  };

  await sendQueueMessage(env, message);
}

export async function enqueueDailyMemoryAutomation(env: Env, namespace: string): Promise<void> {
  const runValue = Number(env.DREAM_MAX_RUNS || env.DAILY_DIGEST_MAX_RUNS || 10);
  const remainingRuns = Number.isFinite(runValue) ? Math.min(Math.max(Math.floor(runValue), 1), 10) : 10;
  const judgeValue = Number(env.JUDGE_MAX_CANDIDATES || 20);
  const remainingCandidates = Number.isFinite(judgeValue)
    ? Math.min(Math.max(Math.floor(judgeValue), 1), 200)
    : 20;

  await Promise.all([
    sendQueueMessage(env, { type: "dream_digest", namespace, remainingRuns }),
    sendQueueMessage(env, { type: "candidate_judge", namespace, remainingCandidates }),
  ]);
}

export async function enqueueNightReviewIfEnabled(
  env: Env,
  scheduledAtUtc: string,
): Promise<{ enqueued: boolean; runId: string | null; reason: "disabled" | "queued" }> {
  if (env.MEMORY_NIGHT_REVIEW_ENABLED !== "true") {
    return { enqueued: false,runId: null,reason: "disabled" };
  }
  if (!env.MEMORY_QUEUE) throw new Error("memory_night_review_queue_binding_missing");
  const prepared = await prepareNightReviewRun({ env,scheduledAtUtc });
  await env.MEMORY_QUEUE.send({
    type: "memory_night_review",
    runId: prepared.run.run_id,
    reviewDate: prepared.run.review_date_local,
    snapshotId: prepared.run.snapshot_id,
    remainingCases: prepared.run.max_cases,
  });
  return { enqueued: true,runId: prepared.run.run_id,reason: "queued" };
}

export async function enqueueRetentionIfNeeded(
  env: Env,
  namespace: string
): Promise<void> {
  const message: QueueMessage = {
    type: "retention",
    namespace,
  };

  await sendQueueMessage(env, message);
}

export async function enqueuePublicationMemoryFollowups(
  env:Env,
  messages:Array<{id:string;conversationId:string;namespace:string}>,
):Promise<void> {
  for (const message of messages) {
    await enqueueMemoryMaintenanceIfNeeded(env,{
      namespace:message.namespace,conversationId:message.conversationId,
      toMessageId:message.id,source:"telegram",
    });
  }
  for (const namespace of new Set(messages.map((message) => message.namespace))) {
    await enqueueRetentionIfNeeded(env,namespace);
  }
}
