import {
  commitPublicationOutcome,
  readPublicationAggregateSnapshot,
  readPublicationOutcome,
} from "./repository";
import { transitionPublicationOutcome } from "./stateMachine";
import type {
  PublicationConsumptionContext,
  PublicationOutcome,
} from "./types";

export type PublicationProjectionResult =
  | { kind:"not_ready"; reasonCode:"required_sequence_open" | "required_delivery_pending" }
  | { kind:"noop"; outcome:PublicationOutcome }
  | { kind:"projected"; outcome:PublicationOutcome; replayed:boolean };

/**
 * The only runtime module allowed to persist PublicationOutcome. Delivery and
 * shadow callers provide facts, then ask this projector to derive the current
 * aggregate result through the pure Gate-A state machine.
 */
export async function projectPublicationOutcome(
  db: D1Database,
  input: {
    publicationId:string;
    consumptionContext:PublicationConsumptionContext;
    observedAt:string;
  },
): Promise<PublicationProjectionResult> {
  const aggregate = await readPublicationAggregateSnapshot(db,input.publicationId);
  if (!aggregate) throw new Error("publication_projector_aggregate_missing");
  const current = await readPublicationOutcome(db,input.publicationId);
  const transition = transitionPublicationOutcome(current,{
    kind:"normalized_delivery_projection",
    aggregate,
    consumptionContext:input.consumptionContext,
    observedAt:input.observedAt,
  });
  if (transition.kind === "not_ready") {
    return {kind:"not_ready",reasonCode:transition.reasonCode};
  }
  if (transition.kind === "noop") return {kind:"noop",outcome:transition.outcome};
  const persisted = await commitPublicationOutcome(
    db,transition.outcome,transition.expectedRevision,
  );
  return {kind:"projected",outcome:persisted.outcome,replayed:persisted.replayed};
}
