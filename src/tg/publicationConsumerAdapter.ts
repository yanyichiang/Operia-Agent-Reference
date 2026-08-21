import type { Env, OpenAIChatMessage } from "../types";
import {
  markPublicationConversationConsumed,
  markPublicationMaintenanceEnqueued,
  materializePublicationMemory,
  planPublicationAssistantConsumption,
  readPublicationConsumerCheckpoint,
  registerPublicationConsumption,
  type PublicationMemoryMessage,
} from "../publication/consumer";
import { readPublicationOutcome } from "../publication/repository";
import { classifyAppliedConversationEventParts } from "../memory/conversationEventParts";
import {
  dueTgConversationArchiveBatchKeys,
  pendingTgConversationArchiveRows,
  type PendingConversationArchiveRow,
} from "./conversationArchiveRecovery";
import {
  consumeHistoricalTgInferencePublication,
  consumeRolloutLegacyTgInferencePublication,
  projectLegacyPendingMessages,
  type LegacyPublicationCompatibilityReason,
} from "./legacyPublicationCompatibility";
import { readTgPublicationSourceRoute } from "./publicationSource";

type NativePublicationScope = {
  publicationId:string;
  inferenceRunId:string;
  recipientScope:string;
};

export type PublicationConsumerScopeClassification =
  | {kind:"legacy_disabled"}
  | {kind:"historical_compatibility";reason:LegacyPublicationCompatibilityReason}
  | {kind:"native_unmaterialized";publicationId:string;conversationEventId:string}
  | {kind:"native";scope:NativePublicationScope};

type InferenceSource = {
  batch_key:string;
  chat_id:string;
  user_text:string;
  created_at:string;
  delivery_seq:number|null;
};

type NativePendingSource = InferenceSource & {
  publication_id:string;
  source_applied:number|null;
  assistant_applied:number|null;
  legacy_event_applied:number|null;
};

export type PublicationConsumerDependencies = {
  consumeConversation:(env:Env,input:{
    chatId:string;publicationId:string;outcomeRevision:number;eventId:string;
    userText:string;userOccurredAtUtc?:string|null;assistantOccurredAtUtc?:string|null;
  })=>Promise<unknown>;
  enqueueMemoryFollowups:(env:Env,messages:PublicationMemoryMessage[])=>Promise<void>;
};

export function publicationConsumerAuthorityEnabled(
  env:Pick<Env,"PUBLICATION_CONSUMER_AUTHORITY_ENABLED">,
):boolean {
  return env.PUBLICATION_CONSUMER_AUTHORITY_ENABLED?.trim().toLowerCase() === "true";
}

async function nativePublicationScope(
  db:D1Database,
  batchKey:string,
):Promise<NativePublicationScope|null> {
  return db.prepare(`SELECT aggregate.publication_id,aggregate.inference_run_id,aggregate.recipient_scope
    FROM publication_aggregates aggregate
    WHERE aggregate.channel='telegram' AND aggregate.inference_run_id=?
      AND EXISTS(SELECT 1 FROM publication_transport_bindings binding
        WHERE binding.publication_id=aggregate.publication_id)
    ORDER BY aggregate.created_at LIMIT 1`)
    .bind(`tg-inference:${batchKey}`).first<{
      publication_id:string;inference_run_id:string;recipient_scope:string;
    }>().then((row) => row ? {
      publicationId:row.publication_id,inferenceRunId:row.inference_run_id,
      recipientScope:row.recipient_scope,
    } : null);
}

