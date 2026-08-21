import { authenticateDomainSession, type DomainSessionEnv } from "../auth/domainSession";

const ORIGIN = "https://agent.example.com";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const encoder = new TextEncoder();

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function agentCsrfToken(_request: Request, env: DomainSessionEnv): Promise<string | null> {
  if (!env.OPERIA_SESSION_SECRET) return null;
  return hmac(`agent-admin:v2:${ORIGIN}`, env.OPERIA_SESSION_SECRET);
}

export async function authorizeAgentBrowser(request: Request, env: DomainSessionEnv): Promise<boolean> {
  const headers = new Headers(request.headers);
  headers.set("x-operia-session", "1");
  return (await authenticateDomainSession(new Request(request.clone(), { headers }), env)).ok;
}

export async function authorizeAgentMutation(request: Request, env: DomainSessionEnv): Promise<boolean> {
  if (!MUTATING_METHODS.has(request.method)) return authorizeAgentBrowser(request, env);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || request.headers.get("origin") !== ORIGIN) {
    console.warn("agent mutation rejected", { reason: "origin", urlOrigin: url.origin, requestOrigin: request.headers.get("origin") });
    return false;
  }
  if (!await authorizeAgentBrowser(request, env)) {
    console.warn("agent mutation rejected", { reason: "session" });
    return false;
  }
  const expected = await agentCsrfToken(request, env);
  const provided = request.headers.get("x-csrf-token");
  const authorized = Boolean(expected && provided === expected);
  if (!authorized) console.warn("agent mutation rejected", { reason: "csrf", expectedPresent: Boolean(expected), providedPresent: Boolean(provided) });
  return authorized;
}
