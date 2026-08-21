import { deliveryEvidenceTransitionAllowed } from "./stateMachine";
import type {
  NormalizedDeliveryEvidenceClass,
  PublicationAggregateSnapshot,
  PublicationConsumptionPlan,
  PublicationDeliveryItemSnapshot,
  PublicationOutcome,
  PublicationPurpose,
  PublicationTextRole,
  RecordPublicationEvidenceInput,
  StagePublicationInput,
} from "./types";

export class PublicationRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PublicationRepositoryError";
  }
}

export class PublicationRevisionConflictError extends PublicationRepositoryError {
  constructor(code = "publication_revision_conflict") {
    super(code);
    this.name = "PublicationRevisionConflictError";
  }
}

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PublicationRepositoryError(code);
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: string, code: string): string[] {
  const parsed: unknown = JSON.parse(value);
  requireValue(Array.isArray(parsed) && parsed.every((item) => typeof item === "string"), code);
  return parsed;
}

function parseConsumerPlan(value: unknown, code: string): PublicationConsumptionPlan["conversation"] {
  requireValue(isRecord(value), code);
  const disposition = value.disposition;
  const textSource = value.textSource;
  const reasonCode = value.reasonCode;
  requireValue(disposition === "publish" || disposition === "exclude" || disposition === "hold", code);
  requireValue(textSource === "canonical_visible_text" || textSource === null, code);
  requireValue(typeof reasonCode === "string" && nonEmpty(reasonCode), code);
  return { disposition, textSource, reasonCode };
}

function parseConsumptionPlan(value: string): PublicationConsumptionPlan {
  const parsed: unknown = JSON.parse(value);
  requireValue(isRecord(parsed), "publication_consumption_plan_invalid");
  return {
    conversation: parseConsumerPlan(parsed.conversation, "publication_conversation_plan_invalid"),
    memory: parseConsumerPlan(parsed.memory, "publication_memory_plan_invalid"),
  };
}

type OutcomeRow = {
  publication_id: string;
  channel: "telegram";
  recipient_scope: string;
  inference_run_id: string;
  delivery_batch_ids_json: string;
  state: "delivered" | "rejected" | "unknown";
  confirmed_payload_refs_json: string;
  rejected_payload_refs_json: string;
  unknown_payload_refs_json: string;
  skipped_payload_refs_json: string;
  confirmed_visible_text: string | null;
  canonical_visible_text: string | null;
  consumption_plan_json: string;
  reason_code: string;
  revision: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
};

const OUTCOME_COLUMNS = `publication_id,channel,recipient_scope,inference_run_id,delivery_batch_ids_json,state,
  confirmed_payload_refs_json,rejected_payload_refs_json,unknown_payload_refs_json,skipped_payload_refs_json,
  confirmed_visible_text,canonical_visible_text,consumption_plan_json,reason_code,revision,
  created_at,updated_at,terminal_at`;

