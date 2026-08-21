import type { MessageRecord, OpenAIChatMessage, TokenUsage } from "../types";
import { sha256Hex } from "../utils/hash";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(redactLargeImageContent(content));
}

function redactLargeImageContent(content: unknown[]): unknown[] {
  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const record = part as Record<string, unknown>;

    if (record.type === "image_url" && record.image_url && typeof record.image_url === "object" && !Array.isArray(record.image_url)) {
      const imageUrl = record.image_url as Record<string, unknown>;
      return {
        ...record,
        image_url: {
          ...imageUrl,
          url: redactDataUrl(imageUrl.url),
        },
      };
    }

    if (record.type === "input_image") {
      return {
        ...record,
        image_url: redactDataUrl(record.image_url),
      };
    }

    return part;
  });
}

function redactDataUrl(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    const mediaType = value.slice(5, value.indexOf(";base64,") > 0 ? value.indexOf(";base64,") : undefined);
    return `[${mediaType || "image"} data omitted]`;
  }
  return value;
}

// Stable-hash normalization: trim + collapse whitespace so retrying the same
// (conversationId, role, content) yields an identical hash. The DB id stays
// random; only the hash drops it — that is what makes the hash idempotent.
function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function telegramPublicationRef(source: string, idempotencyKey: string | null | undefined): string | null {
  if (source !== "telegram") return null;
  const match = /^tg:([a-f0-9]{64})(?::|$)/.exec(idempotencyKey?.trim() ?? "");
  return match ? `tg:${match[1]}` : null;
}

