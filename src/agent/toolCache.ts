import { byteLengthOf, sha256Hex } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import type { RiskLevel } from "./types";

export const TOOL_RESULT_CACHE_SCHEMA_VERSION = 1;
export const MAX_TOOL_RESULT_CACHE_KEY_BYTES = 128;
export const MAX_TOOL_RESULT_CACHE_PAYLOAD_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_CACHE_SCOPE_FIELD_BYTES = 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CACHE_KEY_PATTERN = /^trc:v[1-9]\d*:[a-f0-9]{64}$/;

export type ToolResultCacheScope = {
  ownerId: string;
  serviceId: string;
  chatId: string;
  taskId: string;
  purpose: string;
  requestHash: string;
};

export type ToolResultCacheSourceHashes = {
  providerHash: string;
  toolHash: string;
  schemaHash: string;
};

export type ToolResultCacheKeyInput = ToolResultCacheScope & ToolResultCacheSourceHashes & {
  schemaVersion: number;
};

export type ToolResultCacheSourceInput = {
  provider: unknown;
  tool: unknown;
  schema: unknown;
};

export type ToolResultCacheWritePolicy = {
  riskLevel: RiskLevel;
  cacheable: boolean;
  success: boolean;
  ttlMs: number;
};

export type ToolResultCacheWriteInput = ToolResultCacheKeyInput & ToolResultCacheWritePolicy & {
  result: unknown;
  serverNow: Date;
};

export type ToolResultCacheRecord = ToolResultCacheSourceHashes & {
  schemaVersion: number;
  cacheKey: string;
  scopeHash: string;
  requestHash: string;
  resultJson: string;
  createdAt: number;
  expiresAt: number;
};

export type ToolResultCacheBypassReason = "risk_not_read" | "not_cacheable" | "not_success" | "ttl_disabled";

export type ToolResultCacheLookupResult =
  | { status: "hit"; value: unknown; record: ToolResultCacheRecord }
  | { status: "stale"; reason: "expired"; record: ToolResultCacheRecord }
  | {
      status: "miss";
      reason: "not_found" | "invalid_record" | "schema_version_mismatch" | "source_mismatch" | "scope_mismatch" | "key_mismatch";
    };

export async function hashToolResultCacheSource(input: ToolResultCacheSourceInput): Promise<ToolResultCacheSourceHashes> {
  const [providerHash, toolHash, schemaHash] = await Promise.all([
    sha256Hex(canonicalJson(assertJsonValue(input.provider))),
    sha256Hex(canonicalJson(assertJsonValue(input.tool))),
    sha256Hex(canonicalJson(assertJsonValue(input.schema))),
  ]);
  return { providerHash, toolHash, schemaHash };
}

export async function createToolResultCacheScopeHash(scope: ToolResultCacheScope): Promise<string> {
  validateScope(scope);
  return sha256Hex(canonicalJson(assertJsonValue(pickScope(scope))));
}

export async function createToolResultCacheKey(input: ToolResultCacheKeyInput): Promise<string> {
  validateKeyInput(input);
  const digest = await sha256Hex(canonicalJson(assertJsonValue(pickKeyInput(input))));
  const key = `trc:v${input.schemaVersion}:${digest}`;
  if (byteLengthOf(key) > MAX_TOOL_RESULT_CACHE_KEY_BYTES) throw new Error("tool_cache_key_too_large");
  return key;
}

export function toolResultCacheBypassReason(input: ToolResultCacheWritePolicy): ToolResultCacheBypassReason | null {
  if (input.riskLevel !== "read") return "risk_not_read";
  if (input.cacheable !== true) return "not_cacheable";
  if (input.success !== true) return "not_success";
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) return "ttl_disabled";
  return null;
}

export function isToolResultCacheWriteAllowed(input: ToolResultCacheWritePolicy): boolean {
  return toolResultCacheBypassReason(input) === null;
}

export async function createToolResultCacheRecord(input: ToolResultCacheWriteInput): Promise<ToolResultCacheRecord | null> {
  if (!isToolResultCacheWriteAllowed(input)) return null;
  const now = requireServerTime(input.serverNow);
  const ttlMs = Math.trunc(input.ttlMs);
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(expiresAt)) {
    throw new Error("invalid_tool_cache_ttl");
  }

  const resultJson = canonicalJson(assertJsonValue(input.result));
  if (byteLengthOf(resultJson) > MAX_TOOL_RESULT_CACHE_PAYLOAD_BYTES) {
    throw new Error("tool_cache_payload_too_large");
  }

  const scope = pickScope(input);
  const [cacheKey, scopeHash] = await Promise.all([
    createToolResultCacheKey(input),
    createToolResultCacheScopeHash(scope),
  ]);
  return {
    schemaVersion: input.schemaVersion,
    cacheKey,
    scopeHash,
    providerHash: input.providerHash,
    toolHash: input.toolHash,
    schemaHash: input.schemaHash,
    requestHash: input.requestHash,
    resultJson,
    createdAt: now,
    expiresAt,
  };
}

