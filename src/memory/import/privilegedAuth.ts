import type { Env } from "../../types";

export const CONVERSATION_IMPORT_MEMORY_ORIGIN = "https://memory.example.com";

const encoder = new TextEncoder();

async function sameSecret(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function authorizeConversationImportPrivileged(request: Request, env: Env): Promise<string | null> {
  const url = new URL(request.url);
  const accessAssertion = request.headers.get("cf-access-jwt-assertion")?.trim() || "";
  if (url.origin !== CONVERSATION_IMPORT_MEMORY_ORIGIN || request.headers.has("x-operia-session")
    || ((request.headers.has("origin") || request.headers.has("cookie")) && !accessAssertion)) return null;
  const namespace = env.CONVERSATION_IMPORT_INGEST_NAMESPACE?.trim();
  const expected = env.CONVERSATION_IMPORT_INGEST_BEARER;
  const authorization = request.headers.get("x-operia-ingest-bearer")
    || request.headers.get("x-operia-ingest-authorization")
    || request.headers.get("authorization") || "";
  const provided = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!namespace || !expected || !provided || request.headers.get("x-operia-ingest-namespace") !== namespace) return null;
  return await sameSecret(provided, expected) ? namespace : null;
}