export async function saveUserMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
    requestModel: string;
    upstreamModel: string;
    upstreamProvider: string;
    stream: boolean;
    idempotencyKey?: string | null;
    turnOrderKey?: number | null;
    publicationStateV2Enabled?: boolean;
  }
): Promise<string[]> {
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
  const userMessages = lastUserMessage ? [lastUserMessage] : [];
  const ids: string[] = [];

  for (const message of userMessages) {
    const content = contentToText(message.content);
    const hash = await sha256Hex(`${input.conversationId}:${message.role}:${normalizeContent(content)}`);
    const idempotencyHash = input.idempotencyKey
      ? await sha256Hex(`${input.conversationId}:${input.namespace}:user:${input.idempotencyKey}`)
      : null;
    const id = idempotencyHash ? `msg_${idempotencyHash.slice(0, 32)}` : newId("msg");
    ids.push(id);

    await db
      .prepare(
        `${idempotencyHash ? "INSERT OR IGNORE" : "INSERT"} INTO messages (
          id, conversation_id, namespace, role, content, source, client_message_hash,
          upstream_model, upstream_provider, request_model, stream, created_at,
          publication_state,publication_ref,turn_order_key,turn_item_order,publication_resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        "user",
        content,
        input.source,
        hash,
        input.upstreamModel,
        input.upstreamProvider,
        input.requestModel,
        input.stream ? 1 : 0,
        nowIso(),
        input.source === "telegram" && input.publicationStateV2Enabled ? "source_received" : "delivered",
        telegramPublicationRef(input.source,input.idempotencyKey),
        Number.isSafeInteger(input.turnOrderKey) ? input.turnOrderKey : null,
        0,
        nowIso()
      )
      .run();
  }

  return ids;
}

export async function findLatestSavedUserMessageId(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    message: OpenAIChatMessage;
  }
): Promise<string | null> {
  const content = contentToText(input.message.content);
  const hash = await sha256Hex(
    `${input.conversationId}:${input.message.role}:${normalizeContent(content)}`
  );

  const row = await db
    .prepare(
      `SELECT id
       FROM messages
       WHERE conversation_id = ? AND namespace = ? AND role = 'user' AND client_message_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(input.conversationId, input.namespace, hash)
    .first<{ id: string }>();

  return row?.id ?? null;
}

export async function saveAssistantMessage(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    content: string;
    requestModel: string;
    upstreamModel: string;
    provider: string;
    stream: boolean;
    finishReason?: string | null;
    usage?: TokenUsage;
    cacheMode?: string | null;
    cacheTtl?: string | null;
    idempotencyKey?: string | null;
    turnOrderKey?: number | null;
    publicationStateV2Enabled?: boolean;
  }
): Promise<{ id: string; created: boolean }> {
  const idempotencyHash = input.idempotencyKey
    ? await sha256Hex(
      `${input.conversationId}:${input.namespace}:assistant-final:${input.idempotencyKey}`
    )
    : null;
  const id = idempotencyHash ? `msg_${idempotencyHash.slice(0, 32)}` : newId("msg");
  const usage = input.usage || {};
  const insertVerb = idempotencyHash ? "INSERT OR IGNORE" : "INSERT";

  const result = await db
    .prepare(
      `${insertVerb} INTO messages (
        id, conversation_id, namespace, role, content, source, client_message_hash, upstream_model,
        upstream_provider, request_model, stream, finish_reason, token_input,
        token_output, cache_mode, cache_ttl, cache_hit, cache_read_tokens,
        cache_creation_tokens, raw_usage_json, created_at,publication_state,publication_ref,
        turn_order_key,turn_item_order,publication_resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.conversationId,
      input.namespace,
      "assistant",
      input.content,
      input.source,
      idempotencyHash,
      input.upstreamModel,
      input.provider,
      input.requestModel,
      input.stream ? 1 : 0,
      input.finishReason || null,
      usage.prompt_tokens ?? usage.input_tokens ?? null,
      usage.completion_tokens ?? usage.output_tokens ?? null,
      input.cacheMode ?? null,
      input.cacheTtl ?? null,
      typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0 ? 1 : 0,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      JSON.stringify(usage),
      nowIso(),
      input.source === "telegram" && input.publicationStateV2Enabled ? "generated_unconfirmed" : "delivered",
      telegramPublicationRef(input.source,input.idempotencyKey),
      Number.isSafeInteger(input.turnOrderKey) ? input.turnOrderKey : null,
      1,
      input.source === "telegram" && input.publicationStateV2Enabled ? null : nowIso()
    )
    .run();

  return {
    id,
    created: (result.meta?.changes ?? 1) > 0,
  };
}

export type TelegramAssistantPublicationState =
  | "delivered"
  | "delivered_partial"
  | "delivery_unknown"
  | "excluded";

export async function resolveTelegramAssistantPublication(
  db: D1Database,
  input: { batchKey: string; state: TelegramAssistantPublicationState; turnOrderKey?: number | null },
): Promise<Array<{ id: string; conversation_id: string; namespace: string; created: boolean }>> {
  const publicationRef = `tg:${input.batchKey}`;
  const now = nowIso();
  const updated = await db.prepare(`UPDATE messages SET publication_state=?,publication_resolved_at=?,
      turn_order_key=COALESCE(turn_order_key,?),turn_item_order=1
    WHERE source='telegram' AND role='assistant' AND publication_ref=?
      AND publication_state='generated_unconfirmed'
    RETURNING id,conversation_id,namespace`)
    .bind(input.state,now,Number.isSafeInteger(input.turnOrderKey) ? input.turnOrderKey : null,publicationRef)
    .all<{id:string;conversation_id:string;namespace:string}>();

  if (input.state === "delivered") {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO episodic_projections (
          id,namespace,conversation_id,canonical_message_id,role,occurred_at_utc,
          temporal_confidence,vector_id,vector_status,index_version,created_at,updated_at)
        SELECT 'ep_'||m.id,m.namespace,m.conversation_id,m.id,m.role,m.created_at,
          1,'ep_'||m.id,'pending','episodic-v1',m.created_at,?
        FROM messages m WHERE m.publication_ref=? AND m.source='telegram' AND m.role='assistant'
          AND m.publication_state='delivered' AND trim(m.content)<>''`)
        .bind(now,publicationRef),
      db.prepare(`INSERT INTO episodic_fts(projection_id,namespace,content)
        SELECT 'ep_'||m.id,m.namespace,m.content FROM messages m
        WHERE m.publication_ref=? AND m.source='telegram' AND m.role='assistant'
          AND m.publication_state='delivered' AND trim(m.content)<>''
          AND NOT EXISTS (SELECT 1 FROM episodic_fts f WHERE f.projection_id='ep_'||m.id)`)
        .bind(publicationRef),
    ]);
  }
  const changedIds = new Set((updated.results ?? []).map((row) => row.id));
  const rows = await db.prepare(`SELECT id,conversation_id,namespace FROM messages
    WHERE publication_ref=? AND source='telegram' AND role='assistant' AND publication_state=?
    ORDER BY created_at,id`).bind(publicationRef,input.state)
    .all<{id:string;conversation_id:string;namespace:string}>();
  return (rows.results ?? []).map((row) => ({ ...row, created: changedIds.has(row.id) }));
}

