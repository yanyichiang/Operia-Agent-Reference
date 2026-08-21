import { ControlPlaneCoreError } from "./errors";

export type RevisionCasDecision =
  | { ok: true; currentRevision: number; nextRevision: number }
  | { ok: false; code: "missing_revision" | "invalid_revision" | "revision_conflict"; currentRevision: number };

export function parseIfMatchRevision(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return validRevision(value) ? value : Number.NaN;
  const normalized = value.trim();
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(normalized);
  return match ? Number(match[1]) : Number.NaN;
}

export function decideRevisionCas(currentRevision: number, ifMatch: string | number | null | undefined): RevisionCasDecision {
  if (!validRevision(currentRevision)) throw new ControlPlaneCoreError("invalid_revision", "current_revision");
  const expected = parseIfMatchRevision(ifMatch);
  if (expected === null) return { ok: false, code: "missing_revision", currentRevision };
  if (!validRevision(expected)) return { ok: false, code: "invalid_revision", currentRevision };
  if (expected !== currentRevision) return { ok: false, code: "revision_conflict", currentRevision };
  return { ok: true, currentRevision, nextRevision: currentRevision + 1 };
}

export function assertRevisionCas(currentRevision: number, ifMatch: string | number | null | undefined): number {
  const decision = decideRevisionCas(currentRevision, ifMatch);
  if ("code" in decision) throw new ControlPlaneCoreError(decision.code, `current=${decision.currentRevision}`);
  return decision.nextRevision;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
