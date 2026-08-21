import { byteLengthOf, sha256Hex } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import type {
  ContextCapsule,
  ContextCapsuleInput,
  ContextCapsuleResolutionInput,
  ContextCapsuleResolutionResult,
  ContextHandleInput,
  ContextHandleRecord,
  ContextHandleResolutionInput,
  ContextReference,
  ContextReferenceKind,
} from "./types";

const MAX_CONTEXT_TTL_MS = 15 * 60 * 1000;
const MAX_CONTEXT_BYTES = 64 * 1024;
const REFERENCE_KEYS = new Set(["handle"]);
const REFERENCE_KINDS = new Set<ContextReferenceKind>(["memory", "artifact", "tool_result"]);
const HANDLE_PATTERN = /^ctxh_[a-f0-9]{32}$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;

export async function canonicalArgsHash(args: unknown): Promise<string> {
  return sha256Hex(canonicalJson(assertJsonValue(args)));
}

export function createContextHandle(input: ContextHandleInput): ContextHandleRecord {
  const createdAt = requireServerTime(input.serverNow);
  const ttlMs = Math.max(1, Math.min(MAX_CONTEXT_TTL_MS, Math.trunc(input.ttlMs)));
  if (!Number.isFinite(input.ttlMs) || !REFERENCE_KINDS.has(input.kind) || !CHECKSUM_PATTERN.test(input.checksum)) {
    throw new Error("invalid_context_handle_request");
  }
  return {
    handle: `ctxh_${crypto.randomUUID().replaceAll("-", "")}`,
    namespace: input.namespace,
    chatId: input.chatId,
    taskId: input.taskId,
    recipient: input.recipient,
    purpose: input.purpose,
    requestHash: input.requestHash,
    ownerId: input.ownerId,
    serviceId: input.serviceId,
    kind: input.kind,
    checksum: input.checksum,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
}

export async function resolveIssuedContextReferences(
  rawRefs: ReadonlyArray<unknown>,
  input: ContextHandleResolutionInput,
  lookup: (handle: string) => Promise<ContextHandleRecord | null>,
): Promise<ContextReference[]> {
  const now = requireServerTime(input.serverNow);
  const refs: ContextReference[] = [];
  const seen = new Set<string>();
  for (const rawRef of rawRefs) {
    const ref = parseStrictReference(rawRef);
    if (seen.has(ref.handle)) throw new Error("duplicate_context_handle");
    seen.add(ref.handle);
    const record = await lookup(ref.handle);
    if (!record) throw new Error("unknown_context_handle");
    if (!handleRecordMatches(record, ref.handle, input, now)) throw new Error("context_handle_scope_mismatch");
    refs.push(ref);
  }
  return refs;
}

export function createContextCapsule(input: ContextCapsuleInput): ContextCapsule {
  const createdAt = requireServerTime(input.serverNow);
  const maxBytes = Math.max(2, Math.min(MAX_CONTEXT_BYTES, Math.trunc(input.maxBytes)));
  const ttlMs = Math.max(1, Math.min(MAX_CONTEXT_TTL_MS, Math.trunc(input.ttlMs)));
  if (!Number.isFinite(input.maxBytes) || !Number.isFinite(input.ttlMs)) throw new Error("invalid_context_limits");

  const refs: ContextReference[] = [];
  let truncated = false;
  for (const rawRef of input.refs) {
    const ref = parseStrictReference(rawRef);
    const candidate = [...refs, ref];
    if (serializedRefsBytes(candidate) > maxBytes) {
      truncated = true;
      continue;
    }
    refs.push(ref);
  }

  return {
    capsuleId: `ctx_${crypto.randomUUID()}`,
    namespace: input.namespace,
    chatId: input.chatId,
    taskId: input.taskId,
    recipient: input.recipient,
    purpose: input.purpose,
    requestHash: input.requestHash,
    ownerId: input.ownerId,
    serviceId: input.serviceId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
    maxBytes,
    totalBytes: serializedRefsBytes(refs),
    truncated,
    refs,
  };
}

export function resolveContextCapsule(capsule: ContextCapsule, input: ContextCapsuleResolutionInput): ContextCapsuleResolutionResult {
  const nowMs = input.serverNow instanceof Date ? input.serverNow.getTime() : Number.NaN;
  const expiresAtMs = Date.parse(capsule.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs)) return { ok: false, code: "invalid_server_clock" };
  if (nowMs > expiresAtMs) return { ok: false, code: "capsule_expired" };
  if (
    capsule.namespace !== input.namespace ||
    capsule.chatId !== input.chatId ||
    capsule.taskId !== input.taskId ||
    capsule.recipient !== input.recipient ||
    capsule.purpose !== input.purpose ||
    capsule.requestHash !== input.requestHash ||
    capsule.ownerId !== input.ownerId ||
    capsule.serviceId !== input.serviceId
  ) {
    return { ok: false, code: "capsule_scope_mismatch" };
  }
  return { ok: true, capsule };
}

function requireServerTime(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid_server_clock");
  return value;
}

function parseStrictReference(value: unknown): ContextReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_context_reference");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== REFERENCE_KEYS.size || Object.keys(record).some((key) => !REFERENCE_KEYS.has(key))) {
    throw new Error("invalid_context_reference");
  }
  if (typeof record.handle !== "string" || !HANDLE_PATTERN.test(record.handle)) {
    throw new Error("invalid_context_reference");
  }
  return { handle: record.handle };
}

function handleRecordMatches(record: ContextHandleRecord, expectedHandle: string, input: ContextHandleResolutionInput, now: Date): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return (
    HANDLE_PATTERN.test(record.handle) &&
    record.handle === expectedHandle &&
    REFERENCE_KINDS.has(record.kind) &&
    CHECKSUM_PATTERN.test(record.checksum) &&
    Number.isFinite(expiresAt) &&
    now.getTime() <= expiresAt &&
    record.namespace === input.namespace &&
    record.chatId === input.chatId &&
    record.taskId === input.taskId &&
    record.recipient === input.recipient &&
    record.purpose === input.purpose &&
    record.requestHash === input.requestHash &&
    record.ownerId === input.ownerId &&
    record.serviceId === input.serviceId
  );
}

function serializedRefsBytes(refs: ReadonlyArray<ContextReference>): number {
  return byteLengthOf(canonicalJson(assertJsonValue(refs)));
}
