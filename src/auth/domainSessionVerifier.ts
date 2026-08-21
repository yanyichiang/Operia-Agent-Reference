import { authenticateDomainSession, type DomainSessionEnv } from "./domainSession";

const INTERNAL_HOST = "<MEMORY_SERVICE>.internal";
const VERIFY_PATH = "/service/domain-session/verify";
const SERVICE_AUTH_HEADER = "x-operia-service-authorization";
const SOURCE_DOMAIN = "health.example.com";
const SERVICE_ID = "<HEALTH_SERVICE>-session-verifier";
const MAX_COOKIE_BYTES = 4096;

type SessionAuthorityEnv = DomainSessionEnv & {
  HEALTH_SESSION_VERIFY_BEARER?: string;
};

export type SessionVerifierClientEnv = DomainSessionEnv & {
  MEMORY_SESSION_SERVICE?: Fetcher;
  HEALTH_SESSION_VERIFY_BEARER?: string;
};

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}

async function constantTimeEqual(actual: string, expected: string): Promise<boolean> {
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

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected?.trim()) return false;
  const header = request.headers.get(SERVICE_AUTH_HEADER) ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(actual, expected.trim());
}

export async function handleDomainSessionVerification(request: Request, env: SessionAuthorityEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== INTERNAL_HOST || url.pathname !== VERIFY_PATH) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (url.search || request.headers.get("x-operia-source-domain") !== SOURCE_DOMAIN || request.headers.get("x-operia-service-id") !== SERVICE_ID) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!await authorized(request, env.HEALTH_SESSION_VERIFY_BEARER)) return json({ error: "unauthorized" }, 401);

  const cookie = request.headers.get("cookie") ?? "";
  if (!cookie || new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES) return json({ ok: false }, 401);
  const auth = await authenticateDomainSession(new Request("https://memory.example.com/api/session/verify", {
    method: "GET",
    headers: { cookie, "x-operia-session": "1" },
  }), env);
  return auth.ok ? json({ ok: true }, 200) : json({ ok: false }, 401);
}

export async function verifyOwnerDomainSession(request: Request, env: SessionVerifierClientEnv): Promise<boolean> {
  if (request.headers.get("x-operia-session") !== "1") return false;
  const service = env.MEMORY_SESSION_SERVICE;
  const serviceBearer = env.HEALTH_SESSION_VERIFY_BEARER?.trim();
  if (service && serviceBearer) {
    const cookie = request.headers.get("cookie") ?? "";
    if (!cookie || new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES) return false;
    const response = await service.fetch(new Request(`https://${INTERNAL_HOST}${VERIFY_PATH}`, {
      method: "POST",
      headers: {
        cookie,
        [SERVICE_AUTH_HEADER]: `Bearer ${serviceBearer}`,
        "x-operia-source-domain": SOURCE_DOMAIN,
        "x-operia-service-id": SERVICE_ID,
      },
    }));
    return response.status === 200;
  }
  return (await authenticateDomainSession(request, env)).ok;
}
