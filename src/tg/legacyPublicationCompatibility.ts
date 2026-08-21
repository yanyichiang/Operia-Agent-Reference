import type { Env, OpenAIChatMessage, OpenAIChatResponse } from "../types";
import { resolveTelegramAssistantPublication, type TelegramAssistantPublicationState } from "../db/messages";
import { classifyTerminalCompleteness } from "../reliability/terminalCompleteness";
import { classifyTerminalInferenceFailure } from "./reliability";
import { enqueueMemoryMaintenanceIfNeeded, enqueueRetentionIfNeeded } from "../queue/producer";
import { appendConversationTurn } from "./conversationClient";
import { setTgContinuationStatus, type TgAgentContinuation } from "./continuation";
import type { PendingConversationArchiveRow } from "./conversationArchiveRecovery";
import { getTgInferenceRun, type TgInferenceFinalPackage, type TgInferenceRun } from "./inferenceRun";
import { observeLegacyContinuationPublicationShadow } from "./publicationShadowAdapter";
import { consumeVoiceOnce, recordTgEvent } from "./settings";
import { thinkSystemNotice } from "./thinkApprovalPresentation";
import { isTelegramStaticFallbackResponse } from "../tools/telegramFinalOnly";

export const LEGACY_PUBLICATION_COMPATIBILITY_REASONS = [
  "PRE_NATIVE_IN_FLIGHT",
  "HISTORICAL_PARTS_AMBIGUOUS",
  "LEGACY_PROVENANCE_MISSING",
] as const;

export type LegacyPublicationCompatibilityReason =
  typeof LEGACY_PUBLICATION_COMPATIBILITY_REASONS[number];

type LegacyPublicationExecution =
  | {kind:"rollout"}
  | {kind:"historical";reason:LegacyPublicationCompatibilityReason};

export type LegacyContinuationDeliveryResult =
  | "completed"
  | "attention_required"
  | "outbox_pending";

function assistantText(response:OpenAIChatResponse):string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (content == null) return "";
  return JSON.stringify(content).trim();
}

function parseInboxIds(row:TgInferenceRun):number[] {
  try {
    const parsed = JSON.parse(row.inbox_ids_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id):id is number => Number.isSafeInteger(id) && Number(id)>0)
      : [];
  } catch { return []; }
}

async function firstIngressAt(db:D1Database,row:TgInferenceRun):Promise<string|null> {
  const ids = parseInboxIds(row);
  if (ids.length === 0) return row.created_at;
  const placeholders = ids.map(()=>"?").join(",");
  const source = await db.prepare(`SELECT created_at FROM tg_inbox WHERE id IN (${placeholders})
    ORDER BY id LIMIT 1`).bind(...ids).first<{created_at:string}>();
  return source?.created_at ?? row.created_at;
}

function legacyPublicationState(
  env:Pick<Env,"TG_MEMORY_OUTCOME_V2_ENABLED">,
  row:TgInferenceRun,
  pkg:TgInferenceFinalPackage|null,
):TelegramAssistantPublicationState {
  if (row.status !== "completed") return row.status === "attention_required"
    ? "delivery_unknown" : "excluded";
  if (!pkg || thinkSystemNotice(pkg.response) || isTelegramStaticFallbackResponse(pkg.response)) {
    return "excluded";
  }
  if (env.TG_MEMORY_OUTCOME_V2_ENABLED !== "true") return "delivered";
  return classifyTerminalCompleteness(pkg.response.choices?.[0]?.finish_reason).completeness === "complete"
    ? "delivered" : "delivered_partial";
}

/**
 * Gate-G sunset adapter. This is the only boundary allowed to interpret raw
 * legacy inference state as assistant publication. It never writes native
 * Publication tables and it never accepts a native-path error as eligibility.
 */
