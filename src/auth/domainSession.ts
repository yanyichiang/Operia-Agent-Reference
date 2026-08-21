import { KEY_PROFILES } from "../config/keyProfiles";
import type { AuthResult } from "../types";

export type DomainSessionEnv = {
  OPERIA_SESSION_SECRET?: string;
  ADMIN_EMAIL_ALLOWLIST?: string;
};

interface DomainSessionPayload {
  email?: string;
  method?: string;
  iat?: number;
  exp?: number;
}

const SESSION_COOKIE_NAME = "operia_session";
const DEFAULT_ADMIN_EMAIL = "admin@example.com"; // Reference only; real deployment uses ADMIN_EMAIL_ALLOWLIST env var
const textEncoder = new TextEncoder();

export async function authenticateDomainSession(request: Request, env: DomainSessionEnv): Promise<AuthResult | { ok: false }> {
  if (!env.OPERIA_SESSION_SECRET) return { ok: false };
  if (request.headers.get("x-operia-session") !== "1") return { ok: false };

  const cookie = getCookie(request, SESSION_COOKIE_NAME);
  if (!cookie) return { ok: false };

  const [encodedPayload, signature] = cookie.split(".");
  if (!encodedPayload || !signature) return { ok: false };

  const expectedSignature = await signSession(encodedPayload, env.OPERIA_SESSION_SECRET);
  if (!constantTimeEqual(signature, expectedSignature)) return { ok: false };

  const payload = parsePayload(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (!payload?.exp || payload.exp <= now) return { ok: false };
  if (!payload.iat || payload.iat > now + 60 || payload.iat < now - 30 * 24 * 60 * 60 || payload.exp <= payload.iat) return { ok: false };

  const email = payload.email?.toLowerCase();
  if (!email || !getAllowedAdminEmails(env).includes(email)) return { ok: false };

  return { ok: true, profile: KEY_PROFILES.debug, keyName: "OPERIA_SESSION" };
}

function getAllowedAdminEmails(env: DomainSessionEnv): string[] {
  return (env.ADMIN_EMAIL_ALLOWLIST || DEFAULT_ADMIN_EMAIL)
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function getCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function signSession(encodedPayload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(encodedPayload));
  return base64UrlEncode(new Uint8Array(signature));
}

function parsePayload(encodedPayload: string): DomainSessionPayload | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as DomainSessionPayload;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}
