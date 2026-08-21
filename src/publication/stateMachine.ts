import type {
  NormalizedDeliveryEvidenceClass,
  PublicationAggregateSnapshot,
  PublicationConsumptionContext,
  PublicationConsumptionPlan,
  PublicationDeliveryItemSnapshot,
  PublicationOutcome,
  PublicationState,
  PublicationStateMachineEvent,
  PublicationTransitionResult,
} from "./types";

export class PublicationInvariantError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PublicationInvariantError";
  }
}

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PublicationInvariantError(code);
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function deliveryEvidenceTransitionAllowed(
  from: NormalizedDeliveryEvidenceClass,
  to: NormalizedDeliveryEvidenceClass,
): boolean {
  if (from === "pending") return ["sending", "sent", "rejected", "unknown", "skipped"].includes(to);
  if (from === "sending") return ["sent", "rejected", "unknown"].includes(to);
  if (from === "unknown") return ["sent", "rejected"].includes(to);
  return false;
}

function validateAggregate(aggregate: PublicationAggregateSnapshot): PublicationDeliveryItemSnapshot[] {
  invariant(nonEmpty(aggregate.publicationId), "publication_id_missing");
  invariant(nonEmpty(aggregate.recipientScope), "publication_recipient_scope_missing");
  invariant(nonEmpty(aggregate.inferenceRunId), "publication_inference_run_id_missing");
  invariant(aggregate.deliveryBatchIds.length > 0, "publication_delivery_batches_missing");
  invariant(new Set(aggregate.deliveryBatchIds).size === aggregate.deliveryBatchIds.length,
    "publication_delivery_batch_duplicate");
  invariant(aggregate.items.length > 0, "publication_delivery_items_missing");

  const batchIds = new Set(aggregate.deliveryBatchIds);
  const payloadRefs = new Set<string>();
  const itemIds = new Set<string>();
  const sequenceIndexes = new Set<number>();
  let requiredCount = 0;

  for (const item of aggregate.items) {
    invariant(nonEmpty(item.deliveryItemId), "publication_delivery_item_id_missing");
    invariant(nonEmpty(item.payloadRef), "publication_payload_ref_missing");
    invariant(batchIds.has(item.deliveryBatchId), "publication_delivery_item_batch_unknown");
    invariant(Number.isSafeInteger(item.sequenceIndex) && item.sequenceIndex >= 0,
      "publication_sequence_index_invalid");
    invariant(!payloadRefs.has(item.payloadRef), "publication_payload_ref_duplicate");
    invariant(!itemIds.has(item.deliveryItemId), "publication_delivery_item_id_duplicate");
    invariant(!sequenceIndexes.has(item.sequenceIndex), "publication_sequence_index_duplicate");
    payloadRefs.add(item.payloadRef);
    itemIds.add(item.deliveryItemId);
    sequenceIndexes.add(item.sequenceIndex);

    if (item.required) requiredCount += 1;
    if (item.textRole === "none") {
      invariant(item.visibleTextFragment === null, "publication_non_text_fragment_present");
    } else {
      invariant(typeof item.visibleTextFragment === "string" && nonEmpty(item.visibleTextFragment),
        "publication_visible_text_fragment_missing");
    }
    if (item.textRole === "assistant") {
      invariant(item.required, "publication_assistant_text_must_be_required");
      invariant(aggregate.purpose === "assistant_response", "publication_non_assistant_has_assistant_text");
    }
    if (item.evidenceClass !== "pending") {
      invariant(typeof item.evidenceRef === "string" && nonEmpty(item.evidenceRef),
        "publication_delivery_evidence_ref_missing");
    }
    if (item.evidenceClass === "skipped") {
      invariant(!item.required, "publication_required_item_skipped");
    }
  }
  invariant(requiredCount > 0, "publication_required_delivery_items_missing");
  return [...aggregate.items].sort((left, right) => left.sequenceIndex - right.sequenceIndex);
}

function payloadRefs(items: PublicationDeliveryItemSnapshot[], evidenceClass: NormalizedDeliveryEvidenceClass): string[] {
  return items.filter((item) => item.evidenceClass === evidenceClass).map((item) => item.payloadRef);
}

function confirmedAssistantText(items: PublicationDeliveryItemSnapshot[]): string | null {
  const fragments = items.flatMap((item) => item.evidenceClass === "sent"
    && item.textRole === "assistant"
    && item.visibleTextFragment !== null
    ? [item.visibleTextFragment]
    : []);
  return fragments.length > 0 ? fragments.join("\n\n") : null;
}

