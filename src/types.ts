export interface Env {
  WORKER_ROLE?: "memory" | "tgbot" | "agent" | "calendar" | string;
  TG_RICH_RESULTS_ENABLED?: string;
  DB: D1Database;
  AI?: Ai;
  MEMORY_QUEUE?: Queue<QueueMessage>;
  TG_QUEUE?: Queue<QueueMessage>;
  TG_ROOM_QUEUE?: Queue<QueueMessage>;
  VECTORIZE?: Vectorize | VectorizeIndex;
  VECTORIZE_INDEX_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  PUBLIC_MODEL_NAME?: string;
  CHAT_MODEL?: string;
  DEFAULT_UPSTREAM_MODEL?: string;
  ALLOW_MODEL_PASSTHROUGH?: string;
  AI_GATEWAY_BASE_URL?: string;
  CHATBOX_API_KEY?: string;
  IM_API_KEY?: string;
  DEBUG_API_KEY?: string;
  CACHE_TEST_API_KEY?: string;
  OPERIA_CHAT_API_KEY?: string;
  RIDDLE_CHAT_API_KEY?: string;
  MEMORY_MCP_API_KEY?: string;
  AGENT_MEMORY_MCP_API_KEY?: string;
  AGENT_GATEWAY_BROKER_API_KEY?: string;
  GUIDE_DOG_API_KEY?: string;
  OPERIA_SESSION_SECRET?: string;
  HEALTH_SESSION_VERIFY_BEARER?: string;
  ADMIN_EMAIL_ALLOWLIST?: string;
  CF_AIG_TOKEN?: string;
  ENABLE_AUTO_MEMORY?: string;
  ENABLE_DREAM?: string;
  // --- Operia 记忆库 v2 行为开关 ---
  // 默认走 v2；只有显式 false 才回退旧路径。
  MEMORY_LIFECYCLE_ENABLED?: string;
  // dream 策略：默认 upsert，可显式 review。
  DREAM_STRATEGY?: string;
  // 是否把 dream 删除的旧记忆收容进 longtail。默认 false，避免新 v2 内容污染旧大库兜底。
  DREAM_ARCHIVE_DELETES_TO_LONGTAIL?: string;
  // 写入模式：默认 upsert，可显式 append。
  MEMORY_WRITE_MODE?: string;
  // patrol 是否只出提案不自动删
  MEMORY_PATROL_DRY_RUN?: string;
  // 是否允许自动删（默认 false 锁死）
  MEMORY_AUTO_DELETE?: string;
  // 闸三降权窗口 (分钟)，默认 30
  MEMORY_INJECT_DECAY_WINDOW_MIN?: string;
  // 连续轮软排序系数 (0.75-1)，默认 0.85；不参与最低分资格判断。
  MEMORY_INJECT_DECAY_FACTOR?: string;
  // memory_recall 最低分地板，默认 0.15；调用方可用 min_score 临时覆盖。
  RECALL_MIN_SCORE?: string;
  // true = 丢弃没有有效 D1 记录背书的 Vectorize 命中 (清理 legacy 孤儿向量)，默认 false 保持现状。
  RECALL_REQUIRE_D1_BACKING?: string;
  MEMORY_EPISODIC_WRITE_ENABLED?: string;
  MEMORY_EPISODIC_READ_ENABLED?: string;
  MEMORY_EPISODIC_INJECT_ENABLED?: string;
  MEMORY_SUBJECT_CORE_ENABLED?: string;
  MEMORY_SUBJECT_PROPOSALS_ENABLED?: string;
  LEGACY_CHAT_ARCHIVE_MEMORY_BACKFILL_ENABLED?: string;
  LEGACY_CHAT_ARCHIVE_MEMORY_BACKFILL_BATCH_ID?: string;
  // Owner-only historical conversation import. Fail closed unless explicitly enabled.
  CONVERSATION_IMPORT_ENABLED?: string;
  CONVERSATION_IMPORT_COMMIT_ENABLED?: string;
  CONVERSATION_IMPORT_RECALL_ENABLED?: string;
  CONVERSATION_IMPORT_SUMMARY_ENABLED?: string;
  CONVERSATION_IMPORT_SUMMARY_MODEL?: string;
  CONVERSATION_IMPORT_FREE_SUMMARY_MODE?: string;
  CONVERSATION_IMPORT_FREE_SUMMARY_MODEL?: string;
  CONVERSATION_IMPORT_FREE_SUMMARY_DAILY_NEURONS?: string;
  CONVERSATION_IMPORT_FREE_SUMMARY_BATCH_ID?: string;
  CONVERSATION_IMPORT_FREE_SUMMARY_NAMESPACE?: string;
  CONVERSATION_IMPORT_PRIVILEGED_INGEST_ENABLED?: string;
  CONVERSATION_FRESHNESS_V2_ENABLED?: string;
  IMPORTED_SUMMARY_RECENCY_ENABLED?: string;
  CONVERSATION_IMPORT_INGEST_NAMESPACE?: string;
  CONVERSATION_IMPORT_INGEST_BEARER?: string;
  MEMORY_ARCHIVE?: R2Bucket;
  ENABLE_DAILY_MEMORY_DIGEST?: string;
  DREAM_NAMESPACE?: string;
  DREAM_MAX_MESSAGES?: string;
  DREAM_MAX_RUNS?: string;
  DREAM_MAX_TOKENS?: string;
  DREAM_MODEL?: string;
  DREAM_MEMORY_CONTEXT_LIMIT?: string;
  DREAM_EXCERPT_LIMIT?: string;
  DREAM_TIME_ZONE?: string;
  DEDUP_COSINE?: string;
  // L4 每区（type）active 条数硬上限，0 或不设 = 关闭（母帖第一节，对抗膨胀的闸）
  MEMORY_ZONE_CAP?: string;
  // 候选队列自动评审（judge），默认关闭
  CANDIDATE_JUDGE_ENABLED?: string;
  JUDGE_MODEL?: string;
  JUDGE_MAX_CANDIDATES?: string;
  JUDGE_BATCH_SIZE?: string;
  // judge 评分阈值：高分自动入库、低分自动丢弃，中间区间服从结构化 approve/merge/discard；不制造普通人工奏折
  JUDGE_APPROVE_MIN?: string;
  JUDGE_DISCARD_MAX?: string;
  DAILY_DIGEST_MAX_MESSAGES?: string;
  DAILY_DIGEST_MAX_RUNS?: string;
  DAILY_DIGEST_MAX_TOKENS?: string;
  DAILY_DIGEST_MODEL?: string;
  SUMMARY_MODEL?: string;
  DAILY_DIGEST_MEMORY_CONTEXT_LIMIT?: string;
  DAILY_DIGEST_EXCERPT_LIMIT?: string;
  DAILY_DIGEST_TIME_ZONE?: string;
  // GitHub daily archive pull (cmh-lite client → private repo → nightly cron ingest)
  GITHUB_DAILY_REPO?: string;
  GITHUB_DAILY_PATH?: string;
  GITHUB_DAILY_NAMESPACE?: string;
  GITHUB_DAILY_TOKEN?: string;
  EMPTY_MEMORY_MIN_CHARS?: string;
  MEMORY_MODE?: string;
  ENABLE_MEMORY_FILTER?: string;
  ENABLE_MEMORY_RERANKER?: string;
  MEMORY_RERANKER_MODEL?: string;
  VISION_MODEL?: string;
  MEMORY_FILTER_MAX_CANDIDATES?: string;
  MEMORY_FILTER_MAX_OUTPUT?: string;
  MEMORY_FILTER_MAX_CONTENT_CHARS?: string;
  MEMORY_FILTER_MIN_SCORE?: string;
  MEMORY_RECALL_TIMEOUT_MS?: string;
  MEMORY_RECALL_SHARED_DEADLINE_ENABLED?: string;
  MEMORY_RECALL_MAX_ITEM_BYTES?: string;
  MEMORY_RECALL_MAX_TOTAL_BYTES?: string;
  MEMORY_RECALL_SEMANTIC_SLOTS?: string;
  MEMORY_STATE_PROJECTION_SHADOW_ENABLED?: string;
  MEMORY_REVISION_EXPANSION_SHADOW_ENABLED?: string;
  MEMORY_STATE_PACKET_SHADOW_ENABLED?: string;
  MEMORY_STATE_PACKET_INJECT_ENABLED?: string;
  MEMORY_STATE_OWNER_TIME_ZONE?: string;
  MEMORY_VNEXT_ORDINARY_FACT_WRITE_ENABLED?: string;
  MEMORY_EVIDENCE_UNIT_V2_WRITE_ENABLED?: string;
  MEMORY_CLAIM_ATOM_V2_WRITE_ENABLED?: string;
  MEMORY_MUTATION_V2_SHADOW_ENABLED?: string;
  MEMORY_MUTATION_V2_COMMIT_ENABLED?: string;
  MEMORY_SUPPORT_RECOMPUTE_ENABLED?: string;
  MEMORY_GROK_PROPOSAL_SHADOW_ENABLED?: string;
  MEMORY_GROK_PROPOSAL_PRIMARY_ENABLED?: string;
  MEMORY_GROK_PROPOSAL_MODEL?: string;
  MEMORY_OCM_SHADOW_ENABLED?: string;
  MEMORY_NIGHT_REVIEW_ENABLED?: string;
  MEMORY_NIGHT_REVIEW_PROVIDER?: string;
  MEMORY_NIGHT_REVIEW_MODEL?: string;
  MEMORY_NIGHT_REVIEW_REASONING_EFFORT?: string;
  MEMORY_NIGHT_REVIEW_PROMPT_VERSION?: string;
  MEMORY_NIGHT_REVIEW_SCHEMA_VERSION?: string;
  MEMORY_NIGHT_REVIEW_MAX_CASES?: string;
  MEMORY_NIGHT_REVIEW_MAX_TOKENS?: string;
  MEMORY_DYNAMIC_NEED_SHADOW_ENABLED?: string;
  MEMORY_DYNAMIC_NEED_ENFORCE_ENABLED?: string;
  MEMORY_VNEXT_READ_SHADOW_ENABLED?: string;
  MEMORY_MB1_SHADOW_ENABLED?: string;
  MEMORY_MB1_INJECT_ENABLED?: string;
  MEMORY_VISIBLE_CONTEXT_LEDGER_ENABLED?: string;
  MEMORY_COUNTERFACTUAL_REPLAY_ENABLED?: string;
  MEMORY_VNEXT_BACKFILL_TOKEN?: string;
  MEMORY_FILTER_FAIL_OPEN?: string;
  MEMORY_THINK_SHADOW_ENABLED?: string;
  MEMORY_THINK_CANARY_ENABLED?: string;
  MEMORY_THINK_EXECUTION_ENABLED?: string;
  MEMORY_THINK_TOOL_LOOP_ENABLED?: string;
  MEMORY_THINK_CODEMODE_ENABLED?: string;
  MEMORY_THINK_CODEMODE_V2_ENABLED?: string;
  MEMORY_THINK_SDK_CODEMODE_ENABLED?: string;
  MEMORY_THINK_CODE_READ_ENABLED?: string;
  MEMORY_THINK_TG_DRAFT_ENABLED?: string;
  MEMORY_THINK_TG_PARAGRAPH_ENABLED?: string;
  MEMORY_THINK_CACHE_V3_OBSERVE_ENABLED?: string;
  MEMORY_THINK_STEP_TELEMETRY_ENABLED?: string;
  MEMORY_THINK_CACHE_V3_MODE?: string;
  MEMORY_THINK_CACHE_V3_TTL?: string;
  MEMORY_THINK_CACHE_V3_COHORT_PERCENT?: string;
  MEMORY_THINK_CONTEXT_EDIT_ENABLED?: string;
  MEMORY_THINK_CONTEXT_EDIT_TRIGGER_INPUT_TOKENS?: string;
  MEMORY_THINK_CONTEXT_EDIT_KEEP_TOOL_USES?: string;
  MEMORY_THINK_CONTEXT_EDIT_CLEAR_AT_LEAST_TOKENS?: string;
  MEMORY_THINK_LOCAL_PRUNE_ENABLED?: string;
  MEMORY_THINK_LOCAL_PRUNE_TRIGGER_INPUT_TOKENS?: string;
  MEMORY_THINK_CODE_INSPECT_ENABLED?: string;
  MEMORY_THINK_CODE_INSPECT_TERMINAL_ENABLED?: string;
  MEMORY_THINK_ACTIONS_ENABLED?: string;
  MEMORY_THINK_SDK_CODEMODE_ACTIONS_ENABLED?: string;
  MEMORY_THINK_APPROVAL_CONTINUATION_ENABLED?: string;
  MEMORY_THINK_PROGRESSIVE_SKILLS_ENABLED?: string;
  MEMORY_THINK_AUTHORITY_ENVELOPE_REQUIRED?: string;
  AGENT_THINK_SERVICE_BEARER?: string;
  OPERIA_THINK?: DurableObjectNamespace;
  MEMORY_EXTRACT_EVERY_N_MESSAGES?: string;
  MEMORY_MIN_IMPORTANCE?: string;
  INJECTION_MODE?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  MEMORY_TOP_K?: string;
  MEMORY_MIN_SCORE?: string;
  MEMORY_LEGACY_VECTOR_FALLBACK_LIMIT?: string;
  MEMORY_LEGACY_VECTOR_FALLBACK_SCORE_FACTOR?: string;
  ANTHROPIC_CACHE_ENABLED?: string;
  ANTHROPIC_CACHE_TTL?: string;
  ANTHROPIC_CACHE_STABLE_TTL?: string;
  ANTHROPIC_CACHE_CONVERSATION_TTL?: string;
  ANTHROPIC_AUTO_CACHE_ENABLED?: string;
  ANTHROPIC_ROLLING_CACHE_ENABLED?: string;
  ANTHROPIC_ROLLING_CACHE_WINDOW_SIZE?: string;
  ANTHROPIC_CACHE_STABLE_SYSTEM?: string;
  ANTHROPIC_CACHE_USER_ID?: string;
  ANTHROPIC_TRANSPORT_DEFAULT?: string;
  CUSTOM_ANTHROPIC_MESSAGES_PATH?: string;
  ANTHROPIC_THINKING_ENABLED?: string;
  ANTHROPIC_THINKING_BUDGET?: string;
  CONTROL_REASONING_OWNER_ENABLED?: string;
  MEMORY_CONTROL_SERVICE_BEARER?: string;
  FORCE_ANTHROPIC_NATIVE?: string;
  ENABLE_CACHE_API?: string;
  CACHE_DEFAULT_TTL_SECONDS?: string;
  CACHE_MAX_VALUE_BYTES?: string;
  TG_BOT_TOKEN?: string;
  TG_CHAT_API_KEY?: string;
  TG_CHAT_BASE_URL?: string;
  MEMORY_SERVICE?: Fetcher;
  OPERIA_DASHBOARD_SERVICE?: Fetcher;
  OPERIA_DASHBOARD_SERVICE_BEARER?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_ALLOWED_CHAT_IDS?: string;
  TG_DEBOUNCE_SECONDS?: string;
  TG_DEBOUNCE_MAX_SECONDS?: string;
  TG_INFERENCE_MAX_ATTEMPTS?: string;
  TG_INFERENCE_RETRY_DELAY_SECONDS?: string;
  TG_INFERENCE_LEASE_SECONDS?: string;
  TG_FAST_PATH_ENABLED?: string;
  TG_DRAFT_PREVIEW_ENABLED?: string;
  TG_PARAGRAPH_STREAM_ENABLED?: string;
  TG_MEMORY_OUTCOME_V2_ENABLED?: string;
  MEMORY_PUBLICATION_STATE_V2_ENABLED?: string;
  TG_UNIFIED_DELIVERY_ORDER_ENABLED?: string;
  CONVERSATION_FOLD_TRIGGER_TURNS?: string;
  CONVERSATION_RECENT_KEEP_TURNS?: string;
  CONVERSATION_SUMMARY_MODEL?: string;
  CONVERSATION_SUMMARY_RETRY_COOLDOWN_SECONDS?: string;
  AGENT_APPROVAL_SERVICE_BEARER?: string;
  AGENT_SERVICE?: Fetcher;
  CALENDAR_SERVICE?: Fetcher;
  CALENDAR_SERVICE_BEARER?: string;
  CALENDAR_GOOGLE_ENABLED?: string;
  TG_MINIAPP_CALENDAR_WRITE_ENABLED?: string;
  HEALTH_SERVICE?: Fetcher;
  HEALTH_SERVICE_BEARER?: string;
  NOTE_SERVICE?: Fetcher;
  NOTE_SERVICE_BEARER?: string;
  NOTE_OWNER_ID?: string;
  HEALTH_MINIAPP_ENABLED?: string;
  TG_MINIAPP_HEALTH_CORRECTIONS_ENABLED?: string;
  AGENT_CONTEXT_SERVICE_BEARER?: string;
  TG_AGENT_ENABLED?: string;
  TG_AGENT_ROOMS_ENABLED?: string;
  TG_ARCHIVE_MEMORY_BACKFILL_ENABLED?: string;
  TASK_PROGRESS_ENABLED?: string;
  TG_COMMAND_HUB_V2_ENABLED?: string;
  TG_AGENT_OWNER_CHAT_ID?: string;
  TG_AGENT_OWNER_ID?: string;
  TG_AGENT_SERVICE_ID?: string;
  TG_MINIAPP_ENABLED?: string;
  TG_MINIAPP_URL?: string;
  TG_MINIAPP_SESSION_SECRET?: string;
  TG_MINIAPP_AUTH_MAX_AGE_SECONDS?: string;
  TG_MINIAPP_SESSION_TTL_SECONDS?: string;
  TG_MINIAPP_OPERATIONS_ENABLED?: string;
  TG_AMBIENT_CONTEXT_ENABLED?: string;
  TG_AMBIENT_HEALTH_CONTEXT_ENABLED?: string;
  AGENT_HTML_ARTIFACTS_ENABLED?: string;
  AGENT_INTERACTIVE_ARTIFACTS_ENABLED?: string;
  AGENT_SMOKE_API_KEY?: string;
  VOICE_ENABLED?: string;
  TG_MEDIA_MAX_BYTES?: string;
  TG_MEDIA?: R2Bucket;
}

