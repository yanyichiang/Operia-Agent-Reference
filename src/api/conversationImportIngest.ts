import { R2ConversationImportRawArchiveStore } from "../memory/import/archiveStore";
import { D1ConversationImportLedger } from "../memory/import/ledger";
import {
  beginPreparedConversationImport,
  finalizePreparedConversationImport,
  inspectPreparedConversationImport,
  PREPARED_IMPORT_MAX_CHUNK_BYTES,
  PreparedConversationImportError,
  putPreparedConversationImportRaw,
  writePreparedConversationImportChunk,
} from "../memory/import/preparedIngest";
import type { PreparedConversationImportChunk, PreparedConversationImportManifest } from "../memory/import/types";
import type { Env } from "../types";
import { authorizeConversationImportPrivileged } from "../memory/import/privilegedAuth";

const BEGIN_BODY_MAX_BYTES = 64 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

async function readBoundedJson<T>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PreparedConversationImportError("prepared_body_too_large", 413);
  if (!request.body) throw new PreparedConversationImportError("prepared_body_required", 422);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("prepared_body_too_large");
      throw new PreparedConversationImportError("prepared_body_too_large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T; }
  catch { throw new PreparedConversationImportError("invalid_prepared_json", 422); }
}

function batchPath(pathname: string): { batchId: string; action: "raw" | "chunks" | "inspect" | "finalize" } | null {
  const match = pathname.match(/^\/v1\/conversation-imports\/privileged\/batches\/(cib_[a-f0-9]{32})\/(raw|chunks|inspect|finalize)$/);
  return match ? { batchId: match[1], action: match[2] as "raw" | "chunks" | "inspect" | "finalize" } : null;
}

export async function handleConversationImportIngestApi(request: Request, env: Env): Promise<Response> {
  if (env.WORKER_ROLE !== "memory") return json({ error: "conversation_import_ingest_not_available" }, 404);
  if (env.CONVERSATION_IMPORT_PRIVILEGED_INGEST_ENABLED?.trim().toLowerCase() !== "true"
    || env.CONVERSATION_IMPORT_ENABLED?.trim().toLowerCase() !== "true") {
    return json({ error: "conversation_import_ingest_disabled" }, 404);
  }
  const namespace = await authorizeConversationImportPrivileged(request, env);
  if (!namespace) return json({ error: "unauthorized" }, 401);
  if (!env.MEMORY_ARCHIVE) return json({ error: "owner_archive_unavailable" }, 503);
  const dependencies = {
    ledger: new D1ConversationImportLedger(env.DB),
    rawArchive: new R2ConversationImportRawArchiveStore(env.MEMORY_ARCHIVE),
  };
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/v1/conversation-imports/privileged/batches/begin") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
      const manifest = await readBoundedJson<PreparedConversationImportManifest>(request, BEGIN_BODY_MAX_BYTES);
      return json(await beginPreparedConversationImport(namespace, idempotencyKey, manifest, dependencies), 202);
    }
    const route = batchPath(url.pathname);
    if (!route) return json({ error: "not_found" }, 404);
    if (request.method === "PUT" && route.action === "raw") {
      if ((request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
        return json({ error: "raw_content_type_required" }, 415);
      }
      const declared = Number(request.headers.get("content-length"));
      if (!Number.isSafeInteger(declared) || declared <= 0) return json({ error: "raw_content_length_required" }, 411);
      return json(await putPreparedConversationImportRaw(namespace, route.batchId, declared, request.body, dependencies), 202);
    }
    if (request.method === "POST" && route.action === "chunks") {
      const chunk = await readBoundedJson<PreparedConversationImportChunk>(request, PREPARED_IMPORT_MAX_CHUNK_BYTES);
      return json(await writePreparedConversationImportChunk(namespace, route.batchId, chunk, dependencies), 202);
    }
    if (request.method === "GET" && route.action === "inspect") {
      return json(await inspectPreparedConversationImport(namespace, route.batchId, dependencies));
    }
    if (request.method === "POST" && route.action === "finalize") {
      if (request.body) {
        const reader = request.body.getReader();
        const first = await reader.read();
        if (!first.done) {
          await reader.cancel("finalize_body_not_allowed");
          return json({ error: "finalize_body_not_allowed" }, 422);
        }
      }
      return json(await finalizePreparedConversationImport(namespace, route.batchId, dependencies));
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    if (error instanceof PreparedConversationImportError) return json({ error: error.code }, error.status);
    return json({ error: "conversation_import_ingest_failed" }, 500);
  }
}
