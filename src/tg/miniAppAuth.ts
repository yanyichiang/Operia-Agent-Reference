import type { Env } from "../types";

const SESSION_COOKIE = "__Host-operia_miniapp_session";
const encoder = new TextEncoder();

export interface TelegramMiniAppIdentity {
  userId: string;
  authDate: number;
  queryId?: string;
  startParam?: string;
  replayKey: string;
}

export interface MiniAppSession {
  version: 1;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== 32 || right.byteLength !== 32) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(left, right);
  // Node's Web Crypto used by the repository's source-level tests does not yet
  // expose the Workers extension. Both inputs are fixed-size digests here.
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export function buildTelegramDataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function validateTelegramInitData(input: {
  initData: string;
  botToken: string;
  ownerUserId: string;
  nowSeconds?: number;
  maxAgeSeconds?: number;
}): Promise<TelegramMiniAppIdentity | null> {
  if (!input.initData || input.initData.length > 8192) return null;
  const params = new URLSearchParams(input.initData);
  const providedHash = hexToBytes(params.get("hash") || "");
  const authDate = Number(params.get("auth_date"));
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = Math.min(Math.max(Math.floor(input.maxAgeSeconds ?? 300), 60), 900);
  if (!providedHash || !Number.isInteger(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > maxAgeSeconds) return null;

  const webAppSecret = await hmac(encoder.encode("WebAppData"), input.botToken);
  const expectedHash = await hmac(webAppSecret, buildTelegramDataCheckString(params));
  if (!timingSafeEqual(providedHash, expectedHash)) return null;

  let user: { id?: number | string; is_bot?: boolean };
  try {
    user = JSON.parse(params.get("user") || "{}") as { id?: number | string; is_bot?: boolean };
  } catch {
    return null;
  }
  const userId = String(user.id ?? "");
  if (!/^\d{1,20}$/.test(userId) || user.is_bot === true || userId !== input.ownerUserId) return null;

  return {
    userId,
    authDate,
    ...(params.get("query_id") ? { queryId: params.get("query_id")! } : {}),
    ...(params.get("start_param") ? { startParam: params.get("start_param")! } : {}),
    replayKey: await sha256Base64Url(`${params.get("hash")}:${authDate}:${userId}`),
  };
}

function cookieValue(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

async function signSessionPayload(payload: string, secret: string): Promise<string> {
  return bytesToBase64Url(await hmac(encoder.encode(secret), payload));
}

export async function createMiniAppSession(userId: string, secret: string, ttlSeconds: number): Promise<{
  session: MiniAppSession;
  token: string;
}> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const session: MiniAppSession = {
    version: 1,
    userId,
    issuedAt,
    expiresAt: issuedAt + Math.min(Math.max(Math.floor(ttlSeconds), 300), 1800),
    nonce: crypto.randomUUID(),
  };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(session)));
  return { session, token: `${payload}.${await signSessionPayload(payload, secret)}` };
}

export async function verifyMiniAppSessionToken(token: string, secret: string): Promise<MiniAppSession | null> {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const provided = base64UrlToBytes(signature);
  const expected = await hmac(encoder.encode(secret), payload);
  if (!provided || !timingSafeEqual(provided, expected)) return null;
  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) return null;

  let session: MiniAppSession;
  try {
    session = JSON.parse(new TextDecoder().decode(payloadBytes)) as MiniAppSession;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    session.version !== 1 || !/^\d{1,20}$/.test(session.userId) ||
    !Number.isInteger(session.issuedAt) || !Number.isInteger(session.expiresAt) ||
    session.expiresAt <= now || session.issuedAt > now + 60 || session.expiresAt - session.issuedAt > 1800 ||
    typeof session.nonce !== "string" || session.nonce.length > 64
  ) return null;
  return session;
}

export async function authorizeMiniAppSession(request: Request, env: Env): Promise<MiniAppSession | null> {
  const secret = env.TG_MINIAPP_SESSION_SECRET?.trim();
  const ownerUserId = env.TG_AGENT_OWNER_ID?.trim();
  const token = cookieValue(request, SESSION_COOKIE);
  if (!secret || !ownerUserId || !token) return null;
  const session = await verifyMiniAppSessionToken(token, secret);
  return session?.userId === ownerUserId ? session : null;
}

export async function miniAppCsrfToken(session: MiniAppSession, secret: string): Promise<string> {
  return signSessionPayload(`miniapp-csrf:${session.nonce}:${session.expiresAt}`, secret);
}

export async function miniAppSessionLocator(session: MiniAppSession, secret: string): Promise<string> {
  return signSessionPayload(`artifact-session:${session.nonce}:${session.expiresAt}`, secret);
}

export async function validateMiniAppCsrfToken(session: MiniAppSession, secret: string, provided: string | null): Promise<boolean> {
  if (!provided || provided.length > 128) return false;
  const [actual, expected] = await Promise.all([
    Promise.resolve(base64UrlToBytes(provided)),
    hmac(encoder.encode(secret), `miniapp-csrf:${session.nonce}:${session.expiresAt}`),
  ]);
  return Boolean(actual && timingSafeEqual(actual, expected));
}

export function miniAppSessionCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearMiniAppSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
