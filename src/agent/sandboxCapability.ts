export const SANDBOX_CAPABILITY_VERSION = 1 as const;
export const SANDBOX_CAPABILITY_MAX_TTL_MS = 15 * 60_000;

export type SandboxCapabilityScope =
  | "synthetic.echo"
  | "storage.read"
  | "storage.write"
  | "storage.soft_delete"
  | "storage.restore"
  | "system.read"
  | "health.read"
  | "calendar.read";

export type SandboxCapabilityClaims = {
  version: typeof SANDBOX_CAPABILITY_VERSION;
  ownerId: string;
  taskId: string;
  environment: "candidate" | "qa" | "production";
  sandboxId: string;
  policyVersion: "operia-sandbox-v1";
  scopes: SandboxCapabilityScope[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

const TOKEN_PART = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!TOKEN_PART.test(value)) throw new Error("sandbox_capability_encoding_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  if (secret.length < 32) throw new Error("sandbox_capability_secret_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export function validateSandboxCapabilityClaims(
  claims: SandboxCapabilityClaims,
  nowMs = Date.now(),
): SandboxCapabilityClaims {
  if (claims.version !== SANDBOX_CAPABILITY_VERSION || claims.policyVersion !== "operia-sandbox-v1") {
    throw new Error("sandbox_capability_version_invalid");
  }
  if (![claims.ownerId, claims.taskId, claims.sandboxId, claims.nonce].every((value) => IDENTIFIER.test(value))) {
    throw new Error("sandbox_capability_scope_invalid");
  }
  if (!(["candidate", "qa", "production"] as const).includes(claims.environment)) throw new Error("sandbox_capability_environment_invalid");
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) {
    throw new Error("sandbox_capability_time_invalid");
  }
  const ttl = claims.expiresAt - claims.issuedAt;
  if (ttl < 1_000 || ttl > SANDBOX_CAPABILITY_MAX_TTL_MS || claims.issuedAt > nowMs + 30_000) {
    throw new Error("sandbox_capability_time_invalid");
  }
  if (claims.expiresAt <= nowMs) throw new Error("sandbox_capability_expired");
  const scopes = [...new Set(claims.scopes)];
  if (scopes.length < 1 || scopes.length !== claims.scopes.length) throw new Error("sandbox_capability_scopes_invalid");
  return { ...claims, scopes };
}

export async function mintSandboxCapability(
  secret: string,
  claims: SandboxCapabilityClaims,
): Promise<string> {
  const checked = validateSandboxCapabilityClaims(claims, Date.now());
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(checked)));
  return `${payload}.${encodeBase64Url(await hmac(secret, payload))}`;
}

export async function verifySandboxCapability(
  secret: string,
  token: string,
  input: { nowMs?: number; requiredScope?: SandboxCapabilityScope; taskId?: string; ownerId?: string; sandboxId?: string } = {},
): Promise<SandboxCapabilityClaims> {
  if (token.length > 4096) throw new Error("sandbox_capability_invalid");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("sandbox_capability_invalid");
  const expected = await hmac(secret, parts[0]);
  if (!equalBytes(expected, decodeBase64Url(parts[1]))) throw new Error("sandbox_capability_signature_invalid");
  let claims: SandboxCapabilityClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))) as SandboxCapabilityClaims;
  } catch {
    throw new Error("sandbox_capability_payload_invalid");
  }
  const checked = validateSandboxCapabilityClaims(claims, input.nowMs ?? Date.now());
  if (input.requiredScope && !checked.scopes.includes(input.requiredScope)) throw new Error("sandbox_capability_scope_denied");
  if (input.taskId && checked.taskId !== input.taskId) throw new Error("sandbox_capability_task_mismatch");
  if (input.ownerId && checked.ownerId !== input.ownerId) throw new Error("sandbox_capability_owner_mismatch");
  if (input.sandboxId && checked.sandboxId !== input.sandboxId) throw new Error("sandbox_capability_sandbox_mismatch");
  return checked;
}

export function newSandboxCapabilityNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
