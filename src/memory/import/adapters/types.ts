import type { ConversationArchiveV1, ConversationImportNormalizeOptions, ConversationImportPreview, ConversationImportPreviewOptions } from "../types";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AdapterDetection {
  matched: boolean;
  confidence: number;
  sourceFormat?: string;
}

export interface ConversationImportAdapter {
  readonly id: string;
  readonly version: string;
  detect(input: JsonValue): AdapterDetection;
  preview(bytes: Uint8Array, options: ConversationImportPreviewOptions): Promise<ConversationImportPreview>;
  normalize(bytes: Uint8Array, options: ConversationImportNormalizeOptions): Promise<ConversationArchiveV1>;
}
