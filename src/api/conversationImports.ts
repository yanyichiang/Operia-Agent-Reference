import { authenticate } from "../auth/apiKey";
import { authenticateDomainSession } from "../auth/domainSession";
import { previewLegacyChatChatsV1, ConversationImportValidationError, LEGACY_CHAT_CHATS_V1_ADAPTER_ID } from "../memory/import/adapters/legacyChatChatsV1";
import { R2ConversationImportRawArchiveStore } from "../memory/import/archiveStore";
import { commitConversationImport, ConversationImportCommitError } from "../memory/import/commit";
import { D1ConversationImportLedger } from "../memory/import/ledger";
import { assertHttpImportByteLength, CONVERSATION_IMPORT_HTTP_MAX_BYTES, ConversationImportLimitError } from "../memory/import/limits";
import type { ConversationImportPreviewOptions } from "../memory/import/types";
import type { AuthResult, Env } from "../types";

const MEMORY_ORIGIN = "https://memory.example.com";
const MULTIPART_OVERHEAD_ALLOWANCE = 512 * 1024;
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function conversationImportCsrfToken(env: Pick<Env, "OPERIA_SESSION_SECRET">): Promise<string | null> {
  if (!env.OPERIA_SESSION_SECRET) return null;
  return hmac(`conversation-import:v1:${MEMORY_ORIGIN}`, env.OPERIA_SESSION_SECRET);
}

async function authorize(request: Request, env: Env): Promise<AuthResult | null> {
  const direct = await authenticate(request, env);
  if (direct.ok) return direct;
  const headers = new Headers(request.headers);
  headers.set("x-operia-session", "1");
  const session = await authenticateDomainSession(new Request(request.clone(), { headers }), env);
  return session.ok ? session : null;
}

async function readBoundedBody(request: Request, maxBytes: number, limitName: string): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("conversation_import_limit_exceeded");
      throw new ConversationImportLimitError(limitName);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readPreviewInput(request: Request): Promise<{ bytes: Uint8Array; options: ConversationImportPreviewOptions }> {
  const contentType = request.headers.get("content-type") || "";
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    const allowance = contentType.toLowerCase().startsWith("multipart/form-data") ? MULTIPART_OVERHEAD_ALLOWANCE : 0;
    if (declaredLength > CONVERSATION_IMPORT_HTTP_MAX_BYTES + allowance) throw new ConversationImportLimitError("http_file_bytes");
  }
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const envelope = await readBoundedBody(request, CONVERSATION_IMPORT_HTTP_MAX_BYTES + MULTIPART_OVERHEAD_ALLOWANCE, "http_multipart_bytes");
    const formRequest = new Request(request.url, { method: "POST", headers: request.headers, body: envelope });
    const form = await formRequest.formData();
    const file: unknown = form.get("file");
    if (typeof file !== "object" || file === null || !("arrayBuffer" in file)) {
      throw new ConversationImportValidationError("invalid_export", "file_required");
    }
    const fileLike = file as { arrayBuffer?: unknown };
    if (typeof fileLike.arrayBuffer !== "function") throw new ConversationImportValidationError("invalid_export", "file_required");
    const bytes = new Uint8Array(await (fileLike.arrayBuffer as () => Promise<ArrayBuffer>)());
    assertHttpImportByteLength(bytes.byteLength);
    const adapterId = typeof form.get("adapter") === "string" ? String(form.get("adapter")) : undefined;
    const timezone = typeof form.get("timezone") === "string" ? String(form.get("timezone")).trim() || null : null;
    const speakerMap = parseSpeakerMap(typeof form.get("speaker_map") === "string" ? String(form.get("speaker_map")) : null);
    return { bytes, options: { adapterId, timezone, speakerMap } };
  }
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ConversationImportValidationError("invalid_export", "content_type_must_be_json_or_multipart");
  }
  const bytes = await readBoundedBody(request, CONVERSATION_IMPORT_HTTP_MAX_BYTES, "http_file_bytes");
  assertHttpImportByteLength(bytes.byteLength);
  return {
    bytes,
    options: {
      adapterId: request.headers.get("x-operia-import-adapter")?.trim() || undefined,
      timezone: request.headers.get("x-operia-import-timezone")?.trim() || null,
      speakerMap: parseSpeakerMap(request.headers.get("x-operia-import-speaker-map")),
    },
  };
}