export interface MemoryMaintenanceQueueMessage {
  type: "memory_maintenance";
  namespace: string;
  conversationId: string;
  fromMessageId: string;
  toMessageId: string;
  source: string;
  idempotencyKey: string;
}

export interface RetentionQueueMessage {
  type: "retention";
  namespace: string;
}

export interface EpisodicIndexQueueMessage {
  type: "episodic_index";
  namespace: string;
  includeFailed?: boolean;
}

export interface DreamDigestQueueMessage {
  type: "dream_digest";
  namespace: string;
  remainingRuns: number;
  dateLabel?: string;
}

export interface CandidateJudgeQueueMessage {
  type: "candidate_judge";
  namespace: string;
  remainingCandidates: number;
}

export interface LegacyVNextBackfillQueueMessage {
  type: "legacy_vnext_backfill";
  namespace: string;
  runId: string;
  remainingCandidates: number;
}

export interface MemoryNightReviewQueueMessage {
  type: "memory_night_review";
  runId: string;
  reviewDate: string;
  snapshotId: string;
  remainingCases: number;
}

export interface TgProcessQueueMessage {
  type: "tg_process";
  chatId: string;
}

export interface TgAgentResumeQueueMessage {
  type: "tg_agent_resume";
  taskId: string;
  attempt: number;
}