export function buildPublicationConsumptionPlan(
  state: PublicationState,
  aggregate: PublicationAggregateSnapshot,
  context: PublicationConsumptionContext,
  canonicalVisibleText: string | null,
): PublicationConsumptionPlan {
  if (state === "unknown") {
    return {
      conversation: { disposition: "hold", textSource: null, reasonCode: "publication_outcome_unknown" },
      memory: { disposition: "hold", textSource: null, reasonCode: "publication_outcome_unknown" },
    };
  }
  if (state === "rejected") {
    return {
      conversation: { disposition: "exclude", textSource: null, reasonCode: "publication_rejected" },
      memory: { disposition: "exclude", textSource: null, reasonCode: "publication_rejected" },
    };
  }
  if (aggregate.purpose !== "assistant_response") {
    return {
      conversation: { disposition: "exclude", textSource: null, reasonCode: "non_assistant_publication" },
      memory: { disposition: "exclude", textSource: null, reasonCode: "non_assistant_publication" },
    };
  }
  invariant(context.generationCompleteness !== null, "publication_generation_completeness_missing");
  if (canonicalVisibleText === null) {
    return {
      conversation: { disposition: "exclude", textSource: null, reasonCode: "assistant_visible_text_missing" },
      memory: { disposition: "exclude", textSource: null, reasonCode: "assistant_visible_text_missing" },
    };
  }
  if (context.generationCompleteness !== "complete") {
    return {
      conversation: {
        disposition: "publish",
        textSource: "canonical_visible_text",
        reasonCode: "delivered_incomplete_assistant_response",
      },
      memory: {
        disposition: "exclude",
        textSource: null,
        reasonCode: "incomplete_assistant_response_memory_excluded",
      },
    };
  }
  return {
    conversation: {
      disposition: "publish",
      textSource: "canonical_visible_text",
      reasonCode: "delivered_assistant_response",
    },
    memory: {
      disposition: "publish",
      textSource: "canonical_visible_text",
      reasonCode: "delivered_assistant_response",
    },
  };
}

function outcomeState(items: PublicationDeliveryItemSnapshot[]): PublicationState | null {
  const required = items.filter((item) => item.required);
  if (required.some((item) => item.evidenceClass === "pending" || item.evidenceClass === "sending")) return null;
  if (required.some((item) => item.evidenceClass === "unknown")) return "unknown";
  if (required.some((item) => item.evidenceClass === "rejected")) return "rejected";
  invariant(required.every((item) => item.evidenceClass === "sent"), "publication_required_evidence_invalid");
  return "delivered";
}

