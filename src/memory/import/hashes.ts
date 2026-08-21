import { assertJsonValue, canonicalJson as strictCanonicalJson } from "../../utils/json";

const encoder = new TextEncoder();

export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", exact.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  return strictCanonicalJson(assertJsonValue(value));
}

export async function domainSeparatedHash(domain: string, fields: readonly unknown[]): Promise<string> {
  const framed = [domain, ...fields].map((field) => {
    const encoded = canonicalJson(field);
    return `${encoder.encode(encoded).byteLength}:${encoded}`;
  }).join("|");
  return sha256Hex(framed);
}
