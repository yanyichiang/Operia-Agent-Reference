import type { Env } from "../types";
import { nowIso } from "../utils/time";
import { planPublicationAssistantConsumption } from "../publication/consumer";
import { readPublicationOutcome } from "../publication/repository";
import {
  classifyAppliedConversationEventParts,
  readConversationEventPartMaterialization,
} from "./conversationEventParts";
import {
  assignRecentCacheEpochIds,
  parseRecentTurns,
  type ConversationRecentTurn,
  type ConversationState,
} from "./conversationFreshness";

export type PublicationConversationCommand = {
  publicationId:string;
  outcomeRevision:number;
  recipientScope:string;
  conversationEventId:string;
  userText:string;
  userOccurredAtUtc:string|null;
  assistantOccurredAtUtc:string|null;
};

export type PublicationConversationMaterializationResult = {
  duplicate:boolean;
  sourceApplied:boolean;
  assistantApplied:boolean;
  disposition:"publish"|"exclude"|"hold";
  state:ConversationState;
};

type MaterializationRow = {
  publication_id:string;
  conversation_event_id:string;
  recipient_scope:string;
  source_applied:number;
  assistant_applied:number;
  last_outcome_revision:number;
  terminal_disposition:"publish"|"exclude"|null;
  legacy_event_replayed:number;
  state_revision_after:number|null;
};

function validIso(value:string|null):string|null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readState(db:D1Database,recipientScope:string):Promise<ConversationState> {
  const row = await db.prepare(`SELECT state.summary,state.recent_json,state.updated_at,
      freshness.state_revision,freshness.summary_manifest_json
    FROM tg_chat_state state
    LEFT JOIN tg_chat_state_freshness freshness ON freshness.chat_id=state.chat_id
    WHERE state.chat_id=?`).bind(recipientScope).first<{
      summary:string;recent_json:string;updated_at:string;
      state_revision:number|null;summary_manifest_json:string|null;
    }>();
  if (!row) return {summary:"",recent:[],updatedAt:null};
  return {
    summary:row.summary || "",
    recent:parseRecentTurns(JSON.parse(row.recent_json)),
    stateRevision:row.state_revision ?? 0,
    updatedAt:row.updated_at,
  };
}

async function readMaterialization(
  db:D1Database,
  publicationId:string,
):Promise<MaterializationRow|null> {
  return db.prepare(`SELECT publication_id,conversation_event_id,recipient_scope,
      source_applied,assistant_applied,last_outcome_revision,terminal_disposition,legacy_event_replayed,
      state_revision_after
    FROM publication_conversation_materializations WHERE publication_id=?`)
    .bind(publicationId).first<MaterializationRow>();
}

function assertCommand(input:PublicationConversationCommand):void {
  if (!input.publicationId.trim() || !input.conversationEventId.trim()
    || !input.recipientScope.trim() || !input.userText.length
    || !Number.isSafeInteger(input.outcomeRevision) || input.outcomeRevision < 1) {
    throw new Error("publication_conversation_command_invalid");
  }
  if ((input.userOccurredAtUtc && !validIso(input.userOccurredAtUtc))
    || (input.assistantOccurredAtUtc && !validIso(input.assistantOccurredAtUtc))) {
    throw new Error("publication_conversation_occurrence_time_invalid");
  }
}

async function verifyRegisteredCheckpoint(
  db:D1Database,
  input:PublicationConversationCommand,
  disposition:"publish"|"exclude"|"hold",
):Promise<void> {
  const row = await db.prepare(`SELECT publication_id FROM publication_consumer_checkpoints
    WHERE publication_id=? AND recipient_scope=? AND conversation_event_id=?
      AND outcome_revision=? AND conversation_disposition=?`)
    .bind(input.publicationId,input.recipientScope,input.conversationEventId,
      input.outcomeRevision,disposition).first<{publication_id:string}>();
  if (!row) throw new Error("publication_conversation_checkpoint_mismatch");
}