async function consumeLegacyTgInferencePublication(
  env:Env,
  batchKey:string,
  execution:LegacyPublicationExecution,
):Promise<"applied"|"ambiguous_hold"|"missing"> {
  if (execution.kind === "historical"
    && execution.reason === "HISTORICAL_PARTS_AMBIGUOUS") {
    // Exact historical part application cannot be recovered. Preserve the
    // durable ambiguity without reading recent, summary, or generated text.
    return "ambiguous_hold";
  }
  const row = await getTgInferenceRun(env.DB,batchKey);
  if (!row) return "missing";
  const pkg = row.final_package_json
    ? JSON.parse(row.final_package_json) as TgInferenceFinalPackage : null;
  const state = legacyPublicationState(env,row,pkg);
  if (env.MEMORY_PUBLICATION_STATE_V2_ENABLED === "true") {
    const published = await resolveTelegramAssistantPublication(env.DB,{
      batchKey:row.batch_key,state,turnOrderKey:row.delivery_seq,
    });
    if (state === "delivered" && published.length > 0) {
      await Promise.all(published.map((message) => enqueueMemoryMaintenanceIfNeeded(env,{
        namespace:message.namespace,conversationId:message.conversation_id,
        toMessageId:message.id,source:"telegram",
      })));
      await enqueueRetentionIfNeeded(env,published[0]!.namespace);
    }
  }
  const rawAssistant = pkg ? assistantText(pkg.response) : "";
  const conversationAssistant = state === "delivered" ? rawAssistant
    : state === "delivered_partial" ? `[回复不完整]\n${rawAssistant}`.trim() : "";
  await appendConversationTurn(env,{
    chatId:row.chat_id,eventId:`batch:${row.batch_key}`,userText:row.user_text,
    assistantText:conversationAssistant,userOccurredAtUtc:await firstIngressAt(env.DB,row),
    assistantOccurredAtUtc:conversationAssistant ? new Date().toISOString() : null,
  },10_000);
  try {
    await recordTgEvent(env.DB,{chatId:row.chat_id,eventType:"conversation.archive",status:"completed",
      metadata:execution.kind === "historical"
        ? {batchKey:row.batch_key,compatibilityReason:execution.reason}
        : {batchKey:row.batch_key,authorityMode:"legacy",rollout:"disabled"}});
  } catch { /* Compatibility materialization must not depend on telemetry. */ }
  return "applied";
}

/** Normal flag-off execution remains the accepted legacy rollout path. It is
 * deliberately not a fourth historical compatibility reason. */
export async function consumeRolloutLegacyTgInferencePublication(
  env:Env,
  batchKey:string,
):Promise<"applied"|"missing"> {
  const result = await consumeLegacyTgInferencePublication(env,batchKey,{kind:"rollout"});
  return result === "ambiguous_hold" ? "missing" : result;
}

export async function consumeHistoricalTgInferencePublication(
  env:Env,
  batchKey:string,
  reason:LegacyPublicationCompatibilityReason,
):Promise<"applied"|"ambiguous_hold"|"missing"> {
  return consumeLegacyTgInferencePublication(env,batchKey,{kind:"historical",reason});
}

/** Exact pre-Gate-E evidence prevents an already materialized direct tool
 * command, or an older durable continuation, from being re-admitted as a new
 * synthetic native source under a second Conversation event identity. */
export async function legacyToolCommandCompatibilityReason(
  db:D1Database,
  input:{taskId:string;nativeBatchKey:string},
):Promise<"PRE_NATIVE_IN_FLIGHT"|null> {
  const row = await db.prepare(`SELECT
      EXISTS(SELECT 1 FROM conversation_turn_events
        WHERE event_id=? AND applied=1) AS direct_applied,
      EXISTS(SELECT 1 FROM tg_system_receipts
        WHERE root_task_id=?) AS receipt_exists,
      (SELECT continuation.batch_key FROM tg_agent_continuations continuation
        WHERE continuation.task_id=? AND NOT EXISTS(
          SELECT 1 FROM tg_publication_source_routes route
          WHERE route.source_kind='inference'
            AND route.source_ref=continuation.batch_key)
        LIMIT 1) AS continuation_batch_key,
      (SELECT batch_key FROM tg_publication_tool_command_sources
        WHERE task_id=?) AS native_batch_key`)
    .bind(`tool-command:${input.taskId}`,input.taskId,input.taskId,input.taskId)
    .first<{direct_applied:number;receipt_exists:number;continuation_batch_key:string|null;
      native_batch_key:string|null}>();
  if (row?.native_batch_key) {
    if (row.native_batch_key !== input.nativeBatchKey) {
      throw new Error("tg_tool_command_source_identity_conflict");
    }
    // Gate-E pending commands deliberately emit a non-assistant task-created
    // receipt after native admission. Under a matching durable native binding
    // that receipt is not evidence of legacy assistant publication. The exact
    // legacy assistant facts remain the old applied event or a continuation
    // that has no Publication source route.
    if (row.direct_applied === 1 || row.continuation_batch_key !== null) {
      throw new Error("tg_tool_command_mixed_authority_conflict");
    }
    return null;
  }
  return row && (row.direct_applied === 1 || row.receipt_exists === 1
    || row.continuation_batch_key !== null)
    ? "PRE_NATIVE_IN_FLIGHT" : null;
}

