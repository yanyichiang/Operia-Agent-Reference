import { canonicalJson, domainSeparatedHash, sha256Hex } from "../hashes";
import {
  assertImportByteLength,
  CONVERSATION_IMPORT_MAX_CONVERSATIONS,
  CONVERSATION_IMPORT_MAX_JSON_DEPTH,
  CONVERSATION_IMPORT_MAX_MESSAGE_CHARS,
  CONVERSATION_IMPORT_MAX_MESSAGES,
  CONVERSATION_IMPORT_MAX_QUARANTINED_ITEMS,
  ConversationImportLimitError,
} from "../limits";
import type {
  CanonicalImportedConversation,
  CanonicalImportedMessage,
  CanonicalImportRole,
  ConversationArchiveV1,
  ConversationImportIssue,
  ConversationImportNormalizeOptions,
  ConversationImportPreview,
  ConversationImportPreviewOptions,
  ImportedContentType,
  QuarantinedImportItem,
} from "../types";
import type { AdapterDetection, ConversationImportAdapter, JsonValue } from "./types";

export const LEGACY_CHAT_CHATS_V1_ADAPTER_ID = "legacy_chat_chats_v1" as const;
export const LEGACY_CHAT_CHATS_V1_ADAPTER_VERSION = "1.0.0" as const;
export const LEGACY_CHAT_UPSTREAM_COMMIT = "<UPSTREAM_COMMIT>";

type UnknownRecord = Record<string, unknown>;
type LegacyChatMessage = UnknownRecord & { id: string; conversationId: string; role: string; content: string; groupId?: string; timestamp?: string; version: number };
type LegacyChatConversation = UnknownRecord & { id: string; messageIds: string[]; versionSelections: Record<string, number> };

