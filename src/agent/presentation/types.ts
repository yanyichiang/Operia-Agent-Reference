export type ResultStatus = "success" | "partial" | "empty" | "failed";
export type CapsuleStatus = ResultStatus | "attention_required";
export type Sensitivity = "public" | "owner_private" | "account" | "health" | "location" | "device";
export type PresentationRecipeKey =
  | "place.search"
  | "place.details"
  | "route.summary"
  | "music.search"
  | "music.playlist"
  | "music.lyric"
  | "calendar.agenda"
  | "health.summary"
  | "execution.receipt"
  | "generic.result";

export type CachePolicy = {
  mode: "no_store" | "transient" | "provider_allowed";
  maxAgeSeconds?: number;
  refreshRequired?: boolean;
};

export type Attribution = {
  id: string;
  label: string;
  url?: string;
  required: boolean;
  placement: "inline" | "caption" | "footer";
};

export type PresentationSource = {
  id: string;
  label: string;
  url?: string;
};

export type PresentationAsset = {
  id: string;
  kind: "image" | "video" | "audio" | "voice" | "document";
  source: "agent_media" | "provider_url" | "generated_artifact";
  mediaRef?: string;
  url?: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
  sha256?: string;
  attributionIds: string[];
  expiresAt?: string;
  cachePolicy: CachePolicy;
};

export type NormalizedLocation = { latitude: number; longitude: number };
export type NormalizedLink = { rel: "canonical" | "source"; url: string };
export type NormalizedItem = {
  id: string;
  title: string;
  subtitle?: string;
  location?: NormalizedLocation;
  facts: Record<string, string | number | boolean>;
  links: NormalizedLink[];
};

export type NormalizedToolResultV1 = {
  schema: "operia.tool-result/v1";
  toolKey: string;
  providerId: string;
  taskId: string;
  toolCallId: string;
  status: ResultStatus;
  title?: string;
  summary?: string;
  items: NormalizedItem[];
  assets: PresentationAsset[];
  sources: PresentationSource[];
  warnings: string[];
  sensitivity: Sensitivity[];
  attribution: Attribution[];
  cachePolicy: CachePolicy;
  rawResultHash: string;
  normalizedAt: string;
  elapsedMs?: number;
};

export type HeadingBlock = { type: "heading"; text: string; level?: 1 | 2 | 3 };
export type ParagraphBlock = { type: "paragraph"; text: string };
export type FactListBlock = { type: "fact_list"; facts: Array<{ label: string; value: string }> };
export type MetricBlock = { type: "metric"; label: string; value: string; note?: string };
export type TableBlock = { type: "table"; columns: string[]; rows: string[][]; caption?: string };
export type MapBlock = {
  type: "map";
  latitude: number;
  longitude: number;
  zoom: number;
  label?: string;
};
export type MediaBlock = { type: "media"; assetId: string; caption?: string };
export type GalleryBlock = { type: "gallery"; assetIds: string[]; caption?: string };
export type DetailsBlock = {
  type: "details";
  summary: string;
  blocks: Array<ParagraphBlock | FactListBlock | TableBlock | NoticeBlock | SourceListBlock>;
  open?: boolean;
};
export type DividerBlock = { type: "divider" };
export type SourceListBlock = { type: "sources"; sourceIds: string[] };
export type NoticeBlock = { type: "notice"; text: string; tone: "info" | "success" | "warning" | "error" };

export type PresentationBlock =
  | HeadingBlock
  | ParagraphBlock
  | FactListBlock
  | MetricBlock
  | TableBlock
  | MapBlock
  | MediaBlock
  | GalleryBlock
  | DetailsBlock
  | DividerBlock
  | SourceListBlock
  | NoticeBlock;

type PresentationActionBase = {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  expiresAt?: string;
};

export type MiniAppTarget = "calendar" | "health_7d" | "health_30d";
export type PresentationAction = PresentationActionBase & (
  | { kind: "open_url"; urlRef: string; requiresApproval: false }
  | { kind: "open_mini_app"; miniAppTarget: MiniAppTarget; requiresApproval: false }
  | { kind: "callback"; callbackRef: string; requiresApproval: boolean }
  | { kind: "copy_text"; callbackRef: string; requiresApproval: false }
);