export function isToolResultCacheRecordStale(record: ToolResultCacheRecord, serverNow: Date): boolean {
  return requireServerTime(serverNow) >= record.expiresAt;
}

export async function resolveToolResultCacheRecord(
  record: ToolResultCacheRecord | null,
  input: ToolResultCacheKeyInput & { serverNow: Date },
): Promise<ToolResultCacheLookupResult> {
  const now = requireServerTime(input.serverNow);
  if (!record) return { status: "miss", reason: "not_found" };
  if (!isToolResultCacheRecord(record)) return { status: "miss", reason: "invalid_record" };
  if (record.schemaVersion !== input.schemaVersion) return { status: "miss", reason: "schema_version_mismatch" };
  if (
    record.providerHash !== input.providerHash ||
    record.toolHash !== input.toolHash ||
    record.schemaHash !== input.schemaHash
  ) {
    return { status: "miss", reason: "source_mismatch" };
  }

  const scopeHash = await createToolResultCacheScopeHash(pickScope(input));
  if (record.scopeHash !== scopeHash || record.requestHash !== input.requestHash) {
    return { status: "miss", reason: "scope_mismatch" };
  }
  const expectedKey = await createToolResultCacheKey(input);
  if (record.cacheKey !== expectedKey) return { status: "miss", reason: "key_mismatch" };
  if (now >= record.expiresAt) return { status: "stale", reason: "expired", record };

  try {
    return { status: "hit", value: JSON.parse(record.resultJson), record };
  } catch {
    return { status: "miss", reason: "invalid_record" };
  }
}

export function isToolResultCacheRecord(value: unknown): value is ToolResultCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isSchemaVersion(record.schemaVersion) &&
    typeof record.cacheKey === "string" &&
    CACHE_KEY_PATTERN.test(record.cacheKey) &&
    byteLengthOf(record.cacheKey) <= MAX_TOOL_RESULT_CACHE_KEY_BYTES &&
    isSha256(record.scopeHash) &&
    isSha256(record.providerHash) &&
    isSha256(record.toolHash) &&
    isSha256(record.schemaHash) &&
    typeof record.requestHash === "string" &&
    record.requestHash.length > 0 &&
    byteLengthOf(record.requestHash) <= MAX_TOOL_RESULT_CACHE_SCOPE_FIELD_BYTES &&
    typeof record.resultJson === "string" &&
    byteLengthOf(record.resultJson) <= MAX_TOOL_RESULT_CACHE_PAYLOAD_BYTES &&
    typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.createdAt) &&
    typeof record.expiresAt === "number" &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt > record.createdAt
  );
}

function validateKeyInput(input: ToolResultCacheKeyInput): void {
  validateScope(input);
  if (!isSchemaVersion(input.schemaVersion)) throw new Error("invalid_tool_cache_schema_version");
  if (!isSha256(input.providerHash) || !isSha256(input.toolHash) || !isSha256(input.schemaHash)) {
    throw new Error("invalid_tool_cache_source_hash");
  }
}

function validateScope(scope: ToolResultCacheScope): void {
  for (const value of [scope.ownerId, scope.serviceId, scope.chatId, scope.taskId, scope.purpose, scope.requestHash]) {
    if (typeof value !== "string" || value.length === 0) throw new Error("tool_cache_scope_required");
    if (byteLengthOf(value) > MAX_TOOL_RESULT_CACHE_SCOPE_FIELD_BYTES) throw new Error("tool_cache_scope_too_large");
  }
}

function pickScope(scope: ToolResultCacheScope): ToolResultCacheScope {
  return {
    ownerId: scope.ownerId,
    serviceId: scope.serviceId,
    chatId: scope.chatId,
    taskId: scope.taskId,
    purpose: scope.purpose,
    requestHash: scope.requestHash,
  };
}

function pickKeyInput(input: ToolResultCacheKeyInput): ToolResultCacheKeyInput {
  return {
    schemaVersion: input.schemaVersion,
    ...pickScope(input),
    providerHash: input.providerHash,
    toolHash: input.toolHash,
    schemaHash: input.schemaHash,
  };
}

function isSchemaVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function requireServerTime(value: Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_server_clock");
  return timestamp;
}
