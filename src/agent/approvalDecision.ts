export type ApprovalDecision = "approved" | "rejected";

export type ApprovalDecisionResult =
  | { kind: "first"; status: ApprovalDecision }
  | { kind: "replay"; status: ApprovalDecision }
  | { kind: "conflict"; status: string }
  | { kind: "missing" };

/**
 * Resolve what an approval decision endpoint should report after the conditional
 * UPDATE has run. The database `status` is the only authority; `decision_json`
 * is supplementary detail and must not be parsed to decide replay/conflict.
 */
export function resolveApprovalDecision(
  requestedDecision: ApprovalDecision,
  updatedStatus: string | undefined,
  existingStatus: string | undefined,
): ApprovalDecisionResult {
  if (updatedStatus === "approved" || updatedStatus === "rejected") {
    return { kind: "first", status: updatedStatus };
  }
  if (!existingStatus) return { kind: "missing" };
  if (existingStatus === requestedDecision) {
    return { kind: "replay", status: existingStatus as ApprovalDecision };
  }
  return { kind: "conflict", status: existingStatus };
}
