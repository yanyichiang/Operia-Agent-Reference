import type { Env } from "../types";
import { projectPublicationOutcome, type PublicationProjectionResult } from "../publication/projector";
import {
  prepareStagePublicationStatements,
  readPublicationAggregateSnapshot,
  readPublicationDeliveryEvidenceHead,
  verifyStagedPublication,
} from "../publication/repository";
import type {
  InferenceRunCompleteness,
  PublicationPurpose,
  PublicationStageItem,
  PublicationTextRole,
  StagePublicationInput,
} from "../publication/types";
import { nowIso } from "../utils/time";

const IDEMPOTENT_EDIT_MAX_ATTEMPTS = 3;

export type NativePublicationCommand = {
  outboxId:string;
  intentKey:string;
  chatId:string;
  payload:Record<string,unknown>;
  required:boolean;
  textRole:PublicationTextRole;
  visibleTextFragment:string | null;
  repairOf?:{ publicationId:string; deliveryItemId:string };
};

export type NativePublicationBatchInput = {
  publicationId:string;
  inferenceRunId:string;
  recipientScope:string;
  purpose:PublicationPurpose;
  publicationCreatedAt:string;
  deliveryBatchId:string;
  commands:NativePublicationCommand[];
  closeSequence:boolean;
  legacyDeliveryBatch?:{
    batchKey:string;
    chatId:string;
    deliverySeq:number;
    voiceOnceOutboxId?:string;
    hadAttention:boolean;
  };
};

export type NativeTransportBinding = {
  publicationId:string;
  deliveryItemId:string;
  outboxId:string;
  effectSafety:"non_idempotent_send" | "idempotent_edit";
};

export type NativeOutboxClaim = {
  outboxId:string;
  attempt:number;
  leaseUntil:string;
};

export type NativeTransportObservationResult =
  | { kind:"applied" | "replayed" | "reconciled"; projection:PublicationProjectionResult }
  | { kind:"lost_ownership"; projection:null };

type BindingRow = {
  publication_id:string;
  delivery_item_id:string;
  outbox_id:string;
  effect_safety:NativeTransportBinding["effectSafety"];
};

type OutboxIdentityRow = {
  id:string;
  intent_key:string;
  chat_id:string;
  payload_json:string;
  delivery_batch_key:string | null;
  status:string;
  attempts:number;
  lease_until:string | null;
};

type ClosureRow = {
  closure_ref:string;
  source_kind:string;
  source_ref:string;
  required_membership_json:string;
  required_membership_sha256:string;
  observed_at:string;
};

type RequiredMembership = {
  deliveryItemId:string;
  deliveryBatchId:string;
  payloadRef:string;
  intentKey:string;
  sequenceIndex:number;
};

type ExistingStageItemRow = {
  delivery_item_id:string;
  delivery_batch_id:string;
  payload_ref:string;
  intent_key:string;
  sequence_index:number;
  required:number;
  text_role:PublicationTextRole;
  visible_text_fragment:string | null;
};

export function publicationDeliveryAuthorityEnabled(
  env: Pick<Env,"PUBLICATION_DELIVERY_AUTHORITY_ENABLED">,
): boolean {
  return env.PUBLICATION_DELIVERY_AUTHORITY_ENABLED?.trim().toLowerCase() === "true";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2,"0")).join("");
}

export async function nativeOutboxIdForIntent(intentKey: string): Promise<string> {
  return `tg-native:${(await sha256(intentKey)).slice(0,40)}`;
}

export function nativeInferencePublicationId(batchKey: string): string {
  return `pub:telegram:inference:${batchKey}`;
}

export function nativeInferenceRunId(batchKey: string): string {
  return `tg-inference:${batchKey}`;
}

export function nativeDeliveryItemId(outboxId: string): string {
  // Gate B used this stable identity while observing legacy facts. Reusing it
  // lets a future cutover recognize an exact staged replay without creating a
  // second item for the same durable outbox intent.
  return `shadow:tg-outbox:${outboxId}`;
}

function effectSafety(payload: Record<string,unknown>): NativeTransportBinding["effectSafety"] {
  return payload.method === "editMessageText" ? "idempotent_edit" : "non_idempotent_send";
}