export type ResultCapsuleV1 = {
  schema: "operia.presentation/v1";
  capsuleId: string;
  capsuleHash: string;
  taskId: string;
  toolCallIds: string[];
  recipe: PresentationRecipeKey;
  status: CapsuleStatus;
  title: string;
  summary?: string;
  blocks: PresentationBlock[];
  actions: PresentationAction[];
  assets: PresentationAsset[];
  sources: PresentationSource[];
  attribution: Attribution[];
  sensitivity: Sensitivity[];
  cachePolicy: CachePolicy;
  fallbackText: string;
  presentationRevision: string;
  createdAt: string;
  expiresAt?: string;
};

export type CapsuleDraft = Omit<ResultCapsuleV1, "capsuleId" | "capsuleHash" | "createdAt">;

export const PRESENTATION_LIMITS = {
  maxBlocks: 24,
  maxDetailsBlocks: 12,
  maxActions: 8,
  maxAssets: 10,
  maxTableColumns: 4,
  maxTableRows: 10,
  maxTextChars: 8_000,
  maxFallbackChars: 4_000,
} as const;

const HASH = /^[a-f0-9]{64}$/;

export function assertResultCapsuleV1(value: unknown): asserts value is ResultCapsuleV1 {
  const capsule = asRecord(value, "capsule");
  exactKeys(capsule, [
    "schema", "capsuleId", "capsuleHash", "taskId", "toolCallIds", "recipe", "status", "title", "summary",
    "blocks", "actions", "assets", "sources", "attribution", "sensitivity", "cachePolicy", "fallbackText",
    "presentationRevision", "createdAt", "expiresAt",
  ]);
  if (capsule.schema !== "operia.presentation/v1") throw new Error("capsule_schema_invalid");
  boundedString(capsule.capsuleId, 80, "capsule_id_invalid");
  if (typeof capsule.capsuleHash !== "string" || !HASH.test(capsule.capsuleHash)) throw new Error("capsule_hash_invalid");
  boundedString(capsule.taskId, 256, "capsule_task_id_invalid");
  boundedStringArray(capsule.toolCallIds, 32, 256, "capsule_tool_calls_invalid");
  if (!RECIPE_KEYS.has(String(capsule.recipe) as PresentationRecipeKey)) throw new Error("capsule_recipe_invalid");
  if (!CAPSULE_STATUSES.has(String(capsule.status) as CapsuleStatus)) throw new Error("capsule_status_invalid");
  boundedString(capsule.title, 256, "capsule_title_invalid");
  optionalString(capsule.summary, 1_024, "capsule_summary_invalid");
  boundedString(capsule.fallbackText, PRESENTATION_LIMITS.maxFallbackChars, "capsule_fallback_invalid");
  boundedString(capsule.presentationRevision, 128, "capsule_revision_invalid");
  isoInstant(capsule.createdAt, "capsule_created_at_invalid");
  if (capsule.expiresAt !== undefined) isoInstant(capsule.expiresAt, "capsule_expires_at_invalid");
  if (!Array.isArray(capsule.blocks) || capsule.blocks.length < 1 || capsule.blocks.length > PRESENTATION_LIMITS.maxBlocks) {
    throw new Error("capsule_blocks_invalid");
  }
  capsule.blocks.forEach((block) => validateBlock(block, 0));
  if (!Array.isArray(capsule.actions) || capsule.actions.length > PRESENTATION_LIMITS.maxActions) throw new Error("capsule_actions_invalid");
  capsule.actions.forEach(validateAction);
  if (!Array.isArray(capsule.assets) || capsule.assets.length > PRESENTATION_LIMITS.maxAssets) throw new Error("capsule_assets_invalid");
  capsule.assets.forEach(validateAsset);
  if (!Array.isArray(capsule.sources)) throw new Error("capsule_sources_invalid");
  capsule.sources.forEach(validateSource);
  if (!Array.isArray(capsule.attribution)) throw new Error("capsule_attribution_invalid");
  capsule.attribution.forEach(validateAttribution);
  boundedStringArray(capsule.sensitivity, 8, 32, "capsule_sensitivity_invalid");
  for (const item of capsule.sensitivity as string[]) if (!SENSITIVITIES.has(item as Sensitivity)) throw new Error("capsule_sensitivity_invalid");
  validateCachePolicy(capsule.cachePolicy);
  validateReferences(capsule as unknown as ResultCapsuleV1);
  const totalText = countText(capsule.blocks) + (capsule.title as string).length + ((capsule.summary as string | undefined)?.length ?? 0);
  if (totalText > PRESENTATION_LIMITS.maxTextChars) throw new Error("capsule_text_limit_exceeded");
}