export async function classifyTgPublicationConsumerScope(
  env:Pick<Env,"DB"|"PUBLICATION_CONSUMER_AUTHORITY_ENABLED">,
  batchKey:string,
):Promise<PublicationConsumerScopeClassification> {
  // The rollout flag selects the consumer for sources that have no native
  // provenance. It can never revoke an already durable native route/binding:
  // rollback must drain those sources through PublicationOutcome rather than
  // reinterpret them with raw legacy inference state.
  const route = await readTgPublicationSourceRoute(env.DB,batchKey);
  const scope = await nativePublicationScope(env.DB,batchKey);
  if (route?.authorityMode === "native" && !scope) {
    return {kind:"native_unmaterialized",publicationId:route.publicationId,
      conversationEventId:route.conversationEventId};
  }
  if (!scope) {
    if (!publicationConsumerAuthorityEnabled(env)) return {kind:"legacy_disabled"};
    return {kind:"historical_compatibility",reason:route?.authorityMode === "legacy"
      ? "PRE_NATIVE_IN_FLIGHT" : "LEGACY_PROVENANCE_MISSING"};
  }
  if (route?.authorityMode === "legacy") {
    throw new Error("publication_consumer_source_authority_conflict");
  }
  if (route && (route.publicationId !== scope.publicationId
    || route.conversationEventId !== `batch:${batchKey}`)) {
    throw new Error("publication_consumer_source_identity_conflict");
  }
  const conversationEventId = `batch:${batchKey}`;
  const parts = await classifyAppliedConversationEventParts(env.DB,{
    eventId:conversationEventId,recipientScope:scope.recipientScope,
  });
  if (parts.kind === "ambiguous") {
    if (route?.authorityMode === "native") {
      throw new Error("publication_consumer_native_parts_ambiguous");
    }
    return {kind:"historical_compatibility",reason:"HISTORICAL_PARTS_AMBIGUOUS"};
  }
  return {kind:"native",scope};
}

export async function dueTgPublicationConsumerBatchKeys(
  env:Pick<Env,"DB"|"PUBLICATION_CONSUMER_AUTHORITY_ENABLED">,
  limit=20,
):Promise<string[]> {
  const boundedLimit = Math.max(1,Math.min(100,Math.floor(limit)));
  const native = await env.DB.prepare(`SELECT DISTINCT run.batch_key,outcome.updated_at
    FROM publication_outcomes outcome
    JOIN publication_aggregates aggregate ON aggregate.publication_id=outcome.publication_id
    JOIN publication_transport_bindings binding ON binding.publication_id=outcome.publication_id
    JOIN tg_chat_inference_runs run ON aggregate.inference_run_id=('tg-inference:' || run.batch_key)
    LEFT JOIN publication_consumer_checkpoints checkpoint
      ON checkpoint.publication_id=outcome.publication_id
    WHERE (checkpoint.publication_id IS NULL
      OR checkpoint.outcome_revision<outcome.revision
      OR COALESCE(checkpoint.conversation_applied_revision,0)<outcome.revision
      OR COALESCE(checkpoint.memory_applied_revision,0)<outcome.revision
      OR checkpoint.maintenance_status='pending')
      AND NOT EXISTS(SELECT 1 FROM conversation_event_part_materializations parts
        WHERE parts.event_id=('batch:' || run.batch_key)
          AND parts.provenance='historical_ambiguous')
    ORDER BY outcome.updated_at,run.batch_key LIMIT ?`)
    .bind(boundedLimit).all<{batch_key:string;updated_at:string}>();
  const nativeKeys = new Set((native.results ?? []).map((row) => row.batch_key));
  const legacyKeys:string[] = [];
  for (const batchKey of await dueTgConversationArchiveBatchKeys(env.DB,boundedLimit)) {
    if (nativeKeys.has(batchKey) || await nativePublicationScope(env.DB,batchKey)) continue;
    legacyKeys.push(batchKey);
  }
  return [...nativeKeys,...legacyKeys].slice(0,boundedLimit);
}

async function readInferenceSource(db:D1Database,batchKey:string):Promise<InferenceSource|null> {
  // Assistant policy deliberately excludes status, final_package_json,
  // delivery state, outbox state, paragraph state, and finish_reason.
  return db.prepare(`SELECT batch_key,chat_id,user_text,created_at,delivery_seq
    FROM tg_chat_inference_runs WHERE batch_key=?`).bind(batchKey).first<InferenceSource>();
}