function prepareOutboxInsert(
  db: D1Database,
  command: NativePublicationCommand,
  deliveryBatchId: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO tg_agent_outbox(
      id,intent_key,chat_id,payload_json,status,attempts,delivery_batch_key,
      receipt_id,render_version,bubble_index,created_at,updated_at
    ) VALUES(?,?,?,?, 'pending',0,?,NULL,1,NULL,?,?)
    ON CONFLICT(intent_key) DO NOTHING`)
    .bind(command.outboxId,command.intentKey,command.chatId,JSON.stringify(command.payload),
      deliveryBatchId,createdAt,createdAt);
}

function prepareBindingInsert(
  db: D1Database,
  publicationId: string,
  command: NativePublicationCommand,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO publication_transport_bindings(
      delivery_item_id,publication_id,outbox_id,effect_safety,
      repair_of_publication_id,repair_of_delivery_item_id,created_at
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(delivery_item_id) DO NOTHING`)
    .bind(nativeDeliveryItemId(command.outboxId),publicationId,command.outboxId,effectSafety(command.payload),
      command.repairOf?.publicationId ?? null,command.repairOf?.deliveryItemId ?? null,createdAt);
}

function prepareLegacyDeliveryBatchInsert(
  db: D1Database,
  input: NonNullable<NativePublicationBatchInput["legacyDeliveryBatch"]>,
  outboxIds: string[],
  createdAt: string,
): D1PreparedStatement {
  if (!Number.isSafeInteger(input.deliverySeq) || input.deliverySeq <= 0) {
    throw new Error("tg_delivery_seq_missing");
  }
  return db.prepare(`INSERT INTO tg_chat_delivery_batches(
      batch_key,chat_id,outbox_ids_json,voice_once_outbox_id,status,had_attention,
      created_at,updated_at,delivery_seq
    ) VALUES(?,?,?,?,'pending',?,?,?,?) ON CONFLICT(batch_key) DO NOTHING`)
    .bind(input.batchKey,input.chatId,JSON.stringify(outboxIds),input.voiceOnceOutboxId ?? null,
      input.hadAttention ? 1 : 0,createdAt,createdAt,input.deliverySeq);
}

function requiredMembership(items: PublicationStageItem[]): RequiredMembership[] {
  return items.filter((item) => item.required)
    .sort((left,right) => left.sequenceIndex-right.sequenceIndex)
    .map((item) => ({
      deliveryItemId:item.deliveryItemId,
      deliveryBatchId:item.deliveryBatchId,
      payloadRef:item.payloadRef,
      intentKey:item.intentKey,
      sequenceIndex:item.sequenceIndex,
    }));
}

async function verifyNativeCommand(
  db: D1Database,
  publicationId: string,
  deliveryBatchId: string,
  command: NativePublicationCommand,
): Promise<void> {
  const outbox = await db.prepare(`SELECT id,intent_key,chat_id,payload_json,delivery_batch_key,
      status,attempts,lease_until FROM tg_agent_outbox WHERE intent_key=?`)
    .bind(command.intentKey).first<OutboxIdentityRow>();
  if (!outbox
    || outbox.id !== command.outboxId
    || outbox.chat_id !== command.chatId
    || outbox.payload_json !== JSON.stringify(command.payload)
    || outbox.delivery_batch_key !== deliveryBatchId) {
    throw new Error("publication_native_outbox_identity_conflict");
  }
  const binding = await db.prepare(`SELECT publication_id,delivery_item_id,outbox_id,effect_safety
    FROM publication_transport_bindings WHERE delivery_item_id=?`)
    .bind(nativeDeliveryItemId(command.outboxId)).first<BindingRow>();
  if (!binding
    || binding.publication_id !== publicationId
    || binding.outbox_id !== command.outboxId
    || binding.effect_safety !== effectSafety(command.payload)) {
    throw new Error("publication_transport_binding_identity_conflict");
  }
}