export class ConversationImportValidationError extends Error {
  constructor(readonly code: "invalid_export" | "unsupported_source", readonly detail: string) {
    super(`${code}:${detail}`);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnsafeKeys(value: unknown, depth = 0): void {
  if (depth > CONVERSATION_IMPORT_MAX_JSON_DEPTH) throw new ConversationImportLimitError("json_depth");
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeKeys(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new ConversationImportValidationError("invalid_export", "unsafe_key");
    }
    rejectUnsafeKeys(item, depth + 1);
  }
}

function decodeStrictJson(bytes: Uint8Array): UnknownRecord {
  assertImportByteLength(bytes.byteLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ConversationImportValidationError("invalid_export", "invalid_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConversationImportValidationError("invalid_export", "invalid_json");
  }
  if (!isRecord(parsed)) throw new ConversationImportValidationError("invalid_export", "root_not_object");
  rejectUnsafeKeys(parsed);
  return parsed;
}

function stringField(record: UnknownRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new ConversationImportValidationError("invalid_export", `invalid_${field}`);
  return value;
}

function parseExport(root: UnknownRecord): { conversations: LegacyChatConversation[]; messages: LegacyChatMessage[]; toolEvents: UnknownRecord } {
  if (root.version !== 1 || !Array.isArray(root.conversations) || !Array.isArray(root.messages)) {
    throw new ConversationImportValidationError("unsupported_source", "legacy_chat_chats_v1_structure_required");
  }
  if (root.conversations.length > CONVERSATION_IMPORT_MAX_CONVERSATIONS) throw new ConversationImportLimitError("conversations");
  if (root.messages.length > CONVERSATION_IMPORT_MAX_MESSAGES) throw new ConversationImportLimitError("messages");
  const conversationIds = new Set<string>();
  const conversations = root.conversations.map((raw): LegacyChatConversation => {
    if (!isRecord(raw)) throw new ConversationImportValidationError("invalid_export", "invalid_conversation");
    const id = stringField(raw, "id");
    if (conversationIds.has(id)) throw new ConversationImportValidationError("invalid_export", "duplicate_conversation_id");
    conversationIds.add(id);
    if (!Array.isArray(raw.messageIds) || raw.messageIds.some((item) => typeof item !== "string")) {
      throw new ConversationImportValidationError("invalid_export", "invalid_message_ids");
    }
    if (raw.versionSelections !== undefined && !isRecord(raw.versionSelections)) {
      throw new ConversationImportValidationError("invalid_export", "invalid_version_selections");
    }
    const selectionEntries = Object.entries(isRecord(raw.versionSelections) ? raw.versionSelections : {});
    if (selectionEntries.some(([, version]) => !Number.isInteger(version))) {
      throw new ConversationImportValidationError("invalid_export", "invalid_version_selection");
    }
    const versionSelections = Object.fromEntries(selectionEntries) as Record<string, number>;
    return { ...raw, id, messageIds: raw.messageIds as string[], versionSelections };
  });
  const messageIds = new Set<string>();
  const messages = root.messages.map((raw): LegacyChatMessage => {
    if (!isRecord(raw)) throw new ConversationImportValidationError("invalid_export", "invalid_message");
    const id = stringField(raw, "id");
    if (messageIds.has(id)) throw new ConversationImportValidationError("invalid_export", "duplicate_message_id");
    messageIds.add(id);
    const conversationId = stringField(raw, "conversationId");
    const role = stringField(raw, "role");
    const version = typeof raw.version === "number" && Number.isInteger(raw.version) ? raw.version : 1;
    if (typeof raw.content !== "string") throw new ConversationImportValidationError("invalid_export", "invalid_content");
    if (raw.content.length > CONVERSATION_IMPORT_MAX_MESSAGE_CHARS) throw new ConversationImportLimitError("message_chars");
    return { ...raw, id, conversationId, role, content: raw.content, groupId: typeof raw.groupId === "string" ? raw.groupId : undefined, timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined, version };
  });
  const parsedMessageById = new Map(messages.map((message) => [message.id, message]));
  const listedMessageIds = new Set<string>();
  for (const conversation of conversations) {
    for (const messageId of conversation.messageIds) {
      if (!messageIds.has(messageId)) throw new ConversationImportValidationError("invalid_export", "orphan_message_reference");
      if (listedMessageIds.has(messageId)) throw new ConversationImportValidationError("invalid_export", "duplicate_message_reference");
      listedMessageIds.add(messageId);
      if (parsedMessageById.get(messageId)?.conversationId !== conversation.id) {
        throw new ConversationImportValidationError("invalid_export", "conversation_message_mismatch");
      }
    }
  }
  for (const message of messages) {
    if (!conversationIds.has(message.conversationId)) throw new ConversationImportValidationError("invalid_export", "orphan_conversation_reference");
    if (!listedMessageIds.has(message.id)) throw new ConversationImportValidationError("invalid_export", "unlisted_root_message");
  }
  if (root.toolEvents !== undefined && !isRecord(root.toolEvents)) throw new ConversationImportValidationError("invalid_export", "invalid_tool_events");
  const toolEvents = isRecord(root.toolEvents) ? root.toolEvents : {};
  for (const [messageId, events] of Object.entries(toolEvents)) {
    if (!messageIds.has(messageId)) throw new ConversationImportValidationError("invalid_export", "orphan_tool_event");
    if (!Array.isArray(events)) throw new ConversationImportValidationError("invalid_export", "invalid_tool_event_list");
  }
  return { conversations, messages, toolEvents };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] || 0) + 1;
}

