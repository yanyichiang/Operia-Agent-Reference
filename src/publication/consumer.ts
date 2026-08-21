import { nowIso } from "../utils/time";
import type {
  PublicationConsumerDisposition,
  PublicationOutcome,
} from "./types";
import { readPublicationOutcome } from "./repository";

export type AssistantPublicationProjectionState =
  | "delivered"
  | "delivered_partial"
  | "delivery_unknown"
  | "excluded";

export type PublicationAssistantConsumption = {
  publicationId:string;
  inferenceRunId:string;
  recipientScope:string;
  revision:number;
  state:PublicationOutcome["state"];
  conversationDisposition:PublicationConsumerDisposition;
  memoryDisposition:PublicationConsumerDisposition;
  conversationAssistantText:string | null;
  memoryAssistantText:string | null;
  canonicalAssistantText:string | null;
  messageProjectionState:AssistantPublicationProjectionState;
};

export type PublicationConsumerCheckpoint = {
  publicationId:string;
  inferenceRunId:string;
  recipientScope:string;
  conversationEventId:string;
  outcomeRevision:number;
  outcomeState:PublicationOutcome["state"];
  conversationDisposition:PublicationConsumerDisposition;
  memoryDisposition:PublicationConsumerDisposition;
  conversationStatus:"pending"|"applied"|"excluded"|"hold";
  memoryStatus:"pending"|"applied"|"excluded"|"hold";
  maintenanceStatus:"pending"|"enqueued"|"not_required";
  conversationAppliedRevision:number|null;
  memoryAppliedRevision:number|null;
};

type CheckpointRow = {
  publication_id:string;
  inference_run_id:string;
  recipient_scope:string;
  conversation_event_id:string;
  outcome_revision:number;
  outcome_state:PublicationOutcome["state"];
  conversation_disposition:PublicationConsumerDisposition;
  memory_disposition:PublicationConsumerDisposition;
  conversation_status:PublicationConsumerCheckpoint["conversationStatus"];
  memory_status:PublicationConsumerCheckpoint["memoryStatus"];
  maintenance_status:PublicationConsumerCheckpoint["maintenanceStatus"];
  conversation_applied_revision:number|null;
  memory_applied_revision:number|null;
};

export type PublicationMemoryMessage = {
  id:string;
  conversationId:string;
  namespace:string;
};

export type RegisteredPublicationConsumption = {
  outcome:PublicationOutcome;
  consumption:PublicationAssistantConsumption;
  checkpoint:PublicationConsumerCheckpoint;
};