function validateBlock(value: unknown, depth: number): void {
  const block = asRecord(value, "block");
  const type = block.type;
  if (typeof type !== "string") throw new Error("capsule_block_type_invalid");
  if (depth > 1) throw new Error("capsule_block_depth_invalid");
  switch (type) {
    case "heading":
      exactKeys(block, ["type", "text", "level"]); boundedString(block.text, 256, "capsule_block_text_invalid");
      if (block.level !== undefined && ![1, 2, 3].includes(block.level as number)) throw new Error("capsule_heading_level_invalid");
      return;
    case "paragraph":
      exactKeys(block, ["type", "text"]); boundedString(block.text, 2_000, "capsule_block_text_invalid"); return;
    case "fact_list":
      exactKeys(block, ["type", "facts"]);
      if (!Array.isArray(block.facts) || block.facts.length > 16) throw new Error("capsule_facts_invalid");
      block.facts.forEach((raw) => { const fact = asRecord(raw, "fact"); exactKeys(fact, ["label", "value"]); boundedString(fact.label, 80, "capsule_fact_invalid"); boundedString(fact.value, 256, "capsule_fact_invalid"); });
      return;
    case "metric":
      exactKeys(block, ["type", "label", "value", "note"]); boundedString(block.label, 80, "capsule_metric_invalid"); boundedString(block.value, 128, "capsule_metric_invalid"); optionalString(block.note, 256, "capsule_metric_invalid"); return;
    case "table":
      exactKeys(block, ["type", "columns", "rows", "caption"]);
      boundedStringArray(block.columns, PRESENTATION_LIMITS.maxTableColumns, 80, "capsule_table_invalid");
      if (!Array.isArray(block.rows) || block.rows.length > PRESENTATION_LIMITS.maxTableRows) throw new Error("capsule_table_invalid");
      for (const row of block.rows) { boundedStringArray(row, PRESENTATION_LIMITS.maxTableColumns, 256, "capsule_table_invalid"); if ((row as unknown[]).length !== (block.columns as unknown[]).length) throw new Error("capsule_table_invalid"); }
      optionalString(block.caption, 256, "capsule_table_invalid"); return;
    case "map":
      exactKeys(block, ["type", "latitude", "longitude", "zoom", "label"]);
      if (!finiteRange(block.latitude, -90, 90) || !finiteRange(block.longitude, -180, 180) || !Number.isInteger(block.zoom) || !finiteRange(block.zoom, 0, 24)) throw new Error("capsule_map_invalid");
      optionalString(block.label, 256, "capsule_map_invalid"); return;
    case "media":
      exactKeys(block, ["type", "assetId", "caption"]); boundedString(block.assetId, 128, "capsule_media_invalid"); optionalString(block.caption, 512, "capsule_media_invalid"); return;
    case "gallery":
      exactKeys(block, ["type", "assetIds", "caption"]); boundedStringArray(block.assetIds, PRESENTATION_LIMITS.maxAssets, 128, "capsule_gallery_invalid"); optionalString(block.caption, 512, "capsule_gallery_invalid"); return;
    case "details":
      exactKeys(block, ["type", "summary", "blocks", "open"]); boundedString(block.summary, 256, "capsule_details_invalid");
      if (!Array.isArray(block.blocks) || block.blocks.length > PRESENTATION_LIMITS.maxDetailsBlocks) throw new Error("capsule_details_invalid");
      block.blocks.forEach((child) => validateBlock(child, depth + 1));
      if (block.open !== undefined && typeof block.open !== "boolean") throw new Error("capsule_details_invalid"); return;
    case "divider": exactKeys(block, ["type"]); return;
    case "sources": exactKeys(block, ["type", "sourceIds"]); boundedStringArray(block.sourceIds, 16, 128, "capsule_sources_block_invalid"); return;
    case "notice":
      exactKeys(block, ["type", "text", "tone"]); boundedString(block.text, 1_000, "capsule_notice_invalid");
      if (!new Set(["info", "success", "warning", "error"]).has(String(block.tone))) throw new Error("capsule_notice_invalid"); return;
    default: throw new Error("capsule_block_type_unknown");
  }
}