function isOffsetAware(timestamp: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function contentTypeFor(text: string): ImportedContentType {
  if (/```/.test(text)) return "code";
  if (/(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s)|\[[^\]]+\]\([^)]+\)/.test(text)) return "markdown";
  return "text";
}

function timezoneWallParts(epochMs: number, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return ["year", "month", "day", "hour", "minute", "second"].map((key) => Number(byType[key]));
}

function timezoneOffsetMs(epochMs: number, timezone: string): number {
  const wall = timezoneWallParts(epochMs, timezone);
  const wholeSecondEpoch = Math.floor(epochMs / 1000) * 1000;
  return Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]) - wholeSecondEpoch;
}

function resolveTimestamp(timestamp: string | undefined, timezone: string | null): {
  occurredAtUtc: string | null;
  resolvedTimezone: string | null;
  precision: "instant" | "date" | "sequence" | "unknown";
} {
  if (!timestamp) return { occurredAtUtc: null, resolvedTimezone: null, precision: "sequence" };
  if (isOffsetAware(timestamp)) {
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.getTime())) throw new ConversationImportValidationError("invalid_export", "invalid_timestamp");
    return { occurredAtUtc: parsed.toISOString(), resolvedTimezone: null, precision: "instant" };
  }
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
  if (!match || !timezone) throw new ConversationImportValidationError("invalid_export", "unresolved_naive_timestamp");
  const desired = match.slice(1, 7).map((part, index) => index === 5 && part === undefined ? 0 : Number(part));
  const milliseconds = Number(`${match[7] || ""}000`.slice(0, 3));
  const wallAsUtc = Date.UTC(desired[0], desired[1] - 1, desired[2], desired[3], desired[4], desired[5], milliseconds);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) offsets.add(timezoneOffsetMs(wallAsUtc + hours * 60 * 60 * 1000, timezone));
  const candidates = [...offsets]
    .map((offset) => wallAsUtc - offset)
    .filter((candidate) => timezoneWallParts(candidate, timezone).every((part, index) => part === desired[index]));
  const distinctCandidates = [...new Set(candidates)];
  if (distinctCandidates.length === 0) throw new ConversationImportValidationError("invalid_export", "nonexistent_local_time");
  if (distinctCandidates.length > 1) throw new ConversationImportValidationError("invalid_export", "ambiguous_local_time");
  return { occurredAtUtc: new Date(distinctCandidates[0]).toISOString(), resolvedTimezone: timezone, precision: "instant" };
}

function isValidTimezone(timezone: string | null | undefined): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function eventCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function selectActive(
  conversations: LegacyChatConversation[],
  messageById: Map<string, LegacyChatMessage>,
): { active: Set<string>; groups: number; multiVersionGroups: number; staleSelections: number } {
  const active = new Set<string>();
  let groups = 0;
  let multiVersionGroups = 0;
  let staleSelections = 0;
  for (const conversation of conversations) {
    const grouped = new Map<string, LegacyChatMessage[]>();
    for (const messageId of conversation.messageIds) {
      const message = messageById.get(messageId);
      if (!message) continue;
      const groupKey = message.groupId || message.id;
      const revisions = grouped.get(groupKey) || [];
      revisions.push(message);
      grouped.set(groupKey, revisions);
    }
    groups += grouped.size;
    for (const selectedGroupId of Object.keys(conversation.versionSelections)) {
      if (!grouped.has(selectedGroupId)) staleSelections += 1;
    }
    for (const [groupId, revisions] of grouped) {
      if (revisions.length > 1) multiVersionGroups += 1;
      const selectedVersion = conversation.versionSelections[groupId];
      const selected = selectedVersion === undefined ? undefined : revisions.find((revision) => revision.version === selectedVersion);
      if (selectedVersion !== undefined && !selected) staleSelections += 1;
      active.add((selected || revisions[revisions.length - 1]).id);
    }
  }
  return { active, groups, multiVersionGroups, staleSelections };
}

export function detectLegacyChatChatsV1(input: JsonValue): AdapterDetection {
  const matched = isRecord(input) && input.version === 1 && Array.isArray(input.conversations) && Array.isArray(input.messages);
  return { matched, confidence: matched ? 1 : 0, sourceFormat: matched ? "legacy_chats_json_v1" : undefined };
}

export async function previewLegacyChatChatsV1(bytes: Uint8Array, options: ConversationImportPreviewOptions = {}): Promise<ConversationImportPreview> {
  if (options.speakerMap) rejectUnsafeKeys(options.speakerMap);
  const root = decodeStrictJson(bytes);
  const { conversations, messages, toolEvents } = parseExport(root);
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const selection = selectActive(conversations, messageById);
  const roles: Record<string, number> = {};
  const activeRoles: Record<string, number> = {};
  let summaries = 0;
  let reasoningText = 0;
  let reasoningSegments = 0;
  let toolEventMessages = 0;
  let toolEventTotal = 0;
  let activeReasoningText = 0;
  let activeReasoningSegments = 0;
  let activeToolEventMessages = 0;
  let activeToolEvents = 0;
  let emptyActiveContent = 0;
  let naive = 0;
  let offsetAware = 0;
  let missing = 0;
  for (const conversation of conversations) if (typeof conversation.summary === "string" && conversation.summary.length > 0) summaries += 1;
  for (const message of messages) {
    const isActive = selection.active.has(message.id);
    increment(roles, message.role);
    if (isActive) increment(activeRoles, message.role);
    if (typeof message.reasoningText === "string") {
      reasoningText += 1;
      if (isActive) activeReasoningText += 1;
    }
    if (typeof message.reasoningSegmentsJson === "string") {
      reasoningSegments += 1;
      if (isActive) activeReasoningSegments += 1;
    }
    const count = eventCount(toolEvents[message.id]);
    if (count > 0) {
      toolEventMessages += 1;
      toolEventTotal += count;
      if (isActive) {
        activeToolEventMessages += 1;
        activeToolEvents += count;
      }
    }
    if (!isActive) continue;
    if (message.content.length === 0) emptyActiveContent += 1;
    if (!message.timestamp) missing += 1;
    else if (isOffsetAware(message.timestamp)) offsetAware += 1;
    else naive += 1;
  }
  const quarantinedItems = reasoningText + reasoningSegments + toolEventMessages;
  if (quarantinedItems > CONVERSATION_IMPORT_MAX_QUARANTINED_ITEMS) throw new ConversationImportLimitError("quarantined_items");
  const timezone = isValidTimezone(options.timezone) ? options.timezone : null;
  const archivedNaive = messages.filter((message) => message.timestamp && !isOffsetAware(message.timestamp)).length;
  const timezoneRequired = archivedNaive > 0 && !timezone;
  for (const message of messages) {
    if (!message.timestamp) continue;
    if (isOffsetAware(message.timestamp)) resolveTimestamp(message.timestamp, null);
    else if (timezone) resolveTimestamp(message.timestamp, timezone);
  }
  const proposedSpeakerMap: Record<string, CanonicalImportRole> = Object.fromEntries(
    Object.keys(roles).map((role): [string, CanonicalImportRole] => [role, role === "user" ? "owner" : role === "assistant" ? "assistant" : "unknown"]),
  );
  const confirmedSpeakerMap = options.speakerMap || null;
  const ownerMappings = Object.values(confirmedSpeakerMap || {}).filter((role) => role === "owner").length;
  const observedRoles = Object.keys(roles);
  const speakerMappingReady = ownerMappings === 1
    && (!observedRoles.includes("user") || confirmedSpeakerMap?.user === "owner")
    && (!observedRoles.includes("assistant") || confirmedSpeakerMap?.assistant === "assistant")
    && observedRoles.every((role) => confirmedSpeakerMap?.[role] !== undefined)
    && Object.keys(confirmedSpeakerMap || {}).every((role) => observedRoles.includes(role));
  const issues: ConversationImportIssue[] = [];
  if (selection.staleSelections) issues.push({ code: "stale_version_selection", severity: "warning", count: selection.staleSelections });
  if (emptyActiveContent) issues.push({ code: "empty_active_content", severity: "warning", count: emptyActiveContent });
  if (timezoneRequired) issues.push({ code: "timezone_required", severity: "error", count: archivedNaive });
  if (!speakerMappingReady) issues.push({ code: "speaker_mapping_required", severity: "error", count: Object.keys(roles).length });
  const blobSha256 = await sha256Hex(bytes);
  const counts = {
    conversations: conversations.length,
    messageRevisions: messages.length,
    activeMessages: selection.active.size,
    alternateRevisions: messages.length - selection.active.size,
    groups: selection.groups,
    multiVersionGroups: selection.multiVersionGroups,
    roles,
    activeRoles,
    summaries,
    quarantinedItems,
    reasoningText,
    reasoningSegments,
    toolEventMessages,
    toolEvents: toolEventTotal,
    activeReasoningText,
    activeReasoningSegments,
    activeToolEventMessages,
    activeToolEvents,
    emptyActiveContent,
    staleVersionSelections: selection.staleSelections,
  };
  const digestPayload = {
    blobSha256,
    adapter: `${LEGACY_CHAT_CHATS_V1_ADAPTER_ID}@${LEGACY_CHAT_CHATS_V1_ADAPTER_VERSION}`,
    options: { timezone, speakerMap: options.speakerMap || null },
    counts,
    issues,
  };
  const previewDigest = await domainSeparatedHash("operia-import-preview-v1", [digestPayload]);
  return {
    schemaVersion: "conversation-import-preview/v1",
    sourceApp: "legacy_chat",
    sourceFormat: "legacy_chats_json_v1",
    adapter: { id: LEGACY_CHAT_CHATS_V1_ADAPTER_ID, version: LEGACY_CHAT_CHATS_V1_ADAPTER_VERSION, upstreamCommit: LEGACY_CHAT_UPSTREAM_COMMIT },
    export: { byteCount: bytes.byteLength, blobSha256, hashPrefix: blobSha256.slice(0, 16) },
    counts,
    timestamp: { naive, offsetAware, missing, timezone, status: timezoneRequired ? "timezone_required" : "ready" },
    mapping: {
      participants: roles,
      proposedSpeakerMap,
      confirmedSpeakerMap,
      status: speakerMappingReady ? "ready" : "speaker_mapping_required",
    },
    quarantine: {
      fields: ["reasoningText", "reasoningSegmentsJson", "toolEvents"],
      excludedFromSummary: true,
      excludedFromCandidates: true,
      excludedFromEmbedding: true,
      excludedFromModelInput: true,
      toolArgumentsParsed: false,
    },
    issues,
    validation: timezoneRequired || !speakerMappingReady ? "mapping_required" : "valid",
    previewDigest,
    sideEffects: { d1Writes: 0, r2Writes: 0, vectorizeWrites: 0, queueWrites: 0, cacheWrites: 0, modelFetches: 0 },
  };
}

export async function normalizeLegacyChatChatsV1(bytes: Uint8Array, options: ConversationImportNormalizeOptions): Promise<ConversationArchiveV1> {
  const preview = await previewLegacyChatChatsV1(bytes, options);
  if (preview.validation !== "valid" || !options.speakerMap || !preview.timestamp.timezone && preview.timestamp.naive > 0) {
    throw new ConversationImportValidationError("invalid_export", "confirmed_mapping_required");
  }
  const root = decodeStrictJson(bytes);
  const { conversations, messages, toolEvents } = parseExport(root);
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const selection = selectActive(conversations, messageById);
  const canonicalConversations: CanonicalImportedConversation[] = [];
  const quarantine: QuarantinedImportItem[] = [];
  for (const [conversationOrder, conversation] of conversations.entries()) {
    const sourceLocatorHash = await domainSeparatedHash("operia-import-source-conversation-v1", [conversation.id]);
    const conversationFingerprint = await domainSeparatedHash("operia-import-conversation-v1", [options.namespace, "legacy_chat", sourceLocatorHash]);
    const activeLocators: string[] = [];
    const canonicalMessages: CanonicalImportedMessage[] = [];
    let parentLocatorHash: string | null = null;
    for (const [sourceOrder, sourceMessageId] of conversation.messageIds.entries()) {
      const message = messageById.get(sourceMessageId)!;
      const active = selection.active.has(message.id);
      const messageLocatorHash = await domainSeparatedHash("operia-import-source-message-v1", [message.id]);
      if (active) activeLocators.push(messageLocatorHash);
      const normalizedText = normalizeVisibleText(message.content);
      const contentSha256 = await sha256Hex(normalizedText);
      const timestamp = resolveTimestamp(message.timestamp, preview.timestamp.timezone);
      const canonicalRole = options.speakerMap[message.role] || "unknown";
      const contentType = contentTypeFor(normalizedText);
      const quarantineReasons: QuarantinedImportItem["reasons"] = [];
      if (typeof message.reasoningText === "string") quarantineReasons.push("reasoning_text");
      if (typeof message.reasoningSegmentsJson === "string") quarantineReasons.push("reasoning_segments");
      const messageToolEvents = toolEvents[message.id] as unknown[] | undefined;
      if (messageToolEvents?.length) quarantineReasons.push("tool_events");
      if (quarantineReasons.length) {
        quarantine.push({ messageLocatorHash, reasons: quarantineReasons, count: quarantineReasons.includes("tool_events") ? (messageToolEvents?.length || 0) + quarantineReasons.length - 1 : quarantineReasons.length });
      }
      const messageFingerprint = await domainSeparatedHash("operia-import-message-v1", [
        options.namespace,
        "legacy_chat",
        conversationFingerprint,
        messageLocatorHash,
        canonicalRole,
        message.timestamp || null,
        timestamp.occurredAtUtc,
        contentType,
        contentSha256,
      ]);
      canonicalMessages.push({
        id: `cim_${messageFingerprint.slice(0, 28)}`,
        messageFingerprint,
        sourceLocatorHash: messageLocatorHash,
        parentLocatorHash,
        sequence: sourceOrder,
        sourceOrder,
        active,
        participantKey: message.role,
        canonicalRole,
        originalTimestamp: message.timestamp || null,
        sourceTimezone: isOffsetAware(message.timestamp || "") ? "source_offset" : null,
        resolvedTimezone: timestamp.resolvedTimezone,
        occurredAtUtc: timestamp.occurredAtUtc,
        timePrecision: timestamp.precision,
        contentType,
        normalizedText,
        contentSha256,
        quarantineStatus: active && normalizedText.length === 0 ? "excluded" : "none",
        quarantineCode: active && normalizedText.length === 0 ? "empty_active_content" : null,
      });
      if (active) parentLocatorHash = messageLocatorHash;
    }
    const selectedBranchHash = await domainSeparatedHash("operia-import-selected-branch-v1", activeLocators);
    canonicalConversations.push({
      id: `cic_${conversationFingerprint.slice(0, 28)}`,
      conversationFingerprint,
      sourceLocatorHash,
      privateTitle: typeof conversation.title === "string" ? normalizeVisibleText(conversation.title) : null,
      selectedBranchHash,
      sourceOrder: conversationOrder,
      messages: canonicalMessages,
    });
  }
  const mapping = {
    ownerParticipantKey: Object.entries(options.speakerMap).find(([, role]) => role === "owner")![0],
    assistantParticipantKeys: Object.entries(options.speakerMap).filter(([, role]) => role === "assistant").map(([key]) => key),
    otherParticipantRoles: Object.fromEntries(Object.entries(options.speakerMap).filter(([, role]) => role === "other" || role === "unknown")) as Record<string, "other" | "unknown">,
    defaultTimezone: preview.timestamp.timezone,
  };
  const canonicalBasis = {
    schemaVersion: "conversation-archive/v1" as const,
    sourceApp: "legacy_chat",
    adapter: { id: LEGACY_CHAT_CHATS_V1_ADAPTER_ID, version: LEGACY_CHAT_CHATS_V1_ADAPTER_VERSION },
    mapping,
    conversations: canonicalConversations,
    quarantine,
    warnings: preview.issues.filter((issue) => issue.severity === "warning"),
  };
  const canonicalSha256 = await sha256Hex(canonicalJson(canonicalBasis));
  return {
    ...canonicalBasis,
    export: { blobSha256: preview.export.blobSha256, canonicalSha256, byteCount: bytes.byteLength },
  };
}

export const legacyChatChatsV1Adapter: ConversationImportAdapter = {
  id: LEGACY_CHAT_CHATS_V1_ADAPTER_ID,
  version: LEGACY_CHAT_CHATS_V1_ADAPTER_VERSION,
  detect: detectLegacyChatChatsV1,
  preview: previewLegacyChatChatsV1,
  normalize: normalizeLegacyChatChatsV1,
};

export function canonicalPreviewJson(preview: ConversationImportPreview): string {
  return canonicalJson(preview);
}