export interface TgInferenceResumeQueueMessage {
  type: "tg_inference_resume";
  batchKey: string;
}

export interface TgInferenceReadyQueueMessage {
  type: "tg_inference_ready";
  idempotencyKey: string;
}

export interface TgInferenceWatchdogQueueMessage {
  type: "tg_inference_watchdog";
  batchKey: string;
  probe: number;
}

export interface TgConversationAppendQueueMessage {
  type: "tg_conversation_append";
  batchKey: string;
}

export interface ConversationFoldQueueMessage {
  type: "conversation_fold";
  recipientId: string;
  expectedRevision: number;
}

export interface TgParagraphStreamQueueMessage {
  type: "tg_paragraph_stream";
  batchKey: string;
  chatId: string;
  generation: string;
  seq: number;
  startIndex: number;
  bubbles: string[];
}

export interface TgInferenceDeliveryQueueMessage {
  type: "tg_inference_delivery";
  batchKey: string;
}

export interface TgDraftPreviewQueueMessage {
  type: "tg_draft_preview";
  batchKey: string;
  generation: string;
  seq: number;
  phase: "snapshot" | "close";
  text?: string;
}

export interface TgRoomSummaryQueueMessage {
  type: "tg_room_summary";
  roomId: string;
  threadKey: string;
  digest: string;
}