function validateAction(value: unknown): void {
  const action = asRecord(value, "action");
  exactKeys(action, ["id", "label", "kind", "style", "urlRef", "callbackRef", "miniAppTarget", "requiresApproval", "expiresAt"]);
  boundedString(action.id, 80, "capsule_action_invalid"); boundedString(action.label, 80, "capsule_action_invalid");
  if (!new Set(["open_url", "callback", "open_mini_app", "copy_text"]).has(String(action.kind))) throw new Error("capsule_action_invalid");
  if (action.style !== undefined && !new Set(["primary", "secondary", "danger"]).has(String(action.style))) throw new Error("capsule_action_invalid");
  if (typeof action.requiresApproval !== "boolean") throw new Error("capsule_action_invalid");
  if (action.expiresAt !== undefined) isoInstant(action.expiresAt, "capsule_action_invalid");
  if (action.kind === "open_url") {
    if (!safeHttpsReference(action.urlRef) || action.requiresApproval !== false || action.callbackRef !== undefined || action.miniAppTarget !== undefined) throw new Error("capsule_action_invalid");
    return;
  }
  if (action.kind === "open_mini_app") {
    if (!new Set(["calendar", "health_7d", "health_30d"]).has(String(action.miniAppTarget)) || action.requiresApproval !== false || action.urlRef !== undefined || action.callbackRef !== undefined) throw new Error("capsule_action_invalid");
    return;
  }
  if (typeof action.callbackRef !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(action.callbackRef) || action.urlRef !== undefined || action.miniAppTarget !== undefined) throw new Error("capsule_action_invalid");
  if (action.kind === "copy_text" && action.requiresApproval !== false) throw new Error("capsule_action_invalid");
}

function validateAsset(value: unknown): void {
  const asset = asRecord(value, "asset");
  exactKeys(asset, ["id", "kind", "source", "mediaRef", "url", "mimeType", "width", "height", "bytes", "sha256", "attributionIds", "expiresAt", "cachePolicy"]);
  boundedString(asset.id, 128, "capsule_asset_invalid");
  if (!new Set(["image", "video", "audio", "voice", "document"]).has(String(asset.kind))) throw new Error("capsule_asset_invalid");
  if (!new Set(["agent_media", "provider_url", "generated_artifact"]).has(String(asset.source))) throw new Error("capsule_asset_invalid");
  optionalString(asset.mediaRef, 256, "capsule_asset_invalid"); optionalString(asset.url, 2_048, "capsule_asset_invalid"); boundedString(asset.mimeType, 128, "capsule_asset_invalid");
  if (asset.source === "provider_url" && !safeHttpsReference(asset.url)) throw new Error("capsule_asset_invalid");
  if (asset.source === "agent_media" && (typeof asset.mediaRef !== "string" || !asset.mediaRef.startsWith("agent-media:"))) throw new Error("capsule_asset_invalid");
  for (const field of ["width", "height", "bytes"] as const) if (asset[field] !== undefined && (!Number.isInteger(asset[field]) || (asset[field] as number) < 0)) throw new Error("capsule_asset_invalid");
  if (asset.sha256 !== undefined && (typeof asset.sha256 !== "string" || !HASH.test(asset.sha256))) throw new Error("capsule_asset_invalid");
  boundedStringArray(asset.attributionIds, 16, 128, "capsule_asset_invalid");
  if (asset.expiresAt !== undefined) isoInstant(asset.expiresAt, "capsule_asset_invalid");
  validateCachePolicy(asset.cachePolicy);
}