async function verifyLegacyDeliveryBatch(
  db: D1Database,
  input: NonNullable<NativePublicationBatchInput["legacyDeliveryBatch"]>,
  outboxIds: string[],
): Promise<void> {
  const row = await db.prepare(`SELECT chat_id,outbox_ids_json,voice_once_outbox_id,had_attention,delivery_seq
    FROM tg_chat_delivery_batches WHERE batch_key=?`).bind(input.batchKey).first<{
      chat_id:string; outbox_ids_json:string; voice_once_outbox_id:string | null;
      had_attention:number; delivery_seq:number | null;
    }>();
  if (!row
    || row.chat_id !== input.chatId
    || row.outbox_ids_json !== JSON.stringify(outboxIds)
    || row.voice_once_outbox_id !== (input.voiceOnceOutboxId ?? null)
    || row.had_attention !== (input.hadAttention ? 1 : 0)
    || row.delivery_seq !== input.deliverySeq) {
    throw new Error("publication_native_delivery_batch_identity_conflict");
  }
}

/**
 * Atomically stages the legacy transport command, native Publication item(s),
 * transport bindings, and (for a closed batch) the audited closure snapshot.
 */
export async function stageNativePublicationBatch(
  env: Pick<Env,"DB"|"PUBLICATION_DELIVERY_AUTHORITY_ENABLED">,
  input: NativePublicationBatchInput,
): Promise<string[]> {
  if (!publicationDeliveryAuthorityEnabled(env)) {
    throw new Error("publication_delivery_authority_disabled");
  }
  if (input.commands.length === 0) throw new Error("publication_native_commands_missing");
  if (input.closeSequence && !input.legacyDeliveryBatch) {
    throw new Error("publication_native_closure_source_missing");
  }

  const existing = await readPublicationAggregateSnapshot(env.DB,input.publicationId);
  const existingItemRows = existing
    ? await env.DB.prepare(`SELECT delivery_item_id,delivery_batch_id,payload_ref,intent_key,
        sequence_index,required,text_role,visible_text_fragment
      FROM publication_delivery_items WHERE publication_id=? ORDER BY sequence_index`)
      .bind(input.publicationId).all<ExistingStageItemRow>()
    : {results:[] as ExistingStageItemRow[]};
  const existingStageItems = (existingItemRows.results ?? []).map((item): PublicationStageItem => ({
    deliveryItemId:item.delivery_item_id,
    deliveryBatchId:item.delivery_batch_id,
    payloadRef:item.payload_ref,
    intentKey:item.intent_key,
    sequenceIndex:item.sequence_index,
    required:item.required === 1,
    textRole:item.text_role,
    visibleTextFragment:item.visible_text_fragment,
  }));
  const existingBatchIndex = existing?.deliveryBatchIds.indexOf(input.deliveryBatchId) ?? -1;
  const batchOrder = existingBatchIndex >= 0 ? existingBatchIndex : existing?.deliveryBatchIds.length ?? 0;
  let nextSequenceIndex = existingStageItems.reduce(
    (maximum,item) => Math.max(maximum,item.sequenceIndex+1),0,
  );
  const existingByIntent = new Map(existingStageItems.map((item) => [item.intentKey,item]));
  const stageItems: PublicationStageItem[] = input.commands.map((command) => {
    const prior = existingByIntent.get(command.intentKey);
    return {
      deliveryItemId:nativeDeliveryItemId(command.outboxId),
      payloadRef:`tg-outbox:${command.outboxId}`,
      intentKey:command.intentKey,
      deliveryBatchId:input.deliveryBatchId,
      sequenceIndex:prior?.sequenceIndex ?? nextSequenceIndex++,
      required:command.required,
      textRole:command.textRole,
      visibleTextFragment:command.visibleTextFragment,
    };
  });
  const stage: StagePublicationInput = {
    publicationId:input.publicationId,
    channel:"telegram",
    recipientScope:input.recipientScope,
    inferenceRunId:input.inferenceRunId,
    purpose:input.purpose,
    batches:[{deliveryBatchId:input.deliveryBatchId,batchOrder}],
    items:stageItems,
    createdAt:input.publicationCreatedAt,
  };
  const outboxIds = input.commands.map((command) => command.outboxId);
  const now = nowIso();
  const storedSource = input.legacyDeliveryBatch
    ? await env.DB.prepare("SELECT created_at FROM tg_chat_delivery_batches WHERE batch_key=?")
      .bind(input.legacyDeliveryBatch.batchKey).first<{created_at:string}>()
    : null;
  const sourceObservedAt = storedSource?.created_at ?? now;

  const statements: D1PreparedStatement[] = [
    ...input.commands.map((command) => prepareOutboxInsert(
      env.DB,command,input.deliveryBatchId,sourceObservedAt,
    )),
    ...(input.legacyDeliveryBatch
      ? [prepareLegacyDeliveryBatchInsert(env.DB,input.legacyDeliveryBatch,outboxIds,sourceObservedAt)]
      : []),
    ...prepareStagePublicationStatements(env.DB,stage),
    ...input.commands.map((command) => prepareBindingInsert(
      env.DB,input.publicationId,command,sourceObservedAt,
    )),
  ];

  let expectedClosure: ClosureRow | null = null;
  if (input.closeSequence) {
    const mergedItems = new Map(existingStageItems.map((item) => [item.deliveryItemId,item]));
    for (const item of stageItems) mergedItems.set(item.deliveryItemId,item);
    const membershipJson = JSON.stringify(requiredMembership([...mergedItems.values()]));
    const membershipHash = await sha256(membershipJson);
    const closureRef = `native-tg-closure:${input.publicationId}:${membershipHash.slice(0,24)}`;
    expectedClosure = {
      closure_ref:closureRef,
      source_kind:"tg_chat_delivery_batch",
      source_ref:input.legacyDeliveryBatch!.batchKey,
      required_membership_json:membershipJson,
      required_membership_sha256:membershipHash,
      observed_at:sourceObservedAt,
    };
    statements.push(env.DB.prepare(`INSERT INTO publication_sequence_closures(
        closure_ref,publication_id,source_kind,source_ref,required_membership_json,
        required_membership_sha256,observed_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(publication_id) DO NOTHING`)
      .bind(closureRef,input.publicationId,"tg_chat_delivery_batch",input.legacyDeliveryBatch!.batchKey,
        membershipJson,membershipHash,sourceObservedAt,sourceObservedAt));
    statements.push(env.DB.prepare(`UPDATE publication_aggregates
      SET required_sequence_closed=1,updated_at=?
      WHERE publication_id=? AND required_sequence_closed=0
        AND EXISTS(SELECT 1 FROM publication_sequence_closures WHERE publication_id=?)`)
      .bind(sourceObservedAt,input.publicationId,input.publicationId));
  }

  await env.DB.batch(statements);
  await verifyStagedPublication(env.DB,stage);
  for (const command of input.commands) {
    await verifyNativeCommand(env.DB,input.publicationId,input.deliveryBatchId,command);
  }
  if (input.legacyDeliveryBatch) {
    await verifyLegacyDeliveryBatch(env.DB,input.legacyDeliveryBatch,outboxIds);
  }
  if (expectedClosure) {
    const closure = await env.DB.prepare(`SELECT closure_ref,source_kind,source_ref,
      required_membership_json,required_membership_sha256,observed_at
      FROM publication_sequence_closures WHERE publication_id=?`)
      .bind(input.publicationId).first<ClosureRow>();
    if (!closure || JSON.stringify(closure) !== JSON.stringify(expectedClosure)) {
      throw new Error("publication_sequence_closure_identity_conflict");
    }
    const sealed = await readPublicationAggregateSnapshot(env.DB,input.publicationId);
    if (!sealed?.requiredSequenceClosed) throw new Error("publication_sequence_closure_seal_failed");
  }
  return outboxIds;
}

