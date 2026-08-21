import { canonicalJson } from "../import/hashes";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const MEMORY_SERIALIZATION_VERSION = "memory-cjson-v1-js-key-order";
export const MEMORY_HASH_VERSION = "memory-domain-sha256-v1";
export const MEMORY_HMAC_VERSION = "memory-domain-hmac-sha256-v1";
export const MEMORY_BYTE_SPAN_VERSION = "utf8-half-open-v1";

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function framed(domain: string, value: unknown): Uint8Array {
  if (!domain.trim()) throw new Error("memory_hash_domain_required");
  const fields = [MEMORY_SERIALIZATION_VERSION, domain, value].map((field) => {
    const serialized = canonicalJson(field);
    return `${encoder.encode(serialized).byteLength}:${serialized}`;
  });
  return encoder.encode(`${MEMORY_HASH_VERSION}|${fields.join("|")}`);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

export async function memoryArtifactHash(domain: string, value: unknown): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", exactArrayBuffer(framed(domain, value))));
}

export async function memoryHmacRef(key: Uint8Array, domain: string, value: unknown): Promise<string> {
  if (key.byteLength < 32) throw new Error("memory_hmac_key_too_short");
  const cryptoKey = await crypto.subtle.importKey("raw", exactArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, exactArrayBuffer(framed(`${MEMORY_HMAC_VERSION}:${domain}`, value)));
  return `mh1_${hex(signature)}`;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function utf8Slice(value: string, byteStart: number, byteEnd: number): string {
  const bytes = encoder.encode(value);
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteStart < 0 || byteEnd <= byteStart || byteEnd > bytes.byteLength) {
    throw new Error("memory_utf8_span_invalid");
  }
  try {
    return fatalDecoder.decode(bytes.slice(byteStart, byteEnd));
  } catch {
    throw new Error("memory_utf8_span_boundary_invalid");
  }
}

export async function utf8SpanHash(input: {
  canonicalEventId: string;
  contentRevision: number;
  content: string;
  byteStart: number;
  byteEnd: number;
}): Promise<string> {
  if (!input.canonicalEventId.trim()) throw new Error("memory_span_event_required");
  if (!Number.isSafeInteger(input.contentRevision) || input.contentRevision < 1) {
    throw new Error("memory_span_content_revision_invalid");
  }
  const span = utf8Slice(input.content,input.byteStart,input.byteEnd);
  return memoryArtifactHash("memory-evidence-span-v2", {
    canonicalEventId: input.canonicalEventId,
    contentRevision: input.contentRevision,
    byteStart: input.byteStart,
    byteEnd: input.byteEnd,
    span,
  });
}

export function utf16IndexToUtf8Offset(value: string, utf16Index: number): number {
  if (!Number.isSafeInteger(utf16Index) || utf16Index < 0 || utf16Index > value.length) {
    throw new Error("memory_utf16_index_invalid");
  }
  if (
    utf16Index > 0
    && utf16Index < value.length
    && value.charCodeAt(utf16Index - 1) >= 0xd800
    && value.charCodeAt(utf16Index - 1) <= 0xdbff
    && value.charCodeAt(utf16Index) >= 0xdc00
    && value.charCodeAt(utf16Index) <= 0xdfff
  ) {
    throw new Error("memory_utf16_index_boundary_invalid");
  }
  const prefix = value.slice(0, utf16Index);
  return utf8ByteLength(prefix);
}

export function createTombstoneToken(): string {
  return `mt1_${crypto.randomUUID()}`;
}
