export type CanonicalImportRole = "owner" | "assistant" | "other" | "system" | "tool" | "unknown";

export type ConversationImportIssueCode =
  | "empty_active_content"
  | "stale_version_selection"
  | "speaker_mapping_required"
  | "timezone_required"
  | "unsupported_source"
  | "invalid_export"
  | "limit_exceeded";

export interface ConversationImportIssue {
  code: ConversationImportIssueCode;
  severity: "warning" | "error";
  count: number;
}

export interface ConversationImportPreviewOptions {
  adapterId?: string;
  timezone?: string | null;
  speakerMap?: Record<string, CanonicalImportRole>;
}

export interface ConversationImportNormalizeOptions extends ConversationImportPreviewOptions {
  namespace: string;
}

export interface ConversationImportPreview {
  schemaVersion: "conversation-import-preview/v1";
  sourceApp: "legacy_chat";
  sourceFormat: "legacy_chats_json_v1";
  adapter: { id: "legacy_chat_chats_v1"; version: "1.0.0"; upstreamCommit: string };
  export: { byteCount: number; blobSha256: string; hashPrefix: string };
  counts: {
    conversations: number;
    messageRevisions: number;
    activeMessages: number;
    alternateRevisions: number;
    groups: number;
    multiVersionGroups: number;
    roles: Record<string, number>;
    activeRoles: Record<string, number>;
    summaries: number;
    quarantinedItems: number;
    reasoningText: number;
    reasoningSegments: number;
    toolEventMessages: number;
    toolEvents: number;
    activeReasoningText: number;
    activeReasoningSegments: number;
    activeToolEventMessages: number;
    activeToolEvents: number;
    emptyActiveContent: number;
    staleVersionSelections: number;
  };
  timestamp: {
    naive: number;
    offsetAware: number;
    missing: number;
    timezone: string | null;
    status: "ready" | "timezone_required";
  };
  mapping: {
    participants: Record<string, number>;
    proposedSpeakerMap: Record<string, CanonicalImportRole>;
    confirmedSpeakerMap: Record<string, CanonicalImportRole> | null;
    status: "ready" | "speaker_mapping_required";
  };
  quarantine: {
    fields: readonly ["reasoningText", "reasoningSegmentsJson", "toolEvents"];
    excludedFromSummary: true;
    excludedFromCandidates: true;
    excludedFromEmbedding: true;
    excludedFromModelInput: true;
    toolArgumentsParsed: false;
  };
  issues: ConversationImportIssue[];
  validation: "valid" | "mapping_required";
  previewDigest: string;
  sideEffects: {
    d1Writes: 0;
    r2Writes: 0;
    vectorizeWrites: 0;
    queueWrites: 0;
    cacheWrites: 0;
    modelFetches: 0;
  };
}

export interface ConversationArchiveV1 {
  schemaVersion: "conversation-archive/v1";
  sourceApp: string;
  adapter: { id: string; version: string };
  export: { blobSha256: string; canonicalSha256: string; byteCount: number };
  mapping: {
    ownerParticipantKey: string;
    assistantParticipantKeys: string[];
    otherParticipantRoles: Record<string, "other" | "unknown">;
    defaultTimezone: string | null;
  };
  conversations: CanonicalImportedConversation[];
  quarantine: QuarantinedImportItem[];
  warnings: ConversationImportIssue[];
}

export type ImportedContentType = "text" | "markdown" | "code" | "attachment_reference" | "mixed" | "unsupported";

export interface CanonicalImportedMessage {
  id: string;
  messageFingerprint: string;
  sourceLocatorHash: string;
  parentLocatorHash: string | null;
  sequence: number;
  sourceOrder: number;
  active: boolean;
  participantKey: string;
  canonicalRole: CanonicalImportRole;
  originalTimestamp: string | null;
  sourceTimezone: string | null;
  resolvedTimezone: string | null;
  occurredAtUtc: string | null;
  timePrecision: "instant" | "date" | "sequence" | "unknown";
  contentType: ImportedContentType;
  normalizedText: string;
  contentSha256: string;
  quarantineStatus: "none" | "excluded" | "quarantined";
  quarantineCode: string | null;
}

export interface CanonicalImportedConversation {
  id: string;
  conversationFingerprint: string;
  sourceLocatorHash: string;
  privateTitle: string | null;
  selectedBranchHash: string;
  sourceOrder: number;
  messages: CanonicalImportedMessage[];
}

export interface QuarantinedImportItem {
  messageLocatorHash: string;
  reasons: Array<"reasoning_text" | "reasoning_segments" | "tool_events">;
  count: number;
}

export interface ConversationImportBatchBinding {
  namespace: string;
  adapterId: string;
  adapterVersion: string;
  blobSha256: string;
  canonicalSha256: string;
  previewDigest: string;
  speakerMapHash: string;
  timezoneMapHash: string;
  requestHash: string;
  idempotencyKeyHash: string;
}

export interface ConversationImportBatchRecord extends ConversationImportBatchBinding {
  id: string;
  rawObjectRef: string;
  rawByteCount?: number;
  status: "creating" | "archived" | "partial" | "failed";
  currentCursor: number;
  messageCount: number;
  conversationCount: number;
  warningCount: number;
  quarantineCount: number;
  errorCode: string | null;
}

export interface ConversationImportCommitResult {
  batchId: string;
  status: "archived" | "partial";
  replayed: boolean;
  resumedFromCursor: number;
  insertedMessages: number;
  reusedMessages: number;
  conversationCount: number;
  messageCount: number;
  rawObjectStored: true;
}

export interface PreparedConversationImportManifest {
  schemaVersion: "conversation-import-prepared/v1";
  adapterId: "legacy_chat_chats_v1";
  adapterVersion: "1.0.0";
  blobSha256: string;
  canonicalSha256: string;
  previewDigest: string;
  speakerMap: Record<string, CanonicalImportRole>;
  speakerMapHash: string;
  timezone: string;
  timezoneMapHash: string;
  byteCount: number;
  messageCount: number;
  conversationCount: number;
  warningCount: number;
  quarantineCount: number;
}

export interface PreparedConversationImportConversation {
  id: string;
  conversationFingerprint: string;
  sourceLocatorHash: string;
  privateTitle: string | null;
  selectedBranchHash: string;
  sourceOrder: number;
  messageCount: number;
  messages: CanonicalImportedMessage[];
}

export interface PreparedConversationImportChunk {
  schemaVersion: "conversation-import-canonical-chunk/v1";
  fromCursor: number;
  toCursor: number;
  chunkHash: string;
  conversations: PreparedConversationImportConversation[];
}