export async function readNativeTransportBinding(
  db: D1Database,
  outboxId: string,
): Promise<NativeTransportBinding | null> {
  const row = await db.prepare(`SELECT publication_id,delivery_item_id,outbox_id,effect_safety
    FROM publication_transport_bindings WHERE outbox_id=?`).bind(outboxId).first<BindingRow>();
  return row ? {
    publicationId:row.publication_id,
    deliveryItemId:row.delivery_item_id,
    outboxId:row.outbox_id,
    effectSafety:row.effect_safety,
  } : null;
}

async function consumptionContext(
  db: D1Database,
  publicationId: string,
): Promise<{ generationCompleteness:InferenceRunCompleteness | null }> {
  const aggregate = await readPublicationAggregateSnapshot(db,publicationId);
  if (!aggregate) throw new Error("publication_native_aggregate_missing");
  if (aggregate.purpose !== "assistant_response") return {generationCompleteness:null};
  const batchKey = aggregate.inferenceRunId.startsWith("tg-inference:")
    ? aggregate.inferenceRunId.slice("tg-inference:".length) : "";
  if (!batchKey) return {generationCompleteness:null};
  const row = await db.prepare("SELECT terminal_completeness FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(batchKey).first<{terminal_completeness:string | null}>();
  const value = row?.terminal_completeness;
  return {
    generationCompleteness:value === "complete" || value === "partial" || value === "failed" || value === "attention"
      ? value : null,
  };
}

export async function projectNativePublicationOutcome(
  db: D1Database,
  publicationId: string,
  observedAt: string,
): Promise<PublicationProjectionResult> {
  return projectPublicationOutcome(db,{
    publicationId,
    consumptionContext:await consumptionContext(db,publicationId),
    observedAt,
  });
}

export async function markNativeTelegramRequestStarted(
  db: D1Database,
  claim: NativeOutboxClaim,
): Promise<boolean> {
  const now = nowIso();
  const updated = await db.prepare(`UPDATE tg_agent_outbox SET status='sending',updated_at=?
    WHERE id=? AND status='leased' AND attempts=? AND lease_until=? AND lease_until>?
    RETURNING id`).bind(now,claim.outboxId,claim.attempt,claim.leaseUntil,now).first<{id:string}>();
  return Boolean(updated);
}

export async function markNativeSafeRetryPending(
  db: D1Database,
  input: {
    claim:NativeOutboxClaim;
    expectedSourceState:"leased" | "sending";
    errorCode:string;
  },
): Promise<boolean> {
  const now = nowIso();
  const updated = await db.prepare(`UPDATE tg_agent_outbox SET status='pending',last_error=?,
    lease_until=NULL,updated_at=? WHERE id=? AND status=? AND attempts=? AND lease_until=?
      AND lease_until>? RETURNING id`)
    .bind(input.errorCode,now,input.claim.outboxId,input.expectedSourceState,
      input.claim.attempt,input.claim.leaseUntil,now).first<{id:string}>();
  return Boolean(updated);
}

function observationRef(claim: NativeOutboxClaim, evidenceClass: "sent" | "rejected" | "unknown"): string {
  return `native-tg:${claim.outboxId}:attempt:${claim.attempt}:${evidenceClass}`;
}

async function projectRecordedObservation(
  db: D1Database,
  binding: NativeTransportBinding,
  observedAt: string,
  kind: "applied" | "replayed" | "reconciled",
): Promise<NativeTransportObservationResult> {
  return {
    kind,
    projection:await projectNativePublicationOutcome(db,binding.publicationId,observedAt),
  };
}

async function readObservationReplay(
  db: D1Database,
  ref: string,
): Promise<{ observed_at:string } | null> {
  return db.prepare(`SELECT observed_at FROM publication_transport_observations
    WHERE observation_ref=?`).bind(ref).first<{observed_at:string}>();
}

async function reconcileLateNativeTransportObservation(
  env: Pick<Env,"DB">,
  input: {
    binding:NativeTransportBinding;
    claim:NativeOutboxClaim;
    evidenceClass:"sent" | "rejected";
    transportMessageId?:string;
    legacyErrorCode:string | null;
  },
): Promise<NativeTransportObservationResult> {
  const ref = observationRef(input.claim,input.evidenceClass);
  const replay = await readObservationReplay(env.DB,ref);
  if (replay) return projectRecordedObservation(env.DB,input.binding,replay.observed_at,"replayed");

  const observedAt = nowIso();
  const targetStatus = input.evidenceClass === "sent" ? "sent" : "attention_required";
  const mutationResults = await env.DB.batch<{id?:string; observation_ref?:string}>([
    // A confirmed response may beat stale recovery after the owned request
    // deadline. It is fenced to the exact expired attempt and never replays it.
    env.DB.prepare(`UPDATE tg_agent_outbox SET status=?,telegram_message_id=?,last_error=?,
      lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND attempts=?
        AND lease_until=? AND lease_until<=? RETURNING id`)
      .bind(targetStatus,input.transportMessageId ?? null,input.legacyErrorCode,observedAt,
        input.claim.outboxId,input.claim.attempt,input.claim.leaseUntil,observedAt),
    env.DB.prepare(`INSERT INTO publication_transport_observations(
      observation_ref,publication_id,delivery_item_id,outbox_id,evidence_class,outbox_attempt,
      transport_message_id,observed_at,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM tg_agent_outbox WHERE id=? AND attempts=? AND status=? AND updated_at=?
    ) ON CONFLICT(observation_ref) DO NOTHING RETURNING observation_ref`)
      .bind(ref,input.binding.publicationId,input.binding.deliveryItemId,input.binding.outboxId,
        input.evidenceClass,input.claim.attempt,input.transportMessageId ?? null,observedAt,observedAt,
        input.claim.outboxId,input.claim.attempt,targetStatus,observedAt),
  ]);
  if (mutationResults[1]?.results?.[0]?.observation_ref) {
    return projectRecordedObservation(env.DB,input.binding,observedAt,"reconciled");
  }

  // If stale recovery won first, the outbox stays attention_required. The
  // stronger same-attempt fact is append-only and advances Gate-A evidence
  // unknown -> sent/rejected without reopening the intent.
  const reconciled = await env.DB.prepare(`INSERT INTO publication_transport_observations(
      observation_ref,publication_id,delivery_item_id,outbox_id,evidence_class,outbox_attempt,
      transport_message_id,observed_at,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM tg_agent_outbox outbox
      WHERE outbox.id=? AND outbox.status='attention_required' AND outbox.attempts=?
        AND EXISTS(
          SELECT 1 FROM publication_transport_observations prior
          WHERE prior.outbox_id=outbox.id AND prior.outbox_attempt=outbox.attempts
            AND prior.evidence_class='unknown'
        )
    ) ON CONFLICT(observation_ref) DO NOTHING RETURNING observation_ref`)
    .bind(ref,input.binding.publicationId,input.binding.deliveryItemId,input.binding.outboxId,
      input.evidenceClass,input.claim.attempt,input.transportMessageId ?? null,observedAt,observedAt,
      input.claim.outboxId,input.claim.attempt)
    .first<{observation_ref:string}>();
  if (reconciled) return projectRecordedObservation(env.DB,input.binding,observedAt,"reconciled");
  const concurrentReplay = await readObservationReplay(env.DB,ref);
  return concurrentReplay
    ? projectRecordedObservation(env.DB,input.binding,concurrentReplay.observed_at,"replayed")
    : {kind:"lost_ownership",projection:null};
}

export async function recordNativeTransportObservation(
  env: Pick<Env,"DB">,
  input: {
    binding:NativeTransportBinding;
    claim:NativeOutboxClaim;
    expectedSourceState:"leased" | "sending";
    evidenceClass:"sent" | "rejected" | "unknown";
    transportMessageId?:string;
    legacyErrorCode:string | null;
  },
): Promise<NativeTransportObservationResult> {
  if (input.binding.outboxId !== input.claim.outboxId) {
    throw new Error("publication_native_claim_binding_mismatch");
  }
  const ref = observationRef(input.claim,input.evidenceClass);
  const replay = await readObservationReplay(env.DB,ref);
  if (replay) return projectRecordedObservation(env.DB,input.binding,replay.observed_at,"replayed");

  const observedAt = nowIso();
  const targetStatus = input.evidenceClass === "sent" ? "sent" : "attention_required";
  const results = await env.DB.batch<{id?:string; observation_ref?:string}>([
    env.DB.prepare(`UPDATE tg_agent_outbox SET status=?,telegram_message_id=?,last_error=?,
      lease_until=NULL,updated_at=? WHERE id=? AND status=? AND attempts=? AND lease_until=?
        AND lease_until>? RETURNING id`)
      .bind(targetStatus,input.transportMessageId ?? null,input.legacyErrorCode,observedAt,
        input.claim.outboxId,input.expectedSourceState,input.claim.attempt,input.claim.leaseUntil,observedAt),
    env.DB.prepare(`INSERT INTO publication_transport_observations(
      observation_ref,publication_id,delivery_item_id,outbox_id,evidence_class,outbox_attempt,
      transport_message_id,observed_at,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM tg_agent_outbox WHERE id=? AND attempts=? AND status=? AND updated_at=?
    ) ON CONFLICT(observation_ref) DO NOTHING RETURNING observation_ref`)
      .bind(ref,input.binding.publicationId,input.binding.deliveryItemId,input.binding.outboxId,
        input.evidenceClass,input.claim.attempt,input.transportMessageId ?? null,observedAt,observedAt,
        input.claim.outboxId,input.claim.attempt,targetStatus,observedAt),
  ]);
  if (results[1]?.results?.[0]?.observation_ref) {
    return projectRecordedObservation(env.DB,input.binding,observedAt,"applied");
  }
  if (input.evidenceClass === "sent" || input.evidenceClass === "rejected") {
    return reconcileLateNativeTransportObservation(env,{
      binding:input.binding,claim:input.claim,evidenceClass:input.evidenceClass,
      transportMessageId:input.transportMessageId,legacyErrorCode:input.legacyErrorCode,
    });
  }
  const concurrentReplay = await readObservationReplay(env.DB,ref);
  return concurrentReplay
    ? projectRecordedObservation(env.DB,input.binding,concurrentReplay.observed_at,"replayed")
    : {kind:"lost_ownership",projection:null};
}

export async function recoverNativeStaleSending(
  env: Pick<Env,"DB">,
  outboxId: string,
  observedAt = nowIso(),
): Promise<"pending" | "attention_required" | null> {
  const binding = await readNativeTransportBinding(env.DB,outboxId);
  if (!binding) return null;
  const row = await env.DB.prepare(`SELECT id,intent_key,chat_id,payload_json,delivery_batch_key,
      status,attempts,lease_until FROM tg_agent_outbox WHERE id=?`).bind(outboxId).first<OutboxIdentityRow>();
  if (!row || row.status !== "sending" || !row.lease_until || row.lease_until > observedAt) return null;
  if (binding.effectSafety === "idempotent_edit" && row.attempts < IDEMPOTENT_EDIT_MAX_ATTEMPTS) {
    const recovered = await env.DB.prepare(`UPDATE tg_agent_outbox SET status='pending',
      last_error='telegram_edit_outcome_unknown_retryable',lease_until=NULL,updated_at=?
      WHERE id=? AND status='sending' AND attempts=? AND lease_until=? AND lease_until<=?
      RETURNING id`).bind(observedAt,outboxId,row.attempts,row.lease_until,observedAt).first<{id:string}>();
    return recovered ? "pending" : null;
  }
  const claim = {outboxId,attempt:row.attempts,leaseUntil:row.lease_until};
  const ref = observationRef(claim,"unknown");
  const results = await env.DB.batch<{id?:string; observation_ref?:string}>([
    env.DB.prepare(`UPDATE tg_agent_outbox SET status='attention_required',
      last_error='telegram_send_outcome_unknown',lease_until=NULL,updated_at=?
      WHERE id=? AND status='sending' AND attempts=? AND lease_until=? AND lease_until<=?
      RETURNING id`).bind(observedAt,outboxId,row.attempts,row.lease_until,observedAt),
    env.DB.prepare(`INSERT INTO publication_transport_observations(
      observation_ref,publication_id,delivery_item_id,outbox_id,evidence_class,outbox_attempt,
      transport_message_id,observed_at,created_at
    ) SELECT ?,?,?,?,'unknown',?,NULL,?,? WHERE EXISTS(
      SELECT 1 FROM tg_agent_outbox WHERE id=? AND status='attention_required'
        AND attempts=? AND last_error='telegram_send_outcome_unknown' AND updated_at=?
    ) ON CONFLICT(observation_ref) DO NOTHING RETURNING observation_ref`)
      .bind(ref,binding.publicationId,binding.deliveryItemId,outboxId,row.attempts,observedAt,observedAt,
        outboxId,row.attempts,observedAt),
  ]);
  if (!results[1]?.results?.[0]?.observation_ref) return null;
  await projectNativePublicationOutcome(env.DB,binding.publicationId,observedAt);
  return "attention_required";
}

export async function recoverNativeTerminalOutboxObservation(
  env: Pick<Env,"DB">,
  outboxId: string,
): Promise<"sent" | "attention_required" | null> {
  const binding = await readNativeTransportBinding(env.DB,outboxId);
  if (!binding) return null;
  const row = await env.DB.prepare(`SELECT id,intent_key,chat_id,payload_json,delivery_batch_key,
      status,attempts,lease_until,last_error,telegram_message_id
    FROM tg_agent_outbox WHERE id=?`).bind(outboxId).first<OutboxIdentityRow & {
      last_error:string | null; telegram_message_id:string | null;
    }>();
  if (!row || (row.status !== "sent" && row.status !== "attention_required") || row.attempts < 1) return null;
  const head = await readPublicationDeliveryEvidenceHead(env.DB,binding.deliveryItemId);
  if (head) {
    await projectNativePublicationOutcome(env.DB,binding.publicationId,head.observedAt);
    return row.status;
  }
  const evidenceClass = row.status === "sent" ? "sent"
    : row.last_error === "telegram_http_400"
      || row.last_error === "telegram_intent_method_not_allowed"
      || row.last_error === "telegram_reply_markup_invalid"
      || row.last_error === "telegram_web_app_button_invalid"
      ? "rejected" : "unknown";
  await env.DB.prepare(`INSERT INTO publication_transport_observations(
      observation_ref,publication_id,delivery_item_id,outbox_id,evidence_class,outbox_attempt,
      transport_message_id,observed_at,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_ref) DO NOTHING`)
    .bind(`native-tg:${outboxId}:attempt:${row.attempts}:${evidenceClass}`,
      binding.publicationId,binding.deliveryItemId,outboxId,evidenceClass,row.attempts,
      row.telegram_message_id,nowIso(),nowIso()).run();
  await projectNativeBoundOutbox(env.DB,outboxId);
  return row.status;
}

export async function projectNativeBoundOutbox(
  db: D1Database,
  outboxId: string,
): Promise<void> {
  const binding = await readNativeTransportBinding(db,outboxId);
  if (!binding) return;
  const head = await readPublicationDeliveryEvidenceHead(db,binding.deliveryItemId);
  if (!head) return;
  await projectNativePublicationOutcome(db,binding.publicationId,head.observedAt);
}

/**
 * A rejected immutable item cannot be reopened. Repair is a new publication
 * command with a new intent/item/outbox and an explicit lineage edge back to
 * the historical rejection.
 */
export async function stageNativeRejectedPublicationRepair(
  env: Pick<Env,"DB"|"PUBLICATION_DELIVERY_AUTHORITY_ENABLED">,
  input: Omit<NativePublicationBatchInput,"commands"|"closeSequence"> & {
    rejectedPublicationId:string;
    rejectedDeliveryItemId:string;
    command:Omit<NativePublicationCommand,"repairOf">;
  },
): Promise<string[]> {
  if (input.publicationId === input.rejectedPublicationId) {
    throw new Error("publication_repair_requires_new_aggregate");
  }
  const head = await readPublicationDeliveryEvidenceHead(env.DB,input.rejectedDeliveryItemId);
  if (head?.evidenceClass !== "rejected") throw new Error("publication_repair_source_not_rejected");
  return stageNativePublicationBatch(env,{
    ...input,
    commands:[{
      ...input.command,
      repairOf:{
        publicationId:input.rejectedPublicationId,
        deliveryItemId:input.rejectedDeliveryItemId,
      },
    }],
    closeSequence:true,
  });
}
