export const SANDBOX_POLICY_VERSION = "operia-sandbox-v1" as const;
export const SANDBOX_MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SANDBOX_MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
export const SANDBOX_MAX_COMMAND_MS = 60_000;
export const SANDBOX_EXEC_MAX_SCRIPT_CHARS = 16_000;
export const SANDBOX_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const SANDBOX_EXEC_CAPTURE_BYTES = 24 * 1024;
export const OPERIA_TEST_NAMESPACE = "operia-test" as const;
export const OPERIA_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const OPERIA_OWNER_MAX_RESOURCES = 1_000;
export const OPERIA_OWNER_MAX_BYTES = 10 * 1024 * 1024;
export const OPERIA_APPEND_MAX_ITEMS = 1_000;

export const OPERIA_RESOURCE_TYPES = [
  "task_note",
  "observation",
  "preference_candidate",
  "structured_data",
  "checkpoint_candidate",
  "schedule_candidate",
  "artifact_candidate",
] as const;
export type OperiaResourceType = typeof OPERIA_RESOURCE_TYPES[number];

export type NormalizedSandboxExecution = {
  script: string;
  timeoutMs: number;
};

export function normalizeSandboxExecutionInput(input: Record<string, unknown>): NormalizedSandboxExecution {
  const script = typeof input.script === "string" ? input.script : "";
  if (!script.trim() || script.length > SANDBOX_EXEC_MAX_SCRIPT_CHARS || script.includes("\0")) {
    throw new Error("sandbox_execution_script_invalid");
  }
  const requestedTimeout = input.timeout_ms === undefined ? SANDBOX_EXEC_DEFAULT_TIMEOUT_MS : Number(input.timeout_ms);
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1_000 || requestedTimeout > SANDBOX_MAX_COMMAND_MS) {
    throw new Error("sandbox_execution_timeout_invalid");
  }
  return { script, timeoutMs: requestedTimeout };
}

export function truncateSandboxExecutionOutput(value: string, maxBytes = SANDBOX_EXEC_CAPTURE_BYTES): {
  value: string;
  sourceBytes: number;
  truncated: boolean;
} {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { value, sourceBytes: bytes.byteLength, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: new TextDecoder().decode(bytes.slice(0, end)),
    sourceBytes: bytes.byteLength,
    truncated: true,
  };
}

export type SandboxEgressDecision =
  | { ok: true; url: URL; method: "GET" | "HEAD" }
  | { ok: false; code: string };

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

export function isPrivateOrSpecialHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  // All IPv6 literals are denied. Public IPv6 can be enabled later only with a resolver-backed policy.
  if (hostname.includes(":")) return true;
  const ip = ipv4Octets(hostname);
  if (!ip) return false;
  const [a, b] = ip;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function evaluateSandboxPublicEgress(request: Request): SandboxEgressDecision {
  if (request.method !== "GET" && request.method !== "HEAD") return { ok: false, code: "sandbox_egress_method_denied" };
  let url: URL;
  try { url = new URL(request.url); } catch { return { ok: false, code: "sandbox_egress_url_invalid" }; }
  if (url.protocol !== "https:") return { ok: false, code: "sandbox_egress_https_required" };
  if (url.username || url.password) return { ok: false, code: "sandbox_egress_userinfo_denied" };
  if (url.port && url.port !== "443") return { ok: false, code: "sandbox_egress_port_denied" };
  if (isPrivateOrSpecialHostname(url.hostname)) return { ok: false, code: "sandbox_egress_private_target_denied" };
  return { ok: true, url, method: request.method };
}

export function sanitizeSandboxOutboundHeaders(input: Headers): Headers {
  const output = new Headers();
  for (const name of ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"]) {
    const value = input.get(name);
    if (value) output.set(name, value.slice(0, 1024));
  }
  output.set("user-agent", "Operia-Sandbox/1.0 (+read-only-egress)");
  return output;
}

