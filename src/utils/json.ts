export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonErrorCode =
  | "invalid_json_value"
  | "json_cycle_detected"
  | "json_max_depth_exceeded"
  | "json_non_finite_number"
  | "json_unsupported_type"
  | "json_unsupported_prototype";

const MAX_CANONICAL_JSON_DEPTH = 64;
const DEFAULT_DISPLAY_MAX_BYTES = 128 * 1024;
const DISPLAY_TRUNCATION_SUFFIX = "…[truncated]";

export class JsonValueError extends Error {
  readonly code: JsonErrorCode;

  constructor(code: JsonErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "JsonValueError";
    this.code = code;
  }
}

function fail(code: JsonErrorCode, detail?: string): never {
  throw new JsonValueError(code, detail);
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertJsonValueImpl(value: unknown, seen: Set<object>, depth: number): void {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    fail("json_max_depth_exceeded");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && !isValidUnicode(value)) {
      fail("invalid_json_value", "invalid_unicode");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("json_non_finite_number");
    }
    return;
  }
  if (typeof value !== "object") {
    fail("json_unsupported_type", typeof value);
  }
  if (seen.has(value)) {
    fail("json_cycle_detected");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("json_unsupported_prototype", "array");
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !isCanonicalArrayIndex(key, value.length)))) {
        fail("json_unsupported_prototype", "array");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("json_unsupported_prototype", "array");
        }
        assertJsonValueImpl(descriptor.value, seen, depth + 1);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      fail("json_unsupported_prototype", value.constructor?.name ?? "object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail("json_unsupported_prototype", "object");
    }
    for (const key of keys as string[]) {
      if (!isValidUnicode(key)) {
        fail("invalid_json_value", "invalid_unicode_key");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("json_unsupported_prototype", "object");
      }
      assertJsonValueImpl(descriptor.value, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

export function assertJsonValue(value: unknown): JsonValue {
  assertJsonValueImpl(value, new Set<object>(), 0);
  return value as JsonValue;
}

function canonicalJsonImpl(value: JsonValue, seen: Set<object>, depth: number): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    fail("json_max_depth_exceeded");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("json_non_finite_number");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);

  if (seen.has(value)) {
    fail("json_cycle_detected");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJsonImpl(item, seen, depth + 1)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, JsonValue>);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonImpl(item, seen, depth + 1)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: JsonValue): string {
  return canonicalJsonImpl(value, new Set<object>(), 0);
}

function displayTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return "BigInt";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  if (typeof value === "object") {
    if (Array.isArray(value)) return "array";
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value.constructor?.name || "object";
    }
    return "object";
  }
  return typeof value;
}

function safeSerializeForDisplayImpl(
  value: unknown,
  seen: WeakSet<object>,
  options: { maxBytes: number },
): string {
  if (typeof value === "bigint") return `[BigInt: ${value.toString()}]`;
  if (typeof value === "function") return `[Function${"name" in value && value.name ? `: ${value.name}` : ""}]`;
  if (typeof value === "symbol") return `[Symbol: ${value.toString()}]`;
  if (value === undefined) return "[undefined]";
  if (typeof value === "number" && !Number.isFinite(value)) return `[NonFinite: ${String(value)}]`;
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return `[Unsupported: ${displayTypeLabel(value)}]`;
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => safeSerializeForDisplayImpl(item, seen, options)).join(", ")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `[${displayTypeLabel(value)}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${safeSerializeForDisplayImpl(item, seen, options)}`).join(", ")}}`;
  } finally {
    seen.delete(value);
  }
}

function truncateToByteBudget(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const valueBytes = encoder.encode(value);
  if (valueBytes.byteLength <= maxBytes) return value;

  let suffix = "";
  for (const character of DISPLAY_TRUNCATION_SUFFIX) {
    const candidate = `${suffix}${character}`;
    if (encoder.encode(candidate).byteLength > maxBytes) break;
    suffix = candidate;
  }
  if (suffix.length === 0) return "";

  let output = "";
  for (const character of value) {
    const candidate = `${output}${character}`;
    if (encoder.encode(candidate).byteLength + encoder.encode(suffix).byteLength > maxBytes) break;
    output = candidate;
  }
  return `${output}${suffix}`;
}

export function safeSerializeForDisplay(value: unknown, options?: { maxBytes?: number }): string {
  const maxBytes = options?.maxBytes ?? DEFAULT_DISPLAY_MAX_BYTES;
  try {
    const serialized = safeSerializeForDisplayImpl(value, new WeakSet<object>(), { maxBytes });
    return truncateToByteBudget(serialized, maxBytes);
  } catch {
    return "[Display serialization failed]";
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function openAiError(message: string, status = 400, type = "invalid_request_error"): Response {
  return json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status },
  );
}