export interface ThinkApprovalResumeQueueMessage {
  type: "think_approval_resume";
  approvalRef: string;
  attempt: number;
}

export interface ThinkCodeModeResumeQueueMessage {
  type: "think_codemode_resume";
  codemodeRef: string;
  attempt: number;
}

export interface ThinkSdkActionStateQueueMessage {
  type: "think_sdk_action_state";
  requestId: string;
  attempt: number;
}

export interface ThinkSdkActionDecisionQueueMessage {
  type: "think_sdk_action_decision";
  approvalRef: string;
  attempt: number;
}

export type QueueMessage = MemoryMaintenanceQueueMessage | EpisodicIndexQueueMessage | DreamDigestQueueMessage | CandidateJudgeQueueMessage | LegacyVNextBackfillQueueMessage | MemoryNightReviewQueueMessage | RetentionQueueMessage | ConversationFoldQueueMessage | TgProcessQueueMessage | TgAgentResumeQueueMessage | TgInferenceResumeQueueMessage | TgInferenceReadyQueueMessage | TgInferenceWatchdogQueueMessage | TgConversationAppendQueueMessage | TgInferenceDeliveryQueueMessage | TgDraftPreviewQueueMessage | TgParagraphStreamQueueMessage | TgRoomSummaryQueueMessage | ThinkApprovalResumeQueueMessage | ThinkCodeModeResumeQueueMessage | ThinkSdkActionStateQueueMessage | ThinkSdkActionDecisionQueueMessage;

