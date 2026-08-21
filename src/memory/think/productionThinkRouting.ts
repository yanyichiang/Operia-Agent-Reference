export type ProductionThinkRouteReason =
  | "flags_disabled"
  | "bindings_missing"
  | "owner_scope_unresolved"
  | "owner_recipient_mismatch"
  | "idempotency_missing"
  | "transport_out_of_scope"
  | "internal_ephemeral"
  | "legacy_continuation"
  | "streaming_not_supported"
  | "image_not_supported";

export type ProductionThinkRouteInput = {
  flagsEnabled: boolean;
  bindingsReady: boolean;
  ownerId: string;
  requestedRecipient: string;
  requestedIdempotencyKey: string;
  trustedPrivateTelegramRequest: boolean;
  qaRoomRequest: boolean;
  internalEphemeral: boolean;
  continuation: boolean;
  stream: boolean;
  hasImage: boolean;
};

export type ProductionThinkRouteDecision = {
  eligible: boolean;
  scopeKind: "private" | "qa_room" | null;
  reasons: ProductionThinkRouteReason[];
};

export function evaluateProductionThinkRoute(input: ProductionThinkRouteInput): ProductionThinkRouteDecision {
  const reasons: ProductionThinkRouteReason[] = [];
  const scopeKind = input.qaRoomRequest
    ? "qa_room" as const
    : input.trustedPrivateTelegramRequest
      ? "private" as const
      : null;

  if (!input.flagsEnabled) reasons.push("flags_disabled");
  if (!input.bindingsReady) reasons.push("bindings_missing");
  if (!input.ownerId || !input.requestedRecipient) reasons.push("owner_scope_unresolved");
  if (scopeKind === "private" && input.ownerId && input.requestedRecipient !== input.ownerId) {
    reasons.push("owner_recipient_mismatch");
  }
  if (!input.requestedIdempotencyKey) reasons.push("idempotency_missing");
  if (!scopeKind) reasons.push("transport_out_of_scope");
  if (input.internalEphemeral) reasons.push("internal_ephemeral");
  if (input.continuation) reasons.push("legacy_continuation");
  if (input.stream) reasons.push("streaming_not_supported");
  if (input.hasImage) reasons.push("image_not_supported");

  return { eligible: reasons.length === 0, scopeKind, reasons };
}

export function qualifiesNaturalThinkToolTask(input: {
  naturalSource: boolean;
  status: string;
  toolCalls: number;
  toolErrors: ReadonlyArray<string>;
  externalWrites: number;
  replay: boolean;
  continuation: boolean;
  synthetic: boolean;
  pendingApprovals?: number;
}): boolean {
  return input.naturalSource
    && input.status === "completed"
    && input.toolCalls > 0
    && input.toolErrors.length === 0
    && input.externalWrites === 0
    && !input.replay
    && !input.continuation
    && !input.synthetic
    && (input.pendingApprovals ?? 0) === 0;
}