export async function readBoundedSandboxResponse(response: Response, maxBytes = SANDBOX_MAX_HTTP_RESPONSE_BYTES): Promise<Response> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("sandbox_egress_response_too_large");
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("sandbox_egress_response_too_large");
        throw new Error("sandbox_egress_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.set("content-length", String(total));
  headers.set("x-operia-egress-policy", SANDBOX_POLICY_VERSION);
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

export function deriveSandboxIsolationInput(ownerId: string, taskId: string, environment: string): string {
  for (const value of [ownerId, taskId, environment]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("sandbox_isolation_scope_invalid");
  }
  return `${SANDBOX_POLICY_VERSION}\u0000${ownerId}\u0000${taskId}\u0000${environment}`;
}

export async function deriveSandboxIsolationId(ownerId: string, taskId: string, environment: "candidate" | "qa" | "production"): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deriveSandboxIsolationInput(ownerId, taskId, environment))));
  return `operia-${Array.from(digest.slice(0, 18), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type OperiaResourceLifecycleInput = {
  status: "active" | "tombstoned";
  restoreDeadline?: string | null;
  pinned: boolean;
  referenceCount: number;
  legalHold?: boolean;
  unknownSideEffect?: boolean;
};

export function evaluateOperiaReclaim(input: OperiaResourceLifecycleInput, nowMs = Date.now()): { eligible: boolean; code: string } {
  if (input.status !== "tombstoned") return { eligible: false, code: "operia_resource_not_tombstoned" };
  if (input.pinned) return { eligible: false, code: "operia_resource_pinned" };
  if (input.referenceCount > 0) return { eligible: false, code: "operia_resource_referenced" };
  if (input.legalHold) return { eligible: false, code: "operia_resource_legal_hold" };
  if (input.unknownSideEffect) return { eligible: false, code: "operia_resource_unknown_side_effect" };
  const deadline = input.restoreDeadline ? Date.parse(input.restoreDeadline) : Number.NaN;
  if (!Number.isFinite(deadline) || deadline > nowMs) return { eligible: false, code: "operia_restore_window_active" };
  // P1/P2 never physically purges. A later lifecycle job may consume this marker after Owner review.
  return { eligible: true, code: "operia_reclaim_review_required" };
}

export function normalizeOperiaResourceId(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(id)) throw new Error("operia_resource_id_invalid");
  return id;
}

export function serializeOperiaResourceValue(value: unknown): { json: string; bytes: number } {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("operia_resource_value_invalid");
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > 64 * 1024) throw new Error("operia_resource_value_too_large");
  return { json, bytes };
}

export function normalizeOperiaResourceType(value: unknown): OperiaResourceType {
  if (typeof value !== "string" || !(OPERIA_RESOURCE_TYPES as readonly string[]).includes(value)) {
    throw new Error("operia_resource_type_denied");
  }
  return value as OperiaResourceType;
}

export function normalizeOperiaMutationEnvelope(input: Record<string, unknown>): {
  requestId: string;
  idempotencyKey: string;
  schemaOwner: "operia";
  schemaVersion: string;
} {
  const requestId = normalizeOperiaMutationToken(input.request_id, "operia_request_id_invalid");
  const idempotencyKey = normalizeOperiaMutationToken(input.idempotency_key, "operia_idempotency_key_invalid");
  const schemaOwner = input.schema_owner;
  if (schemaOwner !== "operia") throw new Error("operia_schema_owner_denied");
  const schemaVersion = normalizeOperiaMutationToken(input.schema_version, "operia_schema_version_invalid");
  return { requestId, idempotencyKey, schemaOwner, schemaVersion };
}

export function appendOperiaResourceValue(current: unknown, item: unknown): unknown[] {
  const existing = current === undefined ? [] : current;
  if (!Array.isArray(existing)) throw new Error("operia_append_target_not_list");
  if (existing.length >= OPERIA_APPEND_MAX_ITEMS) throw new Error("operia_append_item_limit");
  const next = [...existing, item];
  serializeOperiaResourceValue(next);
  return next;
}

export function operiaUndoSummary(input: {
  action: "append" | "upsert" | "soft_delete" | "restore" | "rollback";
  resourceId: string;
  version: number;
  previousVersion: number | null;
  restoreDeadline?: string | null;
}): Record<string, unknown> {
  if (input.action === "soft_delete") {
    return {
      reversible: true,
      action: "storage.restore",
      resourceId: input.resourceId,
      expectedVersion: input.version,
      restoreDeadline: input.restoreDeadline ?? null,
    };
  }
  if (input.action === "restore") {
    return {
      reversible: false,
      compensating: true,
      action: "storage.soft_delete",
      resourceId: input.resourceId,
      expectedVersion: input.version,
      note: "Restoring a tombstone cannot recreate the original deletion event; a new soft-delete is compensating only.",
    };
  }
  if (input.previousVersion === null) {
    return {
      reversible: true,
      action: "storage.soft_delete",
      resourceId: input.resourceId,
      expectedVersion: input.version,
      note: "Undoing the first version creates a restorable tombstone; Operia never physically purges it.",
    };
  }
  return {
    reversible: true,
    action: "storage.rollback",
    resourceId: input.resourceId,
    expectedVersion: input.version,
    targetVersion: input.previousVersion,
  };
}

function normalizeOperiaMutationToken(value: unknown, code: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(token)) throw new Error(code);
  return token;
}
