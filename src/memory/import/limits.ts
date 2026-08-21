export const CONVERSATION_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
// Buffered Worker preview keeps raw chunks, decoded text, and the parsed graph live together.
// Keep this materially below the offline limit until Gate B provides streaming/chunked parsing.
export const CONVERSATION_IMPORT_HTTP_MAX_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_IMPORT_MAX_CONVERSATIONS = 1_000;
export const CONVERSATION_IMPORT_MAX_MESSAGES = 100_000;
export const CONVERSATION_IMPORT_MAX_MESSAGE_CHARS = 200_000;
export const CONVERSATION_IMPORT_MAX_QUARANTINED_ITEMS = 2_000;
export const CONVERSATION_IMPORT_MAX_JSON_DEPTH = 80;

export class ConversationImportLimitError extends Error {
  readonly code = "limit_exceeded";

  constructor(readonly limit: string) {
    super(`conversation import limit exceeded: ${limit}`);
  }
}

export function assertImportByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new ConversationImportLimitError("invalid_byte_length");
  if (byteLength > CONVERSATION_IMPORT_MAX_BYTES) throw new ConversationImportLimitError("file_bytes");
}

export function assertHttpImportByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new ConversationImportLimitError("invalid_byte_length");
  if (byteLength > CONVERSATION_IMPORT_HTTP_MAX_BYTES) throw new ConversationImportLimitError("http_file_bytes");
}
