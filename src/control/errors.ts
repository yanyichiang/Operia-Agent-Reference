export type ControlPlaneErrorCode =
  | "invalid_scope"
  | "scope_not_allowed"
  | "invalid_definition"
  | "invalid_candidate"
  | "invalid_revision"
  | "missing_revision"
  | "revision_conflict"
  | "invalid_manifest"
  | "invalid_topology"
  | "invalid_route_template"
  | "invalid_route_locator"
  | "custom_resolution_required";

export class ControlPlaneCoreError extends Error {
  readonly code: ControlPlaneErrorCode;

  constructor(code: ControlPlaneErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "ControlPlaneCoreError";
    this.code = code;
  }
}