export type Scope =
  | "chat:proxy"
  | "memory:read"
  | "memory:write"
  | "cache:read"
  | "cache:write"
  | "debug:read"
  | "export:read";

export type InjectionMode = "rag" | "full" | "hybrid" | "none";
export type MemoryMode = "external" | "builtin" | "hybrid" | "none";

export interface KeyProfile {
  source: string;
  namespace: string;
  scopes: Scope[];
  injectionMode: InjectionMode;
  memoryMode: MemoryMode;
  allowModelPassthrough: boolean;
  debug: boolean;
}

export interface AuthResult {
  ok: true;
  profile: KeyProfile;
  keyName:
    | "CHATBOX_API_KEY"
    | "IM_API_KEY"
    | "TG_CHAT_API_KEY"
    | "DEBUG_API_KEY"
    | "CACHE_TEST_API_KEY"
    | "OPERIA_CHAT_API_KEY"
    | "RIDDLE_CHAT_API_KEY"
    | "MEMORY_MCP_API_KEY"
    | "AGENT_MEMORY_MCP_API_KEY"
    | "GUIDE_DOG_API_KEY"
    | "OPERIA_SESSION";
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<unknown> | null;
  name?: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index?: number;
  message?: OpenAIChatMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: TokenUsage;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  namespace: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  namespace: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  source: string | null;
  created_at: string;
  turn_order_key?: number | null;
  turn_item_order?: number | null;
}

