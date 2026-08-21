import { nowIso } from "../utils/time";

export type ConversationEventPartProvenance =
  | "legacy_append"
  | "publication_consumer"
  | "mixed_rollout"
  | "historical_ambiguous";

export type ConversationEventPartMaterialization = {
  eventId:string;
  sourceApplied:boolean|null;
  assistantApplied:boolean|null;
  provenance:ConversationEventPartProvenance;
};

export type AppliedConversationEventPartClassification =
  | {kind:"not_applied"}
  | {kind:"exact";materialization:ConversationEventPartMaterialization & {
      sourceApplied:boolean;assistantApplied:boolean;
    }}
  | {kind:"ambiguous";materialization:ConversationEventPartMaterialization & {
      sourceApplied:null;assistantApplied:null;provenance:"historical_ambiguous";
    }};

type PartRow = {
  event_id:string;
  source_applied:number|null;
  assistant_applied:number|null;
  provenance:ConversationEventPartProvenance;
};

function fromRow(row:PartRow):ConversationEventPartMaterialization {
  return {
    eventId:row.event_id,
    sourceApplied:row.source_applied === null ? null : row.source_applied === 1,
    assistantApplied:row.assistant_applied === null ? null : row.assistant_applied === 1,
    provenance:row.provenance,
  };
}

export async function readConversationEventPartMaterialization(
  db:D1Database,
  eventId:string,
):Promise<ConversationEventPartMaterialization|null> {
  const row = await db.prepare(`SELECT event_id,source_applied,assistant_applied,provenance
    FROM conversation_event_part_materializations WHERE event_id=?`)
    .bind(eventId).first<PartRow>();
  return row ? fromRow(row) : null;
}

/**
 * Classify only durable evidence. An applied pre-ledger event is permanently
 * marked ambiguous; current recent/summary content is never used to infer a
 * missing assistant half.
 */
export async function classifyAppliedConversationEventParts(
  db:D1Database,
  input:{eventId:string;recipientScope:string},
):Promise<AppliedConversationEventPartClassification> {
  const event = await db.prepare(`SELECT applied,recipient_id FROM conversation_turn_events
    WHERE event_id=?`).bind(input.eventId).first<{applied:number;recipient_id:string}>();
  if (!event || event.applied !== 1) return {kind:"not_applied"};
  if (event.recipient_id !== input.recipientScope) {
    throw new Error("conversation_event_parts_recipient_conflict");
  }

  let materialization = await readConversationEventPartMaterialization(db,input.eventId);
  if (!materialization) {
    const now = nowIso();
    await db.prepare(`INSERT INTO conversation_event_part_materializations(
        event_id,source_applied,assistant_applied,provenance,created_at,updated_at)
      SELECT ?,NULL,NULL,'historical_ambiguous',?,?
      WHERE EXISTS(SELECT 1 FROM conversation_turn_events event
        WHERE event.event_id=? AND event.recipient_id=? AND event.applied=1)
      ON CONFLICT(event_id) DO NOTHING`)
      .bind(input.eventId,now,now,input.eventId,input.recipientScope).run();
    materialization = await readConversationEventPartMaterialization(db,input.eventId);
  }
  if (!materialization) throw new Error("conversation_event_parts_classification_missing");
  if (materialization.provenance === "historical_ambiguous") {
    return {kind:"ambiguous",materialization:{
      ...materialization,sourceApplied:null,assistantApplied:null,
      provenance:"historical_ambiguous",
    }};
  }
  if (materialization.sourceApplied === null || materialization.assistantApplied === null) {
    throw new Error("conversation_event_parts_exact_state_invalid");
  }
  return {kind:"exact",materialization:{
    ...materialization,
    sourceApplied:materialization.sourceApplied,
    assistantApplied:materialization.assistantApplied,
  }};
}