function requireContract(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function dispositionText(
  outcome: PublicationOutcome,
  consumer: "conversation" | "memory",
): string | null {
  const plan = outcome.consumptionPlan[consumer];
  if (plan.disposition !== "publish") {
    requireContract(plan.textSource === null,`publication_${consumer}_excluded_text_source_invalid`);
    return null;
  }
  requireContract(outcome.state === "delivered",`publication_${consumer}_publish_state_invalid`);
  requireContract(plan.textSource === "canonical_visible_text",`publication_${consumer}_text_source_invalid`);
  requireContract(typeof outcome.canonicalVisibleText === "string"
    && outcome.canonicalVisibleText.trim().length > 0,`publication_${consumer}_canonical_text_missing`);
  return outcome.canonicalVisibleText;
}

/**
 * Pure assistant-consumption policy. No Telegram, inference, outbox, paragraph,
 * or finish-reason state is accepted by this boundary.
 */
export function planPublicationAssistantConsumption(
  outcome: PublicationOutcome,
): PublicationAssistantConsumption {
  const conversationAssistantText = dispositionText(outcome,"conversation");
  const memoryAssistantText = dispositionText(outcome,"memory");
  if (outcome.state === "unknown") {
    requireContract(outcome.consumptionPlan.conversation.disposition === "hold"
      && outcome.consumptionPlan.memory.disposition === "hold",
    "publication_unknown_consumption_plan_invalid");
    requireContract(outcome.canonicalVisibleText === null,"publication_unknown_canonical_text_forbidden");
  }
  if (outcome.state === "rejected") {
    requireContract(outcome.consumptionPlan.conversation.disposition === "exclude"
      && outcome.consumptionPlan.memory.disposition === "exclude",
    "publication_rejected_consumption_plan_invalid");
  }
  const messageProjectionState: AssistantPublicationProjectionState = outcome.state === "unknown"
    ? "delivery_unknown"
    : outcome.state === "rejected"
      ? "excluded"
      : outcome.consumptionPlan.memory.disposition === "publish"
        ? "delivered"
        : outcome.consumptionPlan.conversation.disposition === "publish"
          ? "delivered_partial"
          : "excluded";
  return {
    publicationId:outcome.publicationId,
    inferenceRunId:outcome.inferenceRunId,
    recipientScope:outcome.recipientScope,
    revision:outcome.revision,
    state:outcome.state,
    conversationDisposition:outcome.consumptionPlan.conversation.disposition,
    memoryDisposition:outcome.consumptionPlan.memory.disposition,
    conversationAssistantText,
    memoryAssistantText,
    canonicalAssistantText:outcome.state === "delivered" ? outcome.canonicalVisibleText : null,
    messageProjectionState,
  };
}

function checkpointFromRow(row: CheckpointRow): PublicationConsumerCheckpoint {
  return {
    publicationId:row.publication_id,
    inferenceRunId:row.inference_run_id,
    recipientScope:row.recipient_scope,
    conversationEventId:row.conversation_event_id,
    outcomeRevision:row.outcome_revision,
    outcomeState:row.outcome_state,
    conversationDisposition:row.conversation_disposition,
    memoryDisposition:row.memory_disposition,
    conversationStatus:row.conversation_status,
    memoryStatus:row.memory_status,
    maintenanceStatus:row.maintenance_status,
    conversationAppliedRevision:row.conversation_applied_revision,
    memoryAppliedRevision:row.memory_applied_revision,
  };
}

const CHECKPOINT_COLUMNS = `publication_id,inference_run_id,recipient_scope,conversation_event_id,
  outcome_revision,outcome_state,conversation_disposition,memory_disposition,
  conversation_status,memory_status,maintenance_status,
  conversation_applied_revision,memory_applied_revision`;

export async function readPublicationConsumerCheckpoint(
  db:D1Database,
  publicationId:string,
):Promise<PublicationConsumerCheckpoint|null> {
  const row = await db.prepare(`SELECT ${CHECKPOINT_COLUMNS}
    FROM publication_consumer_checkpoints WHERE publication_id=?`)
    .bind(publicationId).first<CheckpointRow>();
  return row ? checkpointFromRow(row) : null;
}

export async function registerPublicationConsumption(
  db:D1Database,
  input:{ publicationId:string; conversationEventId:string },
):Promise<RegisteredPublicationConsumption> {
  const outcome = await readPublicationOutcome(db,input.publicationId);
  if (!outcome) throw new Error("publication_consumer_outcome_missing");
  const consumption = planPublicationAssistantConsumption(outcome);
  const now = nowIso();
  const maintenanceStatus = consumption.memoryDisposition === "publish" ? "pending" : "not_required";
  const written = await db.prepare(`INSERT INTO publication_consumer_checkpoints(
      publication_id,inference_run_id,recipient_scope,conversation_event_id,
      outcome_revision,outcome_state,conversation_disposition,memory_disposition,
      conversation_status,memory_status,maintenance_status,created_at,updated_at
    ) SELECT ?,?,?,?,?,?,?,?,'pending','pending',?,?,?
    FROM publication_outcomes outcome
    WHERE outcome.publication_id=? AND outcome.revision=? AND outcome.state=?
      AND outcome.inference_run_id=? AND outcome.recipient_scope=?
      AND json_extract(outcome.consumption_plan_json,'$.conversation.disposition')=?
      AND json_extract(outcome.consumption_plan_json,'$.memory.disposition')=?
    ON CONFLICT(publication_id) DO UPDATE SET
      outcome_revision=excluded.outcome_revision,
      outcome_state=excluded.outcome_state,
      conversation_disposition=excluded.conversation_disposition,
      memory_disposition=excluded.memory_disposition,
      conversation_status=CASE
        WHEN publication_consumer_checkpoints.outcome_revision<excluded.outcome_revision
        THEN 'pending' ELSE publication_consumer_checkpoints.conversation_status END,
      memory_status=CASE
        WHEN publication_consumer_checkpoints.outcome_revision<excluded.outcome_revision
        THEN 'pending' ELSE publication_consumer_checkpoints.memory_status END,
      maintenance_status=CASE
        WHEN publication_consumer_checkpoints.outcome_revision<excluded.outcome_revision
        THEN excluded.maintenance_status ELSE publication_consumer_checkpoints.maintenance_status END,
      updated_at=CASE
        WHEN publication_consumer_checkpoints.outcome_revision<excluded.outcome_revision
        THEN excluded.updated_at ELSE publication_consumer_checkpoints.updated_at END
    WHERE publication_consumer_checkpoints.outcome_revision<excluded.outcome_revision
      OR (publication_consumer_checkpoints.outcome_revision=excluded.outcome_revision
        AND publication_consumer_checkpoints.inference_run_id=excluded.inference_run_id
        AND publication_consumer_checkpoints.recipient_scope=excluded.recipient_scope
        AND publication_consumer_checkpoints.conversation_event_id=excluded.conversation_event_id
        AND publication_consumer_checkpoints.outcome_state=excluded.outcome_state
        AND publication_consumer_checkpoints.conversation_disposition=excluded.conversation_disposition
        AND publication_consumer_checkpoints.memory_disposition=excluded.memory_disposition)
    RETURNING ${CHECKPOINT_COLUMNS}`)
    .bind(consumption.publicationId,consumption.inferenceRunId,
      consumption.recipientScope,input.conversationEventId,consumption.revision,
      consumption.state,consumption.conversationDisposition,
      consumption.memoryDisposition,maintenanceStatus,now,now,
      consumption.publicationId,consumption.revision,consumption.state,
      consumption.inferenceRunId,consumption.recipientScope,
      consumption.conversationDisposition,consumption.memoryDisposition)
    .first<CheckpointRow>();
  if (!written) {
    const current = await readPublicationOutcome(db,consumption.publicationId);
    if (!current || current.revision !== consumption.revision) {
      throw new Error("publication_consumer_revision_superseded");
    }
    throw new Error("publication_consumer_checkpoint_conflict");
  }
  const stored = checkpointFromRow(written);
  requireContract(stored.inferenceRunId === consumption.inferenceRunId
    && stored.recipientScope === consumption.recipientScope
    && stored.conversationEventId === input.conversationEventId,
  "publication_consumer_checkpoint_identity_conflict");
  requireContract(stored.outcomeRevision >= consumption.revision,
    "publication_consumer_checkpoint_revision_regression");
  if (stored.outcomeRevision === consumption.revision) {
    requireContract(stored.outcomeState === consumption.state
      && stored.conversationDisposition === consumption.conversationDisposition
      && stored.memoryDisposition === consumption.memoryDisposition,
    "publication_consumer_checkpoint_plan_conflict");
  }
  return {outcome,consumption,checkpoint:stored};
}

export async function markPublicationConversationConsumed(
  db:D1Database,
  input:{
    publicationId:string;
    revision:number;
  },
):Promise<boolean> {
  const row = await db.prepare(`UPDATE publication_consumer_checkpoints
    SET conversation_status=CASE conversation_disposition
        WHEN 'publish' THEN 'applied' WHEN 'exclude' THEN 'excluded' ELSE 'hold' END,
      conversation_applied_revision=?,updated_at=?
    WHERE publication_id=? AND outcome_revision=?
      AND EXISTS(SELECT 1 FROM publication_outcomes outcome
        WHERE outcome.publication_id=? AND outcome.revision=?)
    RETURNING publication_id`)
    .bind(input.revision,nowIso(),input.publicationId,input.revision,
      input.publicationId,input.revision)
    .first<{publication_id:string}>();
  return Boolean(row);
}

/**
 * Atomically replaces the generated candidate with the exact visible
 * Publication text and updates its rebuildable episodic/FTS projections.
 */
export async function materializePublicationMemory(
  db:D1Database,
  input:{
    publicationId:string;
    outcomeRevision:number;
    publicationRef:string;
    turnOrderKey?:number|null;
  },
):Promise<PublicationMemoryMessage[]> {
  const outcome = await readPublicationOutcome(db,input.publicationId);
  if (!outcome || outcome.revision !== input.outcomeRevision) {
    throw new Error("publication_consumer_revision_superseded");
  }
  const consumption = planPublicationAssistantConsumption(outcome);
  const checkpoint = await readPublicationConsumerCheckpoint(db,input.publicationId);
  if (!checkpoint || checkpoint.outcomeRevision !== input.outcomeRevision
    || checkpoint.outcomeState !== consumption.state
    || checkpoint.memoryDisposition !== consumption.memoryDisposition
    || checkpoint.recipientScope !== consumption.recipientScope
    || checkpoint.inferenceRunId !== consumption.inferenceRunId) {
    throw new Error("publication_consumer_checkpoint_mismatch");
  }
  if (checkpoint.memoryAppliedRevision === input.outcomeRevision
    && checkpoint.memoryStatus !== "pending") {
    const replayRows = await db.prepare(`SELECT id,conversation_id,namespace FROM messages
      WHERE source='telegram' AND role='assistant' AND publication_ref=? ORDER BY created_at,id`)
      .bind(input.publicationRef).all<{id:string;conversation_id:string;namespace:string}>();
    return (replayRows.results ?? []).map((row) => ({
      id:row.id,conversationId:row.conversation_id,namespace:row.namespace,
    }));
  }
  const candidateRows = await db.prepare(`SELECT id,conversation_id,namespace,created_at FROM messages
    WHERE source='telegram' AND role='assistant' AND publication_ref=? ORDER BY created_at,id`)
    .bind(input.publicationRef).all<{
      id:string;conversation_id:string;namespace:string;created_at:string;
  }>();
  const candidates = candidateRows.results ?? [];
  if (consumption.memoryDisposition === "publish" && candidates.length === 0) {
    throw new Error("publication_memory_candidate_missing");
  }
  const now = nowIso();
  const materializedContent = consumption.canonicalAssistantText ?? "";
  const finalMemoryStatus = consumption.memoryDisposition === "publish"
    ? "applied" : consumption.memoryDisposition === "exclude" ? "excluded" : "hold";
  const statements:D1PreparedStatement[] = [
    db.prepare(`UPDATE messages SET content=?,publication_state=?,publication_resolved_at=?,
        publication_outcome_revision=?,turn_order_key=COALESCE(turn_order_key,?),turn_item_order=1
      WHERE source='telegram' AND role='assistant' AND publication_ref=?
        AND (publication_outcome_revision IS NULL OR publication_outcome_revision<=?)
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
        AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
          WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
      .bind(materializedContent,consumption.messageProjectionState,now,input.outcomeRevision,
        Number.isSafeInteger(input.turnOrderKey) ? input.turnOrderKey : null,
        input.publicationRef,input.outcomeRevision,input.publicationId,input.outcomeRevision,
        input.publicationId,input.outcomeRevision),
  ];
  for (const candidate of candidates) {
    statements.push(db.prepare(`DELETE FROM episodic_fts WHERE projection_id=?
      AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
        WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
      AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
        WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
      .bind(`ep_${candidate.id}`,input.publicationId,input.outcomeRevision,
        input.publicationId,input.outcomeRevision));
    if (consumption.memoryDisposition === "publish") {
      statements.push(db.prepare(`INSERT INTO episodic_projections(
          id,namespace,conversation_id,canonical_message_id,role,occurred_at_utc,
          temporal_confidence,vector_id,vector_status,index_version,created_at,updated_at
        ) SELECT ?,?,?,?,'assistant',?,1,?,'pending','episodic-v1',?,?
        WHERE EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)
        ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace,
          conversation_id=excluded.conversation_id,canonical_message_id=excluded.canonical_message_id,
          role='assistant',vector_status='pending',vector_error_code=NULL,
          indexed_at_utc=NULL,updated_at=excluded.updated_at`)
        .bind(`ep_${candidate.id}`,candidate.namespace,candidate.conversation_id,candidate.id,
          candidate.created_at,`ep_${candidate.id}`,candidate.created_at,now,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision));
      statements.push(db.prepare(`INSERT INTO episodic_fts(projection_id,namespace,content)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(`ep_${candidate.id}`,candidate.namespace,consumption.memoryAssistantText!,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision));
    } else {
      statements.push(db.prepare(`DELETE FROM episodic_projections WHERE canonical_message_id=?
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
        AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
          WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(candidate.id,input.publicationId,input.outcomeRevision,
          input.publicationId,input.outcomeRevision));
    }
  }
  statements.push(db.prepare(`UPDATE publication_consumer_checkpoints
    SET memory_status=?,memory_applied_revision=?,updated_at=?
    WHERE publication_id=? AND outcome_revision=?
      AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
        WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
    .bind(finalMemoryStatus,input.outcomeRevision,now,
      input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision));
  await db.batch(statements);
  const [after,currentOutcome] = await Promise.all([
    readPublicationConsumerCheckpoint(db,input.publicationId),
    readPublicationOutcome(db,input.publicationId),
  ]);
  if (!currentOutcome || currentOutcome.revision !== input.outcomeRevision
    || !after || after.outcomeRevision !== input.outcomeRevision) {
    throw new Error("publication_consumer_revision_superseded");
  }
  if (after.memoryAppliedRevision !== input.outcomeRevision
    || after.memoryStatus !== finalMemoryStatus) {
    throw new Error("publication_memory_materialization_conflict");
  }
  return candidates.map((row) => ({
    id:row.id,conversationId:row.conversation_id,namespace:row.namespace,
  }));
}

export async function markPublicationMaintenanceEnqueued(
  db:D1Database,
  input:{ publicationId:string; revision:number },
):Promise<boolean> {
  const row = await db.prepare(`UPDATE publication_consumer_checkpoints
    SET maintenance_status='enqueued',updated_at=?
    WHERE publication_id=? AND outcome_revision=? AND memory_status='applied'
      AND maintenance_status='pending'
      AND EXISTS(SELECT 1 FROM publication_outcomes outcome
        WHERE outcome.publication_id=? AND outcome.revision=?)
    RETURNING publication_id`)
    .bind(nowIso(),input.publicationId,input.revision,input.publicationId,input.revision)
    .first<{publication_id:string}>();
  if (row) return true;
  const [replay,outcome] = await Promise.all([
    readPublicationConsumerCheckpoint(db,input.publicationId),
    readPublicationOutcome(db,input.publicationId),
  ]);
  return outcome?.revision === input.revision
    && replay?.outcomeRevision === input.revision
    && replay.maintenanceStatus === "enqueued";
}