/**
 * Historical direct tool continuations had no tg_chat_inference_run to resume.
 * Keep their original stable outbox and Conversation identities inside the
 * one Gate-G compatibility module; a future/native continuation never enters
 * this function merely because its new path failed.
 */
export async function deliverHistoricalDurableContinuationFinal(
  env:Env,
  input:{
    row:TgAgentContinuation;
    reason:"PRE_NATIVE_IN_FLIGHT";
    text:string;
    finalPayloads:Record<string,unknown>[];
    mediaIntents:Record<string,unknown>[];
    deliverPayloads:(env:Env,chatId:string,batchKey:string,
      payloads:Record<string,unknown>[])=>Promise<void>;
  },
):Promise<LegacyContinuationDeliveryResult> {
  if (input.reason !== "PRE_NATIVE_IN_FLIGHT") {
    throw new Error("legacy_continuation_compatibility_reason_invalid");
  }
  if (await getTgInferenceRun(env.DB,input.row.batch_key)) {
    throw new Error("legacy_continuation_native_source_present");
  }
  try {
    await input.deliverPayloads(env,input.row.chat_id,
      `${input.row.batch_key}:final:text`,input.finalPayloads);
  } catch (error) {
    const terminal = String(error).includes("attention_required");
    await setTgContinuationStatus(env.DB,input.row.id,
      terminal ? "attention_required" : "outbox_pending",{
        error:String(error),clearLease:true,
      });
    if (terminal) {
      await observeLegacyContinuationPublicationShadow(env,{
        continuationId:input.row.id,chatId:input.row.chat_id,
      });
    }
    return terminal ? "attention_required" : "outbox_pending";
  }
  let voiceOnceConsumed = false;
  for (const [index,intent] of input.mediaIntents.entries()) {
    try {
      await input.deliverPayloads(env,input.row.chat_id,
        `${input.row.batch_key}:final:media:${index}`,[intent]);
      if (!voiceOnceConsumed && input.row.voice_once === 1
        && intent.method === "sendVoice") {
        voiceOnceConsumed = await consumeVoiceOnce(env.DB,input.row.chat_id);
      }
    } catch (error) {
      await recordTgEvent(env.DB,{chatId:input.row.chat_id,eventType:"media.delivery",status:"error",
        metadata:{code:String(error).slice(0,160)}});
      if (classifyTerminalInferenceFailure(error) === "outbox_outcome_unknown") {
        await setTgContinuationStatus(env.DB,input.row.id,"attention_required",{
          error:String(error),clearLease:true,
        });
        await observeLegacyContinuationPublicationShadow(env,{
          continuationId:input.row.id,chatId:input.row.chat_id,
        });
        return "attention_required";
      }
    }
  }
  await appendConversationTurn(env,{
    chatId:input.row.chat_id,eventId:`continuation:${input.row.id}`,
    userText:input.row.user_text,assistantText:input.text,
    assistantOccurredAtUtc:new Date().toISOString(),
  });
  await setTgContinuationStatus(env.DB,input.row.id,"completed",{clearLease:true});
  await observeLegacyContinuationPublicationShadow(env,{
    continuationId:input.row.id,chatId:input.row.chat_id,
  });
  return "completed";
}

export function projectLegacyPendingMessages(
  row:PendingConversationArchiveRow,
):OpenAIChatMessage[] {
  try {
    if (!row.final_package_json) return [{role:"user",content:row.user_text}];
    const pkg = JSON.parse(row.final_package_json) as TgInferenceFinalPackage;
    const text = assistantText(pkg.response);
    return row.status === "completed" && text
      ? [{role:"user",content:row.user_text},{role:"assistant",content:text}]
      : [{role:"user",content:row.user_text}];
  } catch {
    return [{role:"user",content:row.user_text}];
  }
}
