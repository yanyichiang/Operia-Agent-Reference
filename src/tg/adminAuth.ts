import { authenticate } from "../auth/apiKey";
import { authenticateDomainSession } from "../auth/domainSession";
import type { Env } from "../types";

const COOKIE_NAME = "operia_session";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const encoder = new TextEncoder();

function cookieValue(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function requestWithSessionFlag(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("x-operia-session", "1");
  // authenticateDomainSession only needs URL and headers. Using a GET request avoids
  // consuming the body stream of a mutating request, leaving it intact for the API handler.
  return new Request(request.url, { method: "GET", headers });
}

/**
 * Strict domain-session authorization. This is the only credential class that may
 * access admin HTML shells, bootstrap CSRF tokens, or perform mutations.
 */
export async function authorizeTgDomainSession(request: Request, env: Env): Promise<boolean> {
  const session = await authenticateDomainSession(requestWithSessionFlag(request), env);
  return session.ok;
}

/**
 * Optional debug read authorization. Disabled unless TG_ADMIN_DEBUG_READ_ENABLED is
 * explicitly "true". Never grants access to CSRF tokens or mutating endpoints.
 */
export async function authorizeTgAdminRead(request: Request, env: Env): Promise<boolean> {
  if (await authorizeTgDomainSession(request, env)) return true;
  if (env.TG_ADMIN_DEBUG_READ_ENABLED?.trim().toLowerCase() !== "true") return false;
  const auth = await authenticate(request, env);
  return auth.ok && auth.profile.debug === true;
}

/**
 * Mutation authorization: requires a valid domain session, exact Origin header,
 * exact request origin, and a matching CSRF token bound to that session.
 * Debug API keys are explicitly rejected for mutations.
 */
export async function authorizeTgMutation(request: Request, env: Env): Promise<boolean> {
  if (!MUTATING_METHODS.has(request.method)) return authorizeTgAdminRead(request, env);
  const url = new URL(request.url);
  if (url.origin !== "https://tgbot.example.com") return false;
  if (request.headers.get("origin") !== "https://tgbot.example.com") return false;
  if (!await authorizeTgDomainSession(request, env)) return false;
  const expected = await getAdminCsrfToken(request, env);
  return Boolean(expected && request.headers.get("x-csrf-token") === expected);
}

/**
 * Returns a CSRF token only for requests that already carry a valid domain session.
 * Arbitrary cookies without a valid session do not produce a usable token.
 */
export async function getAdminCsrfToken(request: Request, env: Env): Promise<string | null> {
  if (!env.OPERIA_SESSION_SECRET) return null;
  if (!await authorizeTgDomainSession(request, env)) return null;
  const session = cookieValue(request, COOKIE_NAME);
  if (!session) return null;
  return hmac(`tg-admin:${session}`, env.OPERIA_SESSION_SECRET);
}