async function consumeClassifiedNativeInferencePublication(
  env:Env,
  batchKey:string,
  scope:NativePublicationScope,
  dependencies:PublicationConsumerDependencies,
):Promise<"native_pending"|"native_consumed"> {
  const outcome = await readPublicationOutcome(env.DB,scope.publicationId);
  if (!outcome) return "native_pending";
  if (outcome.inferenceRunId !== scope.inferenceRunId
    || outcome.recipientScope !== scope.recipientScope) {
    throw new Error("publication_consumer_outcome_scope_conflict");
  }
  const source = await readInferenceSource(env.DB,batchKey);
  if (!source || source.chat_id !== outcome.recipientScope) {
    throw new Error("publication_consumer_source_missing");
  }
  const eventId = `batch:${batchKey}`;
  const registration = await registerPublicationConsumption(env.DB,{
    publicationId:scope.publicationId,conversationEventId:eventId,
  });
  const {consumption} = registration;
  const currentOutcome = registration.outcome;
  let {checkpoint} = registration;

  if (checkpoint.conversationAppliedRevision !== consumption.revision
    || checkpoint.conversationStatus === "pending") {
    await dependencies.consumeConversation(env,{
      chatId:source.chat_id,publicationId:consumption.publicationId,
      outcomeRevision:consumption.revision,eventId,userText:source.user_text,
      userOccurredAtUtc:source.created_at,assistantOccurredAtUtc:currentOutcome.updatedAt,
    });
    if (!await markPublicationConversationConsumed(env.DB,{
      publicationId:consumption.publicationId,revision:consumption.revision,
    })) throw new Error("publication_consumer_revision_superseded");
  }

  checkpoint = await readPublicationConsumerCheckpoint(env.DB,consumption.publicationId)
    ?? checkpoint;
  const memoryMessages = await materializePublicationMemory(env.DB,{
    publicationId:consumption.publicationId,outcomeRevision:consumption.revision,
    publicationRef:`tg:${batchKey}`,turnOrderKey:source.delivery_seq,
  });

  checkpoint = await readPublicationConsumerCheckpoint(env.DB,consumption.publicationId)
    ?? checkpoint;
  if (consumption.memoryDisposition === "publish" && checkpoint.maintenanceStatus !== "enqueued") {
    // Memory materialization above is an idempotent durable effect. Queue
    // admission here is at-least-once, and every maintenance worker is
    // independently idempotent, so a crash between send and checkpoint is safe.
    await dependencies.enqueueMemoryFollowups(env,memoryMessages);
    if (!await markPublicationMaintenanceEnqueued(env.DB,{
      publicationId:consumption.publicationId,revision:consumption.revision,
    })) throw new Error("publication_consumer_maintenance_checkpoint_conflict");
  }
  return "native_consumed";
}

export async function consumeNativeInferencePublication(
  env:Env,
  batchKey:string,
  dependencies:PublicationConsumerDependencies,
):Promise<"native_pending"|"native_consumed"> {
  const classification = await classifyTgPublicationConsumerScope(env,batchKey);
  if (classification.kind !== "native") {
    throw new Error("publication_consumer_native_scope_missing");
  }
  return consumeClassifiedNativeInferencePublication(env,batchKey,classification.scope,dependencies);
}

/**
 * Gate-E convergence / Gate-G deletion adapter: native-bound turns have
 * exactly one consumer; rows without native provenance stay concentrated in
 * this legacy path until Owner-private canary acceptance.
 */
export async function consumeTgInferencePublicationOrLegacy(
  env:Env,
  batchKey:string,
  dependencies:PublicationConsumerDependencies,
):Promise<"rollout_legacy"|"historical_compatibility"|"historical_ambiguous"|
  "native_unmaterialized"|"native_pending"|"native_consumed"> {
  const classification = await classifyTgPublicationConsumerScope(env,batchKey);
  if (classification.kind === "legacy_disabled") {
    await consumeRolloutLegacyTgInferencePublication(env,batchKey);
    return "rollout_legacy";
  }
  if (classification.kind === "historical_compatibility") {
    const result = await consumeHistoricalTgInferencePublication(
      env,batchKey,classification.reason,
    );
    return result === "ambiguous_hold" ? "historical_ambiguous" : "historical_compatibility";
  }
  if (classification.kind === "native_unmaterialized") return "native_unmaterialized";
  return consumeClassifiedNativeInferencePublication(env,batchKey,classification.scope,dependencies);
}

