const SENSITIVE_KEY = /(authorization|bearer|token|secret|password|cookie|api[_-]?key|authReference)/i;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(redact(data)), { ...init, headers });
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}

export async function bearerAuthorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  let mismatch = left.byteLength ^ right.byteLength;
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0 && actual.length > 0;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}