function validateSource(value: unknown): void { const item = asRecord(value, "source"); exactKeys(item, ["id", "label", "url"]); boundedString(item.id, 128, "capsule_source_invalid"); boundedString(item.label, 128, "capsule_source_invalid"); optionalString(item.url, 2_048, "capsule_source_invalid"); if (item.url !== undefined && !safeHttpsReference(item.url)) throw new Error("capsule_source_invalid"); }
function validateAttribution(value: unknown): void { const item = asRecord(value, "attribution"); exactKeys(item, ["id", "label", "url", "required", "placement"]); boundedString(item.id, 128, "capsule_attribution_invalid"); boundedString(item.label, 128, "capsule_attribution_invalid"); optionalString(item.url, 2_048, "capsule_attribution_invalid"); if (item.url !== undefined && !safeHttpsReference(item.url)) throw new Error("capsule_attribution_invalid"); if (typeof item.required !== "boolean" || !new Set(["inline", "caption", "footer"]).has(String(item.placement))) throw new Error("capsule_attribution_invalid"); }
function validateCachePolicy(value: unknown): void { const policy = asRecord(value, "cache_policy"); exactKeys(policy, ["mode", "maxAgeSeconds", "refreshRequired"]); if (!new Set(["no_store", "transient", "provider_allowed"]).has(String(policy.mode))) throw new Error("capsule_cache_policy_invalid"); if (policy.maxAgeSeconds !== undefined && (!Number.isInteger(policy.maxAgeSeconds) || !finiteRange(policy.maxAgeSeconds, 0, 31_536_000))) throw new Error("capsule_cache_policy_invalid"); if (policy.refreshRequired !== undefined && typeof policy.refreshRequired !== "boolean") throw new Error("capsule_cache_policy_invalid"); }

function countText(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + countText(item), 0);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).reduce<number>((total, item) => total + countText(item), 0);
  return 0;
}
function validateReferences(capsule: ResultCapsuleV1): void {
  const assetIds = new Set(capsule.assets.map((asset) => asset.id));
  const sourceIds = new Set(capsule.sources.map((source) => source.id));
  const visit = (blocks: PresentationBlock[]) => {
    for (const block of blocks) {
      if (block.type === "media" && !assetIds.has(block.assetId)) throw new Error("capsule_asset_reference_invalid");
      if (block.type === "gallery" && block.assetIds.some((id) => !assetIds.has(id))) throw new Error("capsule_asset_reference_invalid");
      if (block.type === "sources" && block.sourceIds.some((id) => !sourceIds.has(id))) throw new Error("capsule_source_reference_invalid");
      if (block.type === "details") visit(block.blocks);
    }
  };
  visit(capsule.blocks);
}
function safeHttpsReference(value: unknown): boolean { if (typeof value !== "string") return false; try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.toString().length <= 2_048; } catch { return false; } }
function asRecord(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`capsule_${name}_invalid`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, allowed: string[]): void { const set = new Set(allowed); if (Object.keys(value).some((key) => !set.has(key))) throw new Error("capsule_unknown_field"); }
function boundedString(value: unknown, max: number, error: string): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(error); }
function optionalString(value: unknown, max: number, error: string): void { if (value !== undefined) boundedString(value, max, error); }
function boundedStringArray(value: unknown, maxItems: number, maxLength: number, error: string): asserts value is string[] { if (!Array.isArray(value) || value.length > maxItems) throw new Error(error); value.forEach((item) => boundedString(item, maxLength, error)); }
function finiteRange(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function isoInstant(value: unknown, error: string): void { boundedString(value, 64, error); if (Number.isNaN(Date.parse(value))) throw new Error(error); }

const RECIPE_KEYS = new Set<PresentationRecipeKey>(["place.search", "place.details", "route.summary", "music.search", "music.playlist", "music.lyric", "calendar.agenda", "health.summary", "execution.receipt", "generic.result"]);
const CAPSULE_STATUSES = new Set<CapsuleStatus>(["success", "partial", "empty", "failed", "attention_required"]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "owner_private", "account", "health", "location", "device"]);
