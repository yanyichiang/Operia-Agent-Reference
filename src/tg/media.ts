export type TelegramMediaIntent = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function directIntent(value: Record<string, unknown>): TelegramMediaIntent | null {
  if (typeof value.mediaRef === "string" && value.mediaRef.startsWith("agent-media:")) {
    return { method: value.kind === "image" ? "sendPhoto" : "sendVoice", media_ref: value.mediaRef };
  }
  const images = Array.isArray(value.images) ? value.images : [];
  const image = record(images[0]);
  if (image && typeof image.url === "string" && image.url.startsWith("https://")) {
    return { method: "sendPhoto", photo: image.url };
  }
  return null;
}

function appendUnique(intents: TelegramMediaIntent[], intent: TelegramMediaIntent | null): void {
  if (!intent) return;
  const identity = typeof intent.media_ref === "string" ? `ref:${intent.media_ref}` : `photo:${String(intent.photo ?? "")}`;
  if (!intents.some((item) => {
    const existing = typeof item.media_ref === "string" ? `ref:${item.media_ref}` : `photo:${String(item.photo ?? "")}`;
    return existing === identity;
  })) intents.push(intent);
}

export function mediaIntentsFromAgentResult(value: unknown): TelegramMediaIntent[] {
  const intents: TelegramMediaIntent[] = [];
  const root = record(value);
  if (!root) return intents;

  appendUnique(intents, directIntent(root));
  const checkpoint = record(root.result) ?? record(root.checkpoint) ?? root;
  appendUnique(intents, directIntent(checkpoint));

  for (const raw of Array.isArray(checkpoint.results) ? checkpoint.results : []) {
    const item = record(raw);
    if (!item || typeof item.payload !== "string") continue;
    try { appendUnique(intents, directIntent(record(JSON.parse(item.payload)) ?? {})); } catch { /* Ignore non-JSON tool data. */ }
  }
  return intents;
}

export function mediaIntentsFromMessages(messages: Array<{ role?: string; content?: unknown }>): TelegramMediaIntent[] {
  const intents: TelegramMediaIntent[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      for (const intent of mediaIntentsFromAgentResult(JSON.parse(message.content))) appendUnique(intents, intent);
    } catch {
      // Tool messages may legitimately contain non-JSON data.
    }
  }
  return intents;
}