async function pendingNativeSources(
  db:D1Database,
  chatId:string,
  afterIso:string|null|undefined,
  limit:number,
):Promise<NativePendingSource[]> {
  const watermark = afterIso?.trim() || null;
  const result = await db.prepare(`SELECT DISTINCT
      run.batch_key,run.chat_id,run.user_text,run.created_at,run.delivery_seq,
      aggregate.publication_id,materialization.source_applied,materialization.assistant_applied,
      legacy_event.applied AS legacy_event_applied
    FROM publication_aggregates aggregate
    JOIN publication_transport_bindings binding ON binding.publication_id=aggregate.publication_id
    JOIN tg_chat_inference_runs run ON aggregate.inference_run_id=('tg-inference:' || run.batch_key)
    LEFT JOIN publication_conversation_materializations materialization
      ON materialization.publication_id=aggregate.publication_id
    LEFT JOIN conversation_turn_events legacy_event ON legacy_event.event_id=('batch:' || run.batch_key)
    WHERE aggregate.channel='telegram' AND run.chat_id=?
      AND (? IS NULL OR julianday(run.created_at)>julianday(?))
      AND (COALESCE(materialization.source_applied,0)=0
        OR (COALESCE(materialization.assistant_applied,0)=0
          AND materialization.terminal_disposition IS NULL))
      AND NOT (materialization.publication_id IS NULL AND COALESCE(legacy_event.applied,0)=1)
    ORDER BY julianday(run.created_at),run.batch_key LIMIT ?`)
    .bind(chatId,watermark,watermark,limit).all<NativePendingSource>();
  return result.results ?? [];
}

/** Native assistant context comes only from PublicationOutcome; raw generated
 * final_package_json remains confined to the explicit legacy fallback. */
export async function pendingTgPublicationContextMessages(
  env:Env,
  input:{chatId:string;afterIso:string|null|undefined;limit?:number},
):Promise<OpenAIChatMessage[]> {
  const limit = Math.max(1,Math.min(24,Math.floor(input.limit ?? 6)));
  const [nativeRows,legacyRows] = await Promise.all([
    pendingNativeSources(env.DB,input.chatId,input.afterIso,limit),
    pendingTgConversationArchiveRows(env.DB,input.chatId,input.afterIso,Math.min(24,limit*2)),
  ]);
  const nativeKeys = new Set(nativeRows.map((row) => row.batch_key));
  const filteredLegacy:PendingConversationArchiveRow[] = [];
  const pendingNativeWithoutAggregate:PendingConversationArchiveRow[] = [];
  for (const row of legacyRows) {
    if (nativeKeys.has(row.batch_key)) continue;
    const classification = await classifyTgPublicationConsumerScope(env,row.batch_key);
    if (classification.kind === "native") continue;
    if (classification.kind === "native_unmaterialized") {
      pendingNativeWithoutAggregate.push(row);
      continue;
    }
    if (classification.kind === "historical_compatibility"
      && classification.reason === "HISTORICAL_PARTS_AMBIGUOUS") continue;
    filteredLegacy.push(row);
  }
  const projectedNative = await Promise.all(nativeRows.map(async (row) => {
    const messages:OpenAIChatMessage[] = [];
    if (row.source_applied !== 1) messages.push({role:"user",content:row.user_text});
    const outcome = await readPublicationOutcome(env.DB,row.publication_id);
    if (outcome) {
      const consumption = planPublicationAssistantConsumption(outcome);
      if (row.assistant_applied !== 1 && consumption.conversationDisposition === "publish") {
        messages.push({role:"assistant",content:consumption.conversationAssistantText!});
      }
    }
    return {createdAt:row.created_at,batchKey:row.batch_key,messages};
  }));
  const combined = [
    ...projectedNative,
    ...filteredLegacy.map((row) => ({
      createdAt:row.created_at,batchKey:row.batch_key,messages:projectLegacyPendingMessages(row),
    })),
    ...pendingNativeWithoutAggregate.map((row) => ({
      createdAt:row.created_at,batchKey:row.batch_key,
      messages:[{role:"user" as const,content:row.user_text}],
    })),
  ].sort((left,right) => Date.parse(left.createdAt)-Date.parse(right.createdAt)
    || left.batchKey.localeCompare(right.batchKey));
  return combined.slice(0,limit).flatMap((row) => row.messages);
}
