export type PublicationChannel = "telegram";

export type PublicationState = "delivered" | "rejected" | "unknown";

/**
 * Transport adapters normalize provider-specific results into this vocabulary
 * before the Publication state machine sees them. Raw Telegram errors are not
 * part of the Publication contract.
 */
export type NormalizedDeliveryEvidenceClass =
  | "pending"
  | "sending"
  | "sent"
  | "rejected"
  | "unknown"
  | "skipped";

export type PublicationPurpose = "assistant_response" | "non_assistant";

/** Only assistant text and captions contribute to conversation text. */
export type PublicationTextRole = "assistant" | "system" | "none";

/** This remains an InferenceRun fact and is never a PublicationState. */
export type InferenceRunCompleteness = "complete" | "partial" | "failed" | "attention";

export type PublicationConsumerDisposition = "publish" | "exclude" | "hold";
export type PublicationConsumerTextSource = "canonical_visible_text" | null;

export type PublicationConsumerPlan = {
  disposition: PublicationConsumerDisposition;
  textSource: PublicationConsumerTextSource;
  reasonCode: string;
};

/**
 * Consumer policy is centralized without forcing Conversation and Memory to
 * make the same decision. In particular, a visibly delivered incomplete
 * response may be appended to Conversation while remaining excluded from
 * Memory.
 */
export type PublicationConsumptionPlan = {
  conversation: PublicationConsumerPlan;
  memory: PublicationConsumerPlan;
};

export type PublicationDeliveryItemSnapshot = {
  deliveryItemId: string;
  payloadRef: string;
  deliveryBatchId: string;
  sequenceIndex: number;
  required: boolean;
  evidenceClass: NormalizedDeliveryEvidenceClass;
  evidenceRef: string | null;
  textRole: PublicationTextRole;
  visibleTextFragment: string | null;
};

export type PublicationAggregateSnapshot = {
  publicationId: string;
  channel: PublicationChannel;
  recipientScope: string;
  inferenceRunId: string;
  purpose: PublicationPurpose;
  /** Ordered batch ids; one logical publication may span several batches. */
  deliveryBatchIds: string[];
  requiredSequenceClosed: boolean;
  items: PublicationDeliveryItemSnapshot[];
};

export type PublicationConsumptionContext = {
  /** Read from InferenceRun by a future caller; not stored as delivery state. */
  generationCompleteness: InferenceRunCompleteness | null;
};

export type PublicationOutcome = {
  publicationId: string;
  channel: PublicationChannel;
  recipientScope: string;
  inferenceRunId: string;
  deliveryBatchIds: string[];
  state: PublicationState;
  confirmedPayloadRefs: string[];
  rejectedPayloadRefs: string[];
  unknownPayloadRefs: string[];
  skippedPayloadRefs: string[];
  /** Confirmed assistant text/caption fragments, even while outcome is unknown. */
  confirmedVisibleText: string | null;
  /** Null while any required publication effect remains outcome-unknown. */
  canonicalVisibleText: string | null;
  consumptionPlan: PublicationConsumptionPlan;
  reasonCode: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Null until the authority reaches delivered or rejected. */
  terminalAt: string | null;
};

export type PublicationStateMachineEvent = {
  kind: "normalized_delivery_projection";
  aggregate: PublicationAggregateSnapshot;
  consumptionContext: PublicationConsumptionContext;
  observedAt: string;
};

export type PublicationTransitionResult =
  | {
      kind: "not_ready";
      reasonCode: "required_sequence_open" | "required_delivery_pending";
      outcome: PublicationOutcome | null;
      effects: [];
    }
  | {
      kind: "noop";
      outcome: PublicationOutcome;
      effects: [];
    }
  | {
      kind: "transition";
      expectedRevision: number;
      outcome: PublicationOutcome;
      effects: [{ kind: "persist_publication_outcome"; publicationId: string; expectedRevision: number }];
    };

export type PublicationStageBatch = {
  deliveryBatchId: string;
  batchOrder: number;
};

export type PublicationStageItem = {
  deliveryItemId: string;
  payloadRef: string;
  intentKey: string;
  deliveryBatchId: string;
  sequenceIndex: number;
  required: boolean;
  textRole: PublicationTextRole;
  visibleTextFragment: string | null;
};

export type StagePublicationInput = {
  publicationId: string;
  channel: PublicationChannel;
  recipientScope: string;
  inferenceRunId: string;
  purpose: PublicationPurpose;
  batches: PublicationStageBatch[];
  items: PublicationStageItem[];
  /** Insert timestamp for newly staged rows; replay identity excludes retry time. */
  createdAt: string;
};

export type RecordPublicationEvidenceInput = {
  publicationId: string;
  deliveryItemId: string;
  evidenceRef: string;
  evidenceClass: Exclude<NormalizedDeliveryEvidenceClass, "pending">;
  expectedEvidenceRevision: number;
  observedAt: string;
};