function reasonCode(state: PublicationState): string {
  if (state === "delivered") return "all_required_payloads_sent";
  if (state === "rejected") return "required_payload_rejected";
  return "required_payload_unknown";
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameConsumptionPlan(left: PublicationConsumptionPlan, right: PublicationConsumptionPlan): boolean {
  return left.conversation.disposition === right.conversation.disposition
    && left.conversation.textSource === right.conversation.textSource
    && left.conversation.reasonCode === right.conversation.reasonCode
    && left.memory.disposition === right.memory.disposition
    && left.memory.textSource === right.memory.textSource
    && left.memory.reasonCode === right.memory.reasonCode;
}

function sameOutcomeProjection(left: PublicationOutcome, right: PublicationOutcome): boolean {
  return left.state === right.state
    && sameStringArray(left.deliveryBatchIds, right.deliveryBatchIds)
    && sameStringArray(left.confirmedPayloadRefs, right.confirmedPayloadRefs)
    && sameStringArray(left.rejectedPayloadRefs, right.rejectedPayloadRefs)
    && sameStringArray(left.unknownPayloadRefs, right.unknownPayloadRefs)
    && sameStringArray(left.skippedPayloadRefs, right.skippedPayloadRefs)
    && left.confirmedVisibleText === right.confirmedVisibleText
    && left.canonicalVisibleText === right.canonicalVisibleText
    && left.reasonCode === right.reasonCode
    && sameConsumptionPlan(left.consumptionPlan, right.consumptionPlan);
}

function subset(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function validateCurrentIdentity(current: PublicationOutcome, aggregate: PublicationAggregateSnapshot): void {
  invariant(current.publicationId === aggregate.publicationId, "publication_current_id_mismatch");
  invariant(current.channel === aggregate.channel, "publication_current_channel_mismatch");
  invariant(current.recipientScope === aggregate.recipientScope, "publication_current_recipient_mismatch");
  invariant(current.inferenceRunId === aggregate.inferenceRunId, "publication_current_inference_run_mismatch");
  invariant(sameStringArray(current.deliveryBatchIds, aggregate.deliveryBatchIds),
    "publication_current_delivery_batches_mismatch");
  invariant(current.revision >= 1, "publication_current_revision_invalid");
  invariant(validIso(current.createdAt) && validIso(current.updatedAt),
    "publication_current_timestamp_invalid");
  invariant(current.state === "unknown" ? current.terminalAt === null : validIso(current.terminalAt ?? ""),
    "publication_current_terminal_timestamp_invalid");
  invariant(current.state !== "unknown" || current.canonicalVisibleText === null,
    "publication_unknown_canonical_text_forbidden");
}

function validateUnknownReconcile(current: PublicationOutcome, next: PublicationOutcome): void {
  invariant(current.state === "unknown", "publication_terminal_transition_forbidden");
  invariant(subset(current.confirmedPayloadRefs, next.confirmedPayloadRefs),
    "publication_confirmed_evidence_regression");
  invariant(subset(current.rejectedPayloadRefs, next.rejectedPayloadRefs),
    "publication_rejected_evidence_regression");
  invariant(subset(current.skippedPayloadRefs, next.skippedPayloadRefs),
    "publication_skipped_evidence_regression");
  const nextResolved = new Set([
    ...next.confirmedPayloadRefs,
    ...next.rejectedPayloadRefs,
    ...next.unknownPayloadRefs,
    ...next.skippedPayloadRefs,
  ]);
  invariant(current.unknownPayloadRefs.every((value) => nextResolved.has(value)),
    "publication_unknown_evidence_disappeared");

  const stronger = current.state !== next.state
    || !sameStringArray(current.confirmedPayloadRefs, next.confirmedPayloadRefs)
    || !sameStringArray(current.rejectedPayloadRefs, next.rejectedPayloadRefs)
    || !sameStringArray(current.unknownPayloadRefs, next.unknownPayloadRefs)
    || !sameStringArray(current.skippedPayloadRefs, next.skippedPayloadRefs);
  invariant(stronger, "publication_reconcile_evidence_not_stronger");
}

export function transitionPublicationOutcome(
  current: PublicationOutcome | null,
  event: PublicationStateMachineEvent,
): PublicationTransitionResult {
  invariant(event.kind === "normalized_delivery_projection", "publication_event_kind_invalid");
  invariant(validIso(event.observedAt), "publication_observed_at_invalid");
  const items = validateAggregate(event.aggregate);
  if (current) validateCurrentIdentity(current, event.aggregate);

  if (!event.aggregate.requiredSequenceClosed) {
    invariant(current === null, "publication_outcome_regressed_to_not_ready");
    return { kind: "not_ready", reasonCode: "required_sequence_open", outcome: null, effects: [] };
  }

  const state = outcomeState(items);
  if (state === null) {
    invariant(current === null, "publication_outcome_regressed_to_not_ready");
    return { kind: "not_ready", reasonCode: "required_delivery_pending", outcome: null, effects: [] };
  }

  const confirmedVisibleText = confirmedAssistantText(items);
  const canonicalVisibleText = state === "unknown" ? null : confirmedVisibleText;
  const candidate: PublicationOutcome = {
    publicationId: event.aggregate.publicationId,
    channel: event.aggregate.channel,
    recipientScope: event.aggregate.recipientScope,
    inferenceRunId: event.aggregate.inferenceRunId,
    deliveryBatchIds: [...event.aggregate.deliveryBatchIds],
    state,
    confirmedPayloadRefs: payloadRefs(items, "sent"),
    rejectedPayloadRefs: payloadRefs(items, "rejected"),
    unknownPayloadRefs: payloadRefs(items, "unknown"),
    skippedPayloadRefs: payloadRefs(items, "skipped"),
    confirmedVisibleText,
    canonicalVisibleText,
    consumptionPlan: buildPublicationConsumptionPlan(
      state,
      event.aggregate,
      event.consumptionContext,
      canonicalVisibleText,
    ),
    reasonCode: reasonCode(state),
    revision: (current?.revision ?? 0) + 1,
    createdAt: current?.createdAt ?? event.observedAt,
    updatedAt: event.observedAt,
    terminalAt: state === "unknown" ? null : event.observedAt,
  };

  if (current && sameOutcomeProjection(current, candidate)) {
    return { kind: "noop", outcome: current, effects: [] };
  }
  if (current) validateUnknownReconcile(current, candidate);

  const expectedRevision = current?.revision ?? 0;
  return {
    kind: "transition",
    expectedRevision,
    outcome: candidate,
    effects: [{ kind: "persist_publication_outcome", publicationId: candidate.publicationId, expectedRevision }],
  };
}