function parseSpeakerMap(value: string | null): ConversationImportPreviewOptions["speakerMap"] {
  if (!value) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ConversationImportValidationError("invalid_export", "invalid_speaker_map"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConversationImportValidationError("invalid_export", "invalid_speaker_map");
  const allowed = new Set(["owner", "assistant", "other", "system", "tool", "unknown"]);
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([key]) => key === "__proto__" || key === "prototype" || key === "constructor")) {
    throw new ConversationImportValidationError("invalid_export", "unsafe_speaker_map_key");
  }
  if (entries.some(([key, role]) => !key || typeof role !== "string" || !allowed.has(role))) {
    throw new ConversationImportValidationError("invalid_export", "invalid_speaker_map");
  }
  return Object.fromEntries(entries) as ConversationImportPreviewOptions["speakerMap"];
}

function sessionMutationAuthorized(request: Request, expected: string | null): boolean {
  const url = new URL(request.url);
  return url.origin === MEMORY_ORIGIN
    && request.headers.get("origin") === MEMORY_ORIGIN
    && Boolean(expected)
    && request.headers.get("x-csrf-token") === expected;
}

export async function handleConversationImportApi(request: Request, env: Env): Promise<Response> {
  if (env.WORKER_ROLE !== "memory") return json({ error: "conversation_import_not_available" }, 404);
  const url = new URL(request.url);
  const commitRoute = url.pathname === "/v1/conversation-imports";
  if (commitRoute && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (commitRoute && env.CONVERSATION_IMPORT_COMMIT_ENABLED?.trim().toLowerCase() !== "true") {
    return json({ error: "conversation_import_commit_disabled" }, 404);
  }
  if (env.CONVERSATION_IMPORT_ENABLED?.trim().toLowerCase() !== "true") return json({ error: "conversation_import_disabled" }, 404);
  const auth = await authorize(request, env);
  if (!auth || (!auth.profile.debug && !auth.profile.scopes.includes("memory:write"))) return json({ error: "unauthorized" }, 401);
  const session = auth.keyName === "OPERIA_SESSION";
  if (commitRoute) {
    const expectedCsrf = session ? await conversationImportCsrfToken(env) : null;
    if (session && !sessionMutationAuthorized(request, expectedCsrf)) return json({ error: "csrf_or_origin_required" }, 403);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    const previewDigest = request.headers.get("x-operia-preview-digest")?.trim() || "";
    if (idempotencyKey.length < 8) return json({ error: "idempotency_key_required" }, 428);
    if (!/^[a-f0-9]{64}$/.test(previewDigest)) return json({ error: "preview_digest_required" }, 428);
    try {
      const { bytes, options } = await readPreviewInput(request);
      if (options.adapterId && options.adapterId !== LEGACY_CHAT_CHATS_V1_ADAPTER_ID) return json({ error: "unsupported_source" }, 422);
      if (!env.MEMORY_ARCHIVE) return json({ error: "owner_archive_unavailable" }, 503);
      const result = await commitConversationImport({
        bytes,
        namespace: auth.profile.namespace,
        previewDigest,
        idempotencyKey,
        options,
      }, {
        ledger: new D1ConversationImportLedger(env.DB),
        rawArchive: new R2ConversationImportRawArchiveStore(env.MEMORY_ARCHIVE),
      });
      return json(result, result.replayed ? 200 : 202);
    } catch (error) {
      if (error instanceof ConversationImportLimitError) return json({ error: error.code, limit: error.limit }, 413);
      if (error instanceof ConversationImportValidationError) return json({ error: error.code, detail: error.detail }, 422);
      if (error instanceof ConversationImportCommitError) return json({ error: error.code }, error.status);
      return json({ error: "conversation_import_commit_failed" }, 500);
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/conversation-imports/preview/bootstrap") {
    return json({ csrfToken: session ? await conversationImportCsrfToken(env) : null, maxFileBytes: CONVERSATION_IMPORT_HTTP_MAX_BYTES });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/conversation-imports/preview") return json({ error: "method_not_allowed" }, 405);
  if (session) {
    const expected = await conversationImportCsrfToken(env);
    if (!sessionMutationAuthorized(request, expected)) {
      return json({ error: "csrf_or_origin_required" }, 403);
    }
  }
  try {
    const { bytes, options } = await readPreviewInput(request);
    if (options.adapterId && options.adapterId !== LEGACY_CHAT_CHATS_V1_ADAPTER_ID) return json({ error: "unsupported_source" }, 422);
    return json(await previewLegacyChatChatsV1(bytes, options));
  } catch (error) {
    if (error instanceof ConversationImportLimitError) return json({ error: error.code, limit: error.limit }, 413);
    if (error instanceof ConversationImportValidationError) return json({ error: error.code, detail: error.detail }, 422);
    return json({ error: "invalid_export" }, 422);
  }
}

export const handleConversationImportPreview = handleConversationImportApi;