function desiredApplied(disposition:"publish"|"exclude"|"hold"):{
  source:boolean;assistant:boolean;terminal:"publish"|"exclude"|null;
} {
  return {
    source:true,
    assistant:disposition === "publish",
    terminal:disposition === "hold" ? null : disposition,
  };
}

/**
 * Memory-owned Conversation projection. The source half is independent from
 * assistant disposition; hold leaves the batch event revisable for a stronger
 * PublicationOutcome revision.
 */
export async function applyPublicationConversation(
  env:Pick<Env,"DB"|"CONVERSATION_FRESHNESS_V2_ENABLED">,
  input:PublicationConversationCommand,
):Promise<PublicationConversationMaterializationResult> {
  assertCommand(input);
  const outcome = await readPublicationOutcome(env.DB,input.publicationId);
  if (!outcome || outcome.revision !== input.outcomeRevision) {
    throw new Error("publication_conversation_revision_superseded");
  }
  if (outcome.recipientScope !== input.recipientScope) {
    throw new Error("publication_conversation_outcome_scope_conflict");
  }
  const consumption = planPublicationAssistantConsumption(outcome);
  const disposition = consumption.conversationDisposition;
  const assistantText = consumption.conversationAssistantText;
  await verifyRegisteredCheckpoint(env.DB,input,disposition);
  const priorEvent = await env.DB.prepare(`SELECT applied,recipient_id FROM conversation_turn_events
    WHERE event_id=?`).bind(input.conversationEventId).first<{applied:number;recipient_id:string}>();
  if (priorEvent && priorEvent.recipient_id !== input.recipientScope) {
    throw new Error("publication_conversation_event_recipient_conflict");
  }
  const now = nowIso();
  let existing = await readMaterialization(env.DB,input.publicationId);
  if (existing && (existing.conversation_event_id !== input.conversationEventId
    || existing.recipient_scope !== input.recipientScope)) {
    throw new Error("publication_conversation_materialization_identity_conflict");
  }

  // A mixed-rollout legacy event already owns batch:<batchKey>. Replaying it
  // never invents a second Conversation event. A ledger-proven user-only event
  // remains revisable: a stronger Outcome may append only its assistant half.
  if (!existing && priorEvent?.applied === 1) {
    const legacyState = await readState(env.DB,input.recipientScope);
    const classification = await classifyAppliedConversationEventParts(env.DB,{
      eventId:input.conversationEventId,recipientScope:input.recipientScope,
    });
    if (classification.kind === "ambiguous") {
      throw new Error("publication_conversation_legacy_parts_ambiguous");
    }
    if (classification.kind !== "exact") {
      throw new Error("publication_conversation_legacy_parts_missing");
    }
    const parts = {
      source:classification.materialization.sourceApplied,
      assistant:classification.materialization.assistantApplied,
    };
    const fullyApplied = parts.assistant || disposition !== "publish";
    await env.DB.prepare(`INSERT INTO publication_conversation_materializations(
        publication_id,conversation_event_id,recipient_scope,source_applied,assistant_applied,
        last_outcome_revision,terminal_disposition,legacy_event_replayed,state_revision_after,created_at,updated_at
      ) SELECT ?,?,?,?,?,?,?,?,?,?,?
      FROM publication_outcomes current_outcome
      WHERE current_outcome.publication_id=? AND current_outcome.revision=?
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
      ON CONFLICT(publication_id) DO NOTHING`)
      .bind(input.publicationId,input.conversationEventId,input.recipientScope,parts.source?1:0,
        parts.assistant?1:0,fullyApplied?input.outcomeRevision:0,
        fullyApplied && disposition!=="hold" ? disposition : null,1,
        fullyApplied ? legacyState.stateRevision ?? 0 : null,now,now,
        input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision).run();
    existing = await readMaterialization(env.DB,input.publicationId);
    if (!existing) {
      const current = await readPublicationOutcome(env.DB,input.publicationId);
      throw new Error(current?.revision === input.outcomeRevision
        ? "publication_conversation_legacy_replay_missing"
        : "publication_conversation_revision_superseded");
    }
    if (fullyApplied) return {
      duplicate:true,sourceApplied:existing.source_applied===1,
      assistantApplied:existing.assistant_applied===1,disposition,state:legacyState,
    };
  }

  const freshnessEnabled = env.CONVERSATION_FRESHNESS_V2_ENABLED === "true";
  const setup:D1PreparedStatement[] = [
    env.DB.prepare(`INSERT OR IGNORE INTO tg_chat_state(chat_id,summary,recent_json,updated_at)
      VALUES(?,'','[]',?)`).bind(input.recipientScope,now),
    env.DB.prepare(`INSERT OR IGNORE INTO conversation_turn_events(
      event_id,channel,recipient_id,applied,created_at) VALUES(?,'telegram',?,0,?)`)
      .bind(input.conversationEventId,input.recipientScope,now),
    env.DB.prepare(`INSERT INTO publication_conversation_materializations(
        publication_id,conversation_event_id,recipient_scope,source_applied,assistant_applied,
        last_outcome_revision,terminal_disposition,legacy_event_replayed,state_revision_after,created_at,updated_at
      ) SELECT ?,?,?,0,0,0,NULL,0,NULL,?,?
      FROM publication_outcomes current_outcome
      WHERE current_outcome.publication_id=? AND current_outcome.revision=?
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
      ON CONFLICT(publication_id) DO NOTHING`)
      .bind(input.publicationId,input.conversationEventId,input.recipientScope,now,now,
        input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision),
  ];
  if (freshnessEnabled) {
    setup.push(env.DB.prepare(`INSERT OR IGNORE INTO tg_chat_state_freshness(
      chat_id,v2_started_at_utc,updated_at) VALUES(?,?,?)`).bind(input.recipientScope,now,now));
  }
  await env.DB.batch(setup);
  existing = await readMaterialization(env.DB,input.publicationId);
  if (!existing || existing.conversation_event_id !== input.conversationEventId
    || existing.recipient_scope !== input.recipientScope) {
    const current = await readPublicationOutcome(env.DB,input.publicationId);
    if (!current || current.revision !== input.outcomeRevision) {
      throw new Error("publication_conversation_revision_superseded");
    }
    throw new Error("publication_conversation_materialization_identity_conflict");
  }
  if (existing.last_outcome_revision > input.outcomeRevision) {
    return {
      duplicate:true,sourceApplied:existing.source_applied===1,
      assistantApplied:existing.assistant_applied===1,disposition,
      state:await readState(env.DB,input.recipientScope),
    };
  }

  if (existing.last_outcome_revision === input.outcomeRevision
    && existing.state_revision_after !== null) {
    const replayState = await readState(env.DB,input.recipientScope);
    if ((replayState.stateRevision ?? 0) >= existing.state_revision_after) {
      return {
        duplicate:true,sourceApplied:existing.source_applied===1,
        assistantApplied:existing.assistant_applied===1,disposition,state:replayState,
      };
    }
  }

  const desired = desiredApplied(disposition);
  const addSource = existing.source_applied === 0;
  const addAssistant = desired.assistant && existing.assistant_applied === 0;
  const before = await readState(env.DB,input.recipientScope);
  const observedAt = nowIso();
  const newTurns:ConversationRecentTurn[] = [];
  if (addSource) {
    const occurredAtUtc = validIso(input.userOccurredAtUtc);
    newTurns.push(freshnessEnabled ? {
      version:2,eventId:`${input.conversationEventId}:owner`,role:"user",content:input.userText,
      occurredAtUtc,observedAtUtc:observedAt,temporalConfidence:occurredAtUtc ? "exact" : "unknown",
    } : {role:"user",content:input.userText});
  }
  if (addAssistant) {
    const occurredAtUtc = validIso(input.assistantOccurredAtUtc);
    newTurns.push(freshnessEnabled ? {
      version:2,eventId:`${input.conversationEventId}:assistant`,role:"assistant",
      content:assistantText!,occurredAtUtc,observedAtUtc:observedAt,
      temporalConfidence:occurredAtUtc ? "exact" : "unknown",
    } : {role:"assistant",content:assistantText!});
  }

  if (newTurns.length === 0) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE publication_conversation_materializations SET
          last_outcome_revision=?,terminal_disposition=COALESCE(terminal_disposition,?),
          state_revision_after=COALESCE(state_revision_after,?),updated_at=?
        WHERE publication_id=? AND last_outcome_revision<=?
          AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
            WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(input.outcomeRevision,desired.terminal,before.stateRevision ?? 0,observedAt,
          input.publicationId,input.outcomeRevision,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision),
      env.DB.prepare(`UPDATE conversation_turn_events SET applied=1,applied_at=?
        WHERE event_id=? AND applied=0 AND ? IS NOT NULL
          AND EXISTS(SELECT 1 FROM publication_conversation_materializations materialization
            WHERE materialization.publication_id=? AND materialization.last_outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
            WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(observedAt,input.conversationEventId,desired.terminal,input.publicationId,input.outcomeRevision,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision),
    ]);
  } else {
    const appended = assignRecentCacheEpochIds([...before.recent,...newTurns]);
    const expectedRevision = before.stateRevision ?? 0;
    const statePredicate = freshnessEnabled
      ? " AND EXISTS(SELECT 1 FROM tg_chat_state_freshness WHERE chat_id=? AND state_revision=?)"
      : "";
    const statements:D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE tg_chat_state SET recent_json=?,updated_at=? WHERE chat_id=?${statePredicate}
        AND EXISTS(SELECT 1 FROM publication_conversation_materializations materialization
          WHERE materialization.publication_id=? AND materialization.source_applied=?
            AND materialization.assistant_applied=? AND materialization.last_outcome_revision<=?)
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
        AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
          WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(...(freshnessEnabled
          ? [JSON.stringify(appended),observedAt,input.recipientScope,input.recipientScope,expectedRevision,
              input.publicationId,existing.source_applied,existing.assistant_applied,input.outcomeRevision,
              input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision]
          : [JSON.stringify(appended),observedAt,input.recipientScope,input.publicationId,
              existing.source_applied,existing.assistant_applied,input.outcomeRevision,
              input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision])),
    ];
    if (freshnessEnabled) {
      statements.push(env.DB.prepare(`UPDATE tg_chat_state_freshness
        SET state_revision=state_revision+1,updated_at=? WHERE chat_id=? AND state_revision=?
          AND EXISTS(SELECT 1 FROM publication_conversation_materializations materialization
            WHERE materialization.publication_id=? AND materialization.source_applied=?
              AND materialization.assistant_applied=? AND materialization.last_outcome_revision<=?)
          AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
            WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(observedAt,input.recipientScope,expectedRevision,input.publicationId,
          existing.source_applied,existing.assistant_applied,input.outcomeRevision,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision));
    }
    const revisionPredicate = freshnessEnabled
      ? ` AND EXISTS(SELECT 1 FROM tg_chat_state_freshness
          WHERE chat_id=? AND state_revision=?)` : "";
    statements.push(env.DB.prepare(`UPDATE publication_conversation_materializations SET
        source_applied=CASE WHEN ?=1 THEN 1 ELSE source_applied END,
        assistant_applied=CASE WHEN ?=1 THEN 1 ELSE assistant_applied END,
        last_outcome_revision=?,terminal_disposition=COALESCE(terminal_disposition,?),
        state_revision_after=?,updated_at=?
      WHERE publication_id=? AND source_applied=? AND assistant_applied=?
        AND last_outcome_revision<=?${revisionPredicate}
        AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
          WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
        AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
          WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
      .bind(...(freshnessEnabled
        ? [desired.source?1:0,desired.assistant?1:0,input.outcomeRevision,desired.terminal,
            expectedRevision+1,observedAt,
            input.publicationId,existing.source_applied,existing.assistant_applied,input.outcomeRevision,
            input.recipientScope,expectedRevision+1,input.publicationId,input.outcomeRevision,
            input.publicationId,input.outcomeRevision]
        : [desired.source?1:0,desired.assistant?1:0,input.outcomeRevision,desired.terminal,
            expectedRevision,observedAt,
            input.publicationId,existing.source_applied,existing.assistant_applied,input.outcomeRevision,
            input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision])));
    if (desired.terminal) {
      statements.push(env.DB.prepare(`UPDATE conversation_turn_events SET applied=1,applied_at=?
        WHERE event_id=? AND applied=0
          AND EXISTS(SELECT 1 FROM publication_conversation_materializations materialization
            WHERE materialization.publication_id=? AND materialization.last_outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_consumer_checkpoints checkpoint
            WHERE checkpoint.publication_id=? AND checkpoint.outcome_revision=?)
          AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
            WHERE current_outcome.publication_id=? AND current_outcome.revision=?)`)
        .bind(observedAt,input.conversationEventId,input.publicationId,input.outcomeRevision,
          input.publicationId,input.outcomeRevision,input.publicationId,input.outcomeRevision));
    }
    statements.push(env.DB.prepare(`INSERT INTO conversation_event_part_materializations(
        event_id,source_applied,assistant_applied,provenance,created_at,updated_at)
      SELECT ?,1,?,'publication_consumer',?,?
      WHERE EXISTS(SELECT 1 FROM publication_conversation_materializations materialization
        WHERE materialization.publication_id=? AND materialization.last_outcome_revision=?
          AND materialization.source_applied=1 AND materialization.assistant_applied=?)
        AND EXISTS(SELECT 1 FROM publication_outcomes current_outcome
          WHERE current_outcome.publication_id=? AND current_outcome.revision=?)
      ON CONFLICT(event_id) DO UPDATE SET
        source_applied=MAX(conversation_event_part_materializations.source_applied,excluded.source_applied),
        assistant_applied=MAX(conversation_event_part_materializations.assistant_applied,excluded.assistant_applied),
        provenance=CASE
          WHEN conversation_event_part_materializations.provenance='legacy_append'
            AND conversation_event_part_materializations.assistant_applied=0
            AND excluded.assistant_applied=1 THEN 'mixed_rollout'
          ELSE conversation_event_part_materializations.provenance END,
        updated_at=excluded.updated_at
      WHERE conversation_event_part_materializations.provenance<>'historical_ambiguous'`)
      .bind(input.conversationEventId,desired.assistant?1:0,observedAt,observedAt,
        input.publicationId,input.outcomeRevision,desired.assistant?1:0,
        input.publicationId,input.outcomeRevision));
    await env.DB.batch(statements);
  }

  const [afterMaterialization,currentOutcome,afterParts] = await Promise.all([
    readMaterialization(env.DB,input.publicationId),
    readPublicationOutcome(env.DB,input.publicationId),
    readConversationEventPartMaterialization(env.DB,input.conversationEventId),
  ]);
  if (!currentOutcome || currentOutcome.revision !== input.outcomeRevision) {
    throw new Error("publication_conversation_revision_superseded");
  }
  if (!afterMaterialization
    || afterMaterialization.last_outcome_revision < input.outcomeRevision
    || afterMaterialization.source_applied !== 1
    || (desired.assistant && afterMaterialization.assistant_applied !== 1)
    || (desired.terminal && afterMaterialization.terminal_disposition !== desired.terminal)) {
    throw new Error("publication_conversation_revision_conflict");
  }
  if (!afterParts || afterParts.provenance === "historical_ambiguous"
    || afterParts.sourceApplied !== true
    || (desired.assistant && afterParts.assistantApplied !== true)) {
    throw new Error("publication_conversation_part_materialization_conflict");
  }
  return {
    duplicate:newTurns.length === 0,
    sourceApplied:afterMaterialization.source_applied===1,
    assistantApplied:afterMaterialization.assistant_applied===1,
    disposition,
    state:await readState(env.DB,input.recipientScope),
  };
}