function outcomeFromRow(row: OutcomeRow): PublicationOutcome {
  return {
    publicationId: row.publication_id,
    channel: row.channel,
    recipientScope: row.recipient_scope,
    inferenceRunId: row.inference_run_id,
    deliveryBatchIds: parseStringArray(row.delivery_batch_ids_json, "publication_delivery_batch_ids_invalid"),
    state: row.state,
    confirmedPayloadRefs: parseStringArray(row.confirmed_payload_refs_json, "publication_confirmed_refs_invalid"),
    rejectedPayloadRefs: parseStringArray(row.rejected_payload_refs_json, "publication_rejected_refs_invalid"),
    unknownPayloadRefs: parseStringArray(row.unknown_payload_refs_json, "publication_unknown_refs_invalid"),
    skippedPayloadRefs: parseStringArray(row.skipped_payload_refs_json, "publication_skipped_refs_invalid"),
    confirmedVisibleText: row.confirmed_visible_text,
    canonicalVisibleText: row.canonical_visible_text,
    consumptionPlan: parseConsumptionPlan(row.consumption_plan_json),
    reasonCode: row.reason_code,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function validateStageInput(input: StagePublicationInput): void {
  requireValue(nonEmpty(input.publicationId), "publication_id_missing");
  requireValue(nonEmpty(input.recipientScope), "publication_recipient_scope_missing");
  requireValue(nonEmpty(input.inferenceRunId), "publication_inference_run_id_missing");
  requireValue(validIso(input.createdAt), "publication_created_at_invalid");
  requireValue(input.batches.length > 0, "publication_delivery_batches_missing");
  requireValue(input.items.length > 0, "publication_delivery_items_missing");

  const batchIds = new Set<string>();
  const batchOrders = new Set<number>();
  for (const batch of input.batches) {
    requireValue(nonEmpty(batch.deliveryBatchId), "publication_delivery_batch_id_missing");
    requireValue(Number.isSafeInteger(batch.batchOrder) && batch.batchOrder >= 0,
      "publication_delivery_batch_order_invalid");
    requireValue(!batchIds.has(batch.deliveryBatchId), "publication_delivery_batch_duplicate");
    requireValue(!batchOrders.has(batch.batchOrder), "publication_delivery_batch_order_duplicate");
    batchIds.add(batch.deliveryBatchId);
    batchOrders.add(batch.batchOrder);
  }

  const itemIds = new Set<string>();
  const payloadRefs = new Set<string>();
  const intentKeys = new Set<string>();
  const indexes = new Set<number>();
  for (const item of input.items) {
    requireValue(nonEmpty(item.deliveryItemId), "publication_delivery_item_id_missing");
    requireValue(nonEmpty(item.payloadRef), "publication_payload_ref_missing");
    requireValue(nonEmpty(item.intentKey), "publication_intent_key_missing");
    requireValue(batchIds.has(item.deliveryBatchId), "publication_delivery_item_batch_unknown");
    requireValue(Number.isSafeInteger(item.sequenceIndex) && item.sequenceIndex >= 0,
      "publication_sequence_index_invalid");
    requireValue(!itemIds.has(item.deliveryItemId), "publication_delivery_item_id_duplicate");
    requireValue(!payloadRefs.has(item.payloadRef), "publication_payload_ref_duplicate");
    requireValue(!intentKeys.has(item.intentKey), "publication_intent_key_duplicate");
    requireValue(!indexes.has(item.sequenceIndex), "publication_sequence_index_duplicate");
    itemIds.add(item.deliveryItemId);
    payloadRefs.add(item.payloadRef);
    intentKeys.add(item.intentKey);
    indexes.add(item.sequenceIndex);
    if (item.textRole === "none") {
      requireValue(item.visibleTextFragment === null, "publication_non_text_fragment_present");
    } else {
      requireValue(typeof item.visibleTextFragment === "string" && nonEmpty(item.visibleTextFragment),
        "publication_visible_text_fragment_missing");
    }
    if (item.textRole === "assistant") {
      requireValue(item.required, "publication_assistant_text_must_be_required");
      requireValue(input.purpose === "assistant_response", "publication_non_assistant_has_assistant_text");
    }
  }
}

type AggregateRow = {
  publication_id: string;
  channel: "telegram";
  recipient_scope: string;
  inference_run_id: string;
  publication_purpose: PublicationPurpose;
  required_sequence_closed: number;
  created_at: string;
};

type BatchRow = { delivery_batch_id: string; batch_order: number };
type ItemRow = {
  delivery_item_id: string;
  payload_ref: string;
  intent_key: string;
  delivery_batch_id: string;
  sequence_index: number;
  required: number;
  text_role: PublicationTextRole;
  visible_text_fragment: string | null;
  evidence_class: NormalizedDeliveryEvidenceClass;
  evidence_ref: string | null;
};

/**
 * Delivery-native staging needs to commit its transport command and the
 * Publication identities in one D1 transaction. The repository remains the
 * owner of the Gate-A insert contract; callers may compose these statements
 * with their own durable command statements and then call the verifier.
 */
export function prepareStagePublicationStatements(
  db: D1Database,
  input: StagePublicationInput,
): D1PreparedStatement[] {
  validateStageInput(input);
  return [
    db.prepare(`INSERT INTO publication_aggregates(
      publication_id,channel,recipient_scope,inference_run_id,publication_purpose,
      required_sequence_closed,created_at,updated_at
    ) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(publication_id) DO NOTHING`)
      .bind(input.publicationId,input.channel,input.recipientScope,input.inferenceRunId,input.purpose,
        input.createdAt,input.createdAt),
    ...input.batches.map((batch) => db.prepare(`INSERT INTO publication_delivery_batches(
      publication_id,delivery_batch_id,batch_order,created_at
    ) VALUES(?,?,?,?) ON CONFLICT(publication_id,delivery_batch_id) DO NOTHING`)
      .bind(input.publicationId,batch.deliveryBatchId,batch.batchOrder,input.createdAt)),
    ...input.items.map((item) => db.prepare(`INSERT INTO publication_delivery_items(
      delivery_item_id,publication_id,delivery_batch_id,payload_ref,intent_key,sequence_index,
      required,text_role,visible_text_fragment,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_item_id) DO NOTHING`)
      .bind(item.deliveryItemId,input.publicationId,item.deliveryBatchId,item.payloadRef,item.intentKey,
        item.sequenceIndex,item.required ? 1 : 0,item.textRole,item.visibleTextFragment,input.createdAt)),
  ];
}

export async function verifyStagedPublication(
  db: D1Database,
  input: StagePublicationInput,
): Promise<void> {
  validateStageInput(input);
  const aggregate = await db.prepare(`SELECT publication_id,channel,recipient_scope,inference_run_id,
    publication_purpose,required_sequence_closed,created_at
    FROM publication_aggregates WHERE publication_id=?`).bind(input.publicationId).first<AggregateRow>();
  requireValue(aggregate !== null, "publication_stage_missing_after_write");
  requireValue(aggregate.channel === input.channel
    && aggregate.recipient_scope === input.recipientScope
    && aggregate.inference_run_id === input.inferenceRunId
    && aggregate.publication_purpose === input.purpose,
  "publication_stage_identity_conflict");

  const batches = await db.prepare(`SELECT delivery_batch_id,batch_order FROM publication_delivery_batches
    WHERE publication_id=? ORDER BY batch_order`).bind(input.publicationId).all<BatchRow>();
  const storedBatches = batches.results ?? [];
  requireValue(input.batches.every((expected) => {
    const actual = storedBatches.find((batch) => batch.delivery_batch_id === expected.deliveryBatchId);
    return actual?.batch_order === expected.batchOrder;
  }), "publication_stage_batch_conflict");

  const items = await db.prepare(`SELECT delivery_item_id,payload_ref,intent_key,delivery_batch_id,sequence_index,required,
    text_role,visible_text_fragment,'pending' AS evidence_class,NULL AS evidence_ref
    FROM publication_delivery_items WHERE publication_id=? ORDER BY sequence_index`)
    .bind(input.publicationId).all<ItemRow>();
  const storedItems = items.results ?? [];
  requireValue(input.items.every((expected) => {
    const actual = storedItems.find((item) => item.delivery_item_id === expected.deliveryItemId);
    return actual?.payload_ref === expected.payloadRef
      && actual.intent_key === expected.intentKey
      && actual.delivery_batch_id === expected.deliveryBatchId
      && actual.sequence_index === expected.sequenceIndex
      && actual.required === (expected.required ? 1 : 0)
      && actual.text_role === expected.textRole
      && actual.visible_text_fragment === expected.visibleTextFragment;
  }), "publication_stage_item_conflict");
}

export async function stagePublication(db: D1Database, input: StagePublicationInput): Promise<void> {
  await db.batch(prepareStagePublicationStatements(db,input));
  await verifyStagedPublication(db,input);
}

export async function sealPublicationSequence(
  db: D1Database,
  publicationId: string,
  sealedAt: string,
): Promise<{ changed: boolean }> {
  requireValue(nonEmpty(publicationId), "publication_id_missing");
  requireValue(validIso(sealedAt), "publication_sealed_at_invalid");
  const updated = await db.prepare(`UPDATE publication_aggregates SET required_sequence_closed=1,updated_at=?
    WHERE publication_id=? AND required_sequence_closed=0
      AND EXISTS(SELECT 1 FROM publication_delivery_items
        WHERE publication_id=? AND required=1)
    RETURNING publication_id`)
    .bind(sealedAt,publicationId,publicationId).first<{publication_id:string}>();
  if (updated) return { changed: true };
  const current = await db.prepare(`SELECT required_sequence_closed FROM publication_aggregates WHERE publication_id=?`)
    .bind(publicationId).first<{required_sequence_closed:number}>();
  requireValue(current !== null, "publication_aggregate_missing");
  if (current.required_sequence_closed === 0) {
    throw new PublicationRepositoryError("publication_required_delivery_items_missing");
  }
  requireValue(current.required_sequence_closed === 1, "publication_sequence_seal_failed");
  return { changed: false };
}

type EvidenceRow = {
  evidence_ref: string;
  publication_id: string;
  delivery_item_id: string;
  evidence_revision: number;
  evidence_class: Exclude<NormalizedDeliveryEvidenceClass,"pending">;
  observed_at: string;
};

export type PublicationDeliveryEvidenceHead = {
  evidenceRef: string;
  evidenceRevision: number;
  evidenceClass: Exclude<NormalizedDeliveryEvidenceClass,"pending">;
  observedAt: string;
};

export async function readPublicationDeliveryEvidenceHead(
  db: D1Database,
  deliveryItemId: string,
): Promise<PublicationDeliveryEvidenceHead | null> {
  requireValue(nonEmpty(deliveryItemId), "publication_delivery_item_id_missing");
  const row = await db.prepare(`SELECT evidence_ref,publication_id,delivery_item_id,evidence_revision,
    evidence_class,observed_at FROM publication_delivery_evidence
    WHERE delivery_item_id=? ORDER BY evidence_revision DESC LIMIT 1`)
    .bind(deliveryItemId).first<EvidenceRow>();
  return row ? {
    evidenceRef:row.evidence_ref,
    evidenceRevision:row.evidence_revision,
    evidenceClass:row.evidence_class,
    observedAt:row.observed_at,
  } : null;
}

export async function recordPublicationDeliveryEvidence(
  db: D1Database,
  input: RecordPublicationEvidenceInput,
): Promise<{ evidenceRevision: number; replayed: boolean }> {
  requireValue(nonEmpty(input.publicationId), "publication_id_missing");
  requireValue(nonEmpty(input.deliveryItemId), "publication_delivery_item_id_missing");
  requireValue(nonEmpty(input.evidenceRef), "publication_delivery_evidence_ref_missing");
  requireValue(Number.isSafeInteger(input.expectedEvidenceRevision) && input.expectedEvidenceRevision >= 0,
    "publication_delivery_evidence_expected_revision_invalid");
  requireValue(validIso(input.observedAt), "publication_delivery_evidence_observed_at_invalid");

  if (input.evidenceClass === "skipped") {
    const item = await db.prepare(`SELECT required FROM publication_delivery_items
      WHERE publication_id=? AND delivery_item_id=?`)
      .bind(input.publicationId,input.deliveryItemId).first<{required:number}>();
    requireValue(item !== null, "publication_delivery_item_missing");
    requireValue(item.required === 0, "publication_required_item_skipped");
  }

  const replay = await db.prepare(`SELECT evidence_ref,publication_id,delivery_item_id,evidence_revision,
    evidence_class,observed_at FROM publication_delivery_evidence WHERE evidence_ref=?`)
    .bind(input.evidenceRef).first<EvidenceRow>();
  if (replay) {
    requireValue(replay.publication_id === input.publicationId
      && replay.delivery_item_id === input.deliveryItemId
      && replay.evidence_revision === input.expectedEvidenceRevision + 1
      && replay.evidence_class === input.evidenceClass
      && replay.observed_at === input.observedAt,
    "publication_delivery_evidence_identity_conflict");
    return { evidenceRevision: replay.evidence_revision, replayed: true };
  }

  const latest = await db.prepare(`SELECT evidence_ref,publication_id,delivery_item_id,evidence_revision,
    evidence_class,observed_at FROM publication_delivery_evidence
    WHERE delivery_item_id=? ORDER BY evidence_revision DESC LIMIT 1`)
    .bind(input.deliveryItemId).first<EvidenceRow>();
  const currentRevision = latest?.evidence_revision ?? 0;
  const currentClass: NormalizedDeliveryEvidenceClass = latest?.evidence_class ?? "pending";
  if (currentRevision !== input.expectedEvidenceRevision) {
    throw new PublicationRevisionConflictError("publication_delivery_evidence_revision_conflict");
  }
  requireValue(deliveryEvidenceTransitionAllowed(currentClass,input.evidenceClass),
    "publication_delivery_evidence_transition_forbidden");

  const nextRevision = input.expectedEvidenceRevision + 1;
  const inserted = await db.prepare(`INSERT INTO publication_delivery_evidence(
      evidence_ref,publication_id,delivery_item_id,evidence_revision,evidence_class,observed_at,created_at
    ) SELECT ?,?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM publication_delivery_items
      WHERE publication_id=? AND delivery_item_id=?)
      AND COALESCE((SELECT MAX(evidence_revision) FROM publication_delivery_evidence
        WHERE delivery_item_id=?),0)=?
    ON CONFLICT(evidence_ref) DO NOTHING
    RETURNING evidence_revision`)
    .bind(input.evidenceRef,input.publicationId,input.deliveryItemId,nextRevision,input.evidenceClass,
      input.observedAt,input.observedAt,input.publicationId,input.deliveryItemId,input.deliveryItemId,
      input.expectedEvidenceRevision)
    .first<{evidence_revision:number}>();
  if (!inserted) {
    const concurrentReplay = await db.prepare(`SELECT evidence_ref,publication_id,delivery_item_id,evidence_revision,
      evidence_class,observed_at FROM publication_delivery_evidence WHERE evidence_ref=?`)
      .bind(input.evidenceRef).first<EvidenceRow>();
    if (concurrentReplay
      && concurrentReplay.publication_id === input.publicationId
      && concurrentReplay.delivery_item_id === input.deliveryItemId
      && concurrentReplay.evidence_revision === nextRevision
      && concurrentReplay.evidence_class === input.evidenceClass
      && concurrentReplay.observed_at === input.observedAt) {
      return { evidenceRevision: concurrentReplay.evidence_revision, replayed: true };
    }
    throw new PublicationRevisionConflictError("publication_delivery_evidence_revision_conflict");
  }
  return { evidenceRevision: inserted.evidence_revision, replayed: false };
}

export async function readPublicationAggregateSnapshot(
  db: D1Database,
  publicationId: string,
): Promise<PublicationAggregateSnapshot | null> {
  const aggregate = await db.prepare(`SELECT publication_id,channel,recipient_scope,inference_run_id,
    publication_purpose,required_sequence_closed,created_at
    FROM publication_aggregates WHERE publication_id=?`).bind(publicationId).first<AggregateRow>();
  if (!aggregate) return null;
  const batches = await db.prepare(`SELECT delivery_batch_id,batch_order FROM publication_delivery_batches
    WHERE publication_id=? ORDER BY batch_order`).bind(publicationId).all<BatchRow>();
  const items = await db.prepare(`SELECT item.delivery_item_id,item.payload_ref,item.delivery_batch_id,
      item.intent_key,item.sequence_index,item.required,item.text_role,item.visible_text_fragment,
      COALESCE(evidence.evidence_class,'pending') AS evidence_class,evidence.evidence_ref
    FROM publication_delivery_items item
    LEFT JOIN publication_delivery_evidence evidence
      ON evidence.delivery_item_id=item.delivery_item_id
      AND evidence.evidence_revision=(SELECT MAX(latest.evidence_revision)
        FROM publication_delivery_evidence latest WHERE latest.delivery_item_id=item.delivery_item_id)
    WHERE item.publication_id=? ORDER BY item.sequence_index`)
    .bind(publicationId).all<ItemRow>();
  return {
    publicationId: aggregate.publication_id,
    channel: aggregate.channel,
    recipientScope: aggregate.recipient_scope,
    inferenceRunId: aggregate.inference_run_id,
    purpose: aggregate.publication_purpose,
    deliveryBatchIds: (batches.results ?? []).map((batch) => batch.delivery_batch_id),
    requiredSequenceClosed: aggregate.required_sequence_closed === 1,
    items: (items.results ?? []).map((item): PublicationDeliveryItemSnapshot => ({
      deliveryItemId: item.delivery_item_id,
      payloadRef: item.payload_ref,
      deliveryBatchId: item.delivery_batch_id,
      sequenceIndex: item.sequence_index,
      required: item.required === 1,
      evidenceClass: item.evidence_class,
      evidenceRef: item.evidence_ref,
      textRole: item.text_role,
      visibleTextFragment: item.visible_text_fragment,
    })),
  };
}

export async function readPublicationOutcome(
  db: D1Database,
  publicationId: string,
): Promise<PublicationOutcome | null> {
  const row = await db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM publication_outcomes WHERE publication_id=?`)
    .bind(publicationId).first<OutcomeRow>();
  return row ? outcomeFromRow(row) : null;
}

function sameOutcome(left: PublicationOutcome, right: PublicationOutcome): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function outcomeBindings(outcome: PublicationOutcome): unknown[] {
  return [
    outcome.channel,
    outcome.recipientScope,
    outcome.inferenceRunId,
    JSON.stringify(outcome.deliveryBatchIds),
    outcome.state,
    JSON.stringify(outcome.confirmedPayloadRefs),
    JSON.stringify(outcome.rejectedPayloadRefs),
    JSON.stringify(outcome.unknownPayloadRefs),
    JSON.stringify(outcome.skippedPayloadRefs),
    outcome.confirmedVisibleText,
    outcome.canonicalVisibleText,
    JSON.stringify(outcome.consumptionPlan),
    outcome.reasonCode,
    outcome.revision,
    outcome.createdAt,
    outcome.updatedAt,
    outcome.terminalAt,
  ];
}

export async function commitPublicationOutcome(
  db: D1Database,
  outcome: PublicationOutcome,
  expectedRevision: number,
): Promise<{ outcome: PublicationOutcome; replayed: boolean }> {
  requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    "publication_expected_revision_invalid");
  requireValue(outcome.revision === expectedRevision + 1, "publication_next_revision_invalid");
  requireValue(validIso(outcome.createdAt) && validIso(outcome.updatedAt),
    "publication_outcome_timestamp_invalid");
  requireValue(outcome.state === "unknown"
    ? outcome.terminalAt === null
    : validIso(outcome.terminalAt ?? ""),
  "publication_outcome_terminal_timestamp_invalid");

  let written: OutcomeRow | null;
  if (expectedRevision === 0) {
    written = await db.prepare(`INSERT INTO publication_outcomes(
      publication_id,channel,recipient_scope,inference_run_id,delivery_batch_ids_json,state,
      confirmed_payload_refs_json,rejected_payload_refs_json,unknown_payload_refs_json,
      skipped_payload_refs_json,confirmed_visible_text,canonical_visible_text,consumption_plan_json,
      reason_code,revision,created_at,updated_at,terminal_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(publication_id) DO NOTHING RETURNING ${OUTCOME_COLUMNS}`)
      .bind(outcome.publicationId,...outcomeBindings(outcome)).first<OutcomeRow>();
  } else {
    written = await db.prepare(`UPDATE publication_outcomes SET
      channel=?,recipient_scope=?,inference_run_id=?,delivery_batch_ids_json=?,state=?,
      confirmed_payload_refs_json=?,rejected_payload_refs_json=?,unknown_payload_refs_json=?,
      skipped_payload_refs_json=?,confirmed_visible_text=?,canonical_visible_text=?,consumption_plan_json=?,
      reason_code=?,revision=?,created_at=?,updated_at=?,terminal_at=?
    WHERE publication_id=? AND revision=? RETURNING ${OUTCOME_COLUMNS}`)
      .bind(...outcomeBindings(outcome),outcome.publicationId,expectedRevision).first<OutcomeRow>();
  }
  if (written) return { outcome: outcomeFromRow(written), replayed: false };

  const current = await readPublicationOutcome(db,outcome.publicationId);
  if (current && sameOutcome(current,outcome)) return { outcome: current, replayed: true };
  throw new PublicationRevisionConflictError();
}

export async function listPublicationOutcomeRevisions(
  db: D1Database,
  publicationId: string,
): Promise<PublicationOutcome[]> {
  const rows = await db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM publication_outcome_revisions
    WHERE publication_id=? ORDER BY revision`).bind(publicationId).all<OutcomeRow>();
  return (rows.results ?? []).map(outcomeFromRow);
}
