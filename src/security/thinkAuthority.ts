export type ThinkAuthorityEnvelope = {
  ownerId: string;
  chatId: string;
  scopeKind: "private" | "qa_room";
  threadKey: string;
  authorityRevision: string;
  authorityHash: string;
};

export type ThinkAuthorityRoomBinding = {
  chatId: string;
  ownerId: string;
  threadKey: string;
  revision: number;
};

// Telegram supergroup identifiers are negative decimal strings. Keep the
// signed envelope header-safe without excluding that canonical identifier.
const TOKEN = /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function canonical(input: Omit<ThinkAuthorityEnvelope, "authorityHash">): string {
  for (const value of [input.ownerId, input.chatId, input.threadKey, input.authorityRevision]) {
    if (!TOKEN.test(value)) throw new Error("think_authority_value_invalid");
  }
  return ["think-authority-v1", input.ownerId, input.chatId, input.scopeKind, input.threadKey, input.authorityRevision].join("\0");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signThinkAuthority(
  secret: string,
  input: Omit<ThinkAuthorityEnvelope, "authorityHash">,
): Promise<ThinkAuthorityEnvelope> {
  if (!secret) throw new Error("think_authority_secret_missing");
  return { ...input, authorityHash: await hmacHex(secret, canonical(input)) };
}

export async function verifyThinkAuthority(secret: string, input: ThinkAuthorityEnvelope): Promise<boolean> {
  if (!secret || !/^[a-f0-9]{64}$/.test(input.authorityHash)) return false;
  let expected: string;
  try { expected = await hmacHex(secret, canonical(input)); }
  catch { return false; }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ input.authorityHash.charCodeAt(index);
  return mismatch === 0;
}

export function thinkAuthorityHeaders(input: ThinkAuthorityEnvelope): Record<string, string> {
  return {
    "x-operia-authority-owner-id": input.ownerId,
    "x-operia-authority-chat-id": input.chatId,
    "x-operia-authority-scope-kind": input.scopeKind,
    "x-operia-authority-thread-key": input.threadKey,
    "x-operia-authority-revision": input.authorityRevision,
    "x-operia-authority-hash": input.authorityHash,
  };
}

export function readThinkAuthorityHeaders(headers: Headers): ThinkAuthorityEnvelope | null {
  const ownerId = headers.get("x-operia-authority-owner-id")?.trim() ?? "";
  const chatId = headers.get("x-operia-authority-chat-id")?.trim() ?? "";
  const scopeKind = headers.get("x-operia-authority-scope-kind")?.trim();
  const threadKey = headers.get("x-operia-authority-thread-key")?.trim() ?? "";
  const authorityRevision = headers.get("x-operia-authority-revision")?.trim() ?? "";
  const authorityHash = headers.get("x-operia-authority-hash")?.trim() ?? "";
  if (!ownerId || !chatId || (scopeKind !== "private" && scopeKind !== "qa_room") || !threadKey || !authorityRevision || !authorityHash) return null;
  return { ownerId, chatId, scopeKind, threadKey, authorityRevision, authorityHash };
}

export function thinkAuthorityMatchesScope(input: {
  envelope: ThinkAuthorityEnvelope;
  requestedRecipient: string | null;
  roomRequest: boolean;
  trustedPrivateTelegramRequest: boolean;
  room: ThinkAuthorityRoomBinding | null;
}): boolean {
  const { envelope } = input;
  if (!input.requestedRecipient || envelope.chatId !== input.requestedRecipient) return false;
  if (input.roomRequest) {
    return envelope.scopeKind === "qa_room"
      && input.room?.ownerId === envelope.ownerId
      && input.room.chatId === envelope.chatId
      && input.room.threadKey === envelope.threadKey
      && envelope.authorityRevision === `room-${input.room.revision}`;
  }
  return input.trustedPrivateTelegramRequest
    && envelope.scopeKind === "private"
    && envelope.ownerId === envelope.chatId
    && envelope.threadKey === "private"
    && envelope.authorityRevision === "private-v1";
}