export async function getMessagesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MessageRecord[]> {
  if (input.ids.length === 0) return [];

  const placeholders = input.ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT id, conversation_id, namespace, role, content, source, created_at
       FROM messages
       WHERE namespace = ? AND id IN (${placeholders})
         AND publication_state IN ('source_received','delivered')
       ORDER BY created_at ASC`
    )
    .bind(input.namespace, ...input.ids)
    .all<MessageRecord>();

  return result.results ?? [];
}

export async function countMessagesAfterTimestamp(
  db: D1Database,
  namespace: string,
  afterCreatedAt: string | null
): Promise<number> {
  if (!afterCreatedAt) {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE namespace = ? AND role IN ('user', 'assistant')
           AND publication_state IN ('source_received','delivered')`
      )
      .bind(namespace)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE namespace = ? AND role IN ('user', 'assistant')
         AND publication_state IN ('source_received','delivered') AND created_at > ?`
    )
    .bind(namespace, afterCreatedAt)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export async function listMessagesByNamespace(
  db: D1Database,
  namespace: string,
  afterCreatedAt: string | null,
  limit: number
): Promise<MessageRecord[]> {
  let sql = `SELECT id, conversation_id, namespace, role, content, source, created_at
             FROM messages
             WHERE namespace = ? AND role IN ('user', 'assistant')
               AND publication_state IN ('source_received','delivered')`;
  const binds: unknown[] = [namespace];

  if (afterCreatedAt) {
    sql += ` AND created_at > ?`;
    binds.push(afterCreatedAt);
  }

  sql += ` ORDER BY created_at ASC LIMIT ?`;
  binds.push(limit);

  const result = await db.prepare(sql).bind(...binds).all<MessageRecord>();
  return result.results ?? [];
}

export async function listMessagesByNamespaceInRange(
  db: D1Database,
  input: {
    namespace: string;
    startCreatedAt: string;
    endCreatedAt: string;
    afterCreatedAt?: string | null;
    limit: number;
  }
): Promise<MessageRecord[]> {
  let sql = `SELECT id, conversation_id, namespace, role, content, source, created_at
             FROM messages
             WHERE namespace = ?
               AND role IN ('user', 'assistant')
               AND publication_state IN ('source_received','delivered')
               AND created_at >= ?
               AND created_at < ?`;
  const binds: unknown[] = [input.namespace, input.startCreatedAt, input.endCreatedAt];

  if (input.afterCreatedAt) {
    sql += ` AND created_at > ?`;
    binds.push(input.afterCreatedAt);
  }

  sql += ` ORDER BY created_at ASC LIMIT ?`;
  binds.push(input.limit);

  const result = await db.prepare(sql).bind(...binds).all<MessageRecord>();
  return result.results ?? [];
}

export async function saveIngestMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
  }
): Promise<string[]> {
  const ids: string[] = [];

  for (const message of input.messages) {
    const content = contentToText(message.content);
    if (!content) continue;

    const id = newId("msg");
    ids.push(id);

    await db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, namespace, role, content, source, stream, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        message.role,
        content,
        input.source,
        0,
        nowIso()
      )
      .run();
  }

  return ids;
}