export interface MemoryRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  status: "active" | "deleted" | "superseded" | "low_confidence" | string;
  pinned: number;
  tags: string | null;
  source: string | null;
  source_message_ids: string | null;
  vector_id: string | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface MemoryProductState {
  memory_id: string;
  namespace: string;
  revision: number;
  starred: number;
  display_pinned: number;
  deleted_at: string | null;
  restore_deadline: string | null;
  status_before_delete: string | null;
  updated_at: string;
}

// v2 字段侧车表 (母帖 #11 第 1 步，sidecar 版)。
// 不放 memories 本体——ALTER ADD COLUMN 不幂等，会让 fork 部署炸。
// memory_id 关联 memories.id，PRIMARY KEY(memory_id) 一对一。
export interface MemoryLifecycleRow {
  memory_id: string;
  namespace: string;
  fact_key: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  review_reason: string | null;
  valid_as_of: string | null;
  last_seen_at: string | null;
  seen_count: number;
  last_injected_at: string | null;
}

export interface MemoryApiRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  status: string;
  pinned: boolean;
  /** Canonical runtime control. Legacy `pinned` remains an alias during migration. */
  runtime_pinned?: boolean;
  /** UI collection metadata only; never consumed by recall, injection, or retention. */
  starred?: boolean;
  /** UI list ordering only; never consumed by recall, injection, or retention. */
  display_pinned?: boolean;
  /** Product mutation revision used by If-Match. */
  revision?: number;
  tags: string[];
  source: string | null;
  source_message_ids: string[];
  vector_id: string | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  deleted_at?: string | null;
  restore_deadline?: string | null;
  score?: number;
  // --- v2 字段 (从 memory_lifecycle 侧车表合并来，可选) ---
  fact_key?: string | null;
  supersedes_id?: string | null;
  superseded_by_id?: string | null;
  review_reason?: string | null;
  valid_as_of?: string | null;
  last_seen_at?: string | null;
  seen_count?: number;
  last_injected_at?: string | null;
}
