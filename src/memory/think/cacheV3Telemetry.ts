export type CacheV3StepObservation = {
  requestId: string;
  stepIndex: number;
  model: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  stablePrefixHash: string;
  messagePrefixHash: string;
  activeToolsHash: string;
  activeToolsCount: number;
  cacheStrategy: "explicit_v2" | "automatic_v3" | "anchored_v3";
  effectiveToolChoice: string;
  effectiveInstructionsHash: string;
  toolCatalogRevision: string | null;
  toolName: string | null;
  payloadBytes: number;
  cacheMode: "explicit_v2" | "automatic_v3";
  contextEditRequested: boolean;
  contextEditApplied: boolean;
  clearedToolUses: number;
  clearedInputTokens: number;
  localPruneApplied: boolean;
  coldReason: "first_seen" | "ttl_elapsed" | "prefix_changed" | "tool_schema_changed" | "below_minimum" | "unknown" | null;
};

export async function persistCacheV3StepObservation(
  db: D1Database,
  input: CacheV3StepObservation,
): Promise<void> {
  await db.prepare(`INSERT INTO think_cache_v3_steps (
    request_id,step_index,model,finish_reason,input_tokens,output_tokens,cache_read_tokens,
    cache_creation_tokens,latency_ms,stable_prefix_hash,message_prefix_hash,active_tools_hash,
    active_tools_count,tool_catalog_revision,tool_name,payload_bytes,cache_mode,cache_strategy,
    effective_tool_choice,effective_instructions_hash,
    context_edit_requested,context_edit_applied,cleared_tool_uses,cleared_input_tokens,
    local_prune_applied,cold_reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(request_id,step_index) DO UPDATE SET
    model=excluded.model,finish_reason=excluded.finish_reason,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
    cache_read_tokens=excluded.cache_read_tokens,cache_creation_tokens=excluded.cache_creation_tokens,
    latency_ms=excluded.latency_ms,stable_prefix_hash=excluded.stable_prefix_hash,message_prefix_hash=excluded.message_prefix_hash,
    active_tools_hash=excluded.active_tools_hash,active_tools_count=excluded.active_tools_count,
    tool_catalog_revision=excluded.tool_catalog_revision,tool_name=excluded.tool_name,payload_bytes=excluded.payload_bytes,
    cache_mode=excluded.cache_mode,cache_strategy=excluded.cache_strategy,
    effective_tool_choice=excluded.effective_tool_choice,effective_instructions_hash=excluded.effective_instructions_hash,
    context_edit_requested=excluded.context_edit_requested,context_edit_applied=excluded.context_edit_applied,
    cleared_tool_uses=excluded.cleared_tool_uses,cleared_input_tokens=excluded.cleared_input_tokens,
    local_prune_applied=excluded.local_prune_applied,cold_reason=excluded.cold_reason`).bind(
    input.requestId, input.stepIndex, input.model, input.finishReason, input.inputTokens, input.outputTokens,
    input.cacheReadTokens, input.cacheCreationTokens, input.latencyMs, input.stablePrefixHash,
    input.messagePrefixHash, input.activeToolsHash, input.activeToolsCount, input.toolCatalogRevision,
    input.toolName, input.payloadBytes, input.cacheMode, input.cacheStrategy, input.effectiveToolChoice,
    input.effectiveInstructionsHash, input.contextEditRequested ? 1 : 0,
    input.contextEditApplied ? 1 : 0, input.clearedToolUses, input.clearedInputTokens,
    input.localPruneApplied ? 1 : 0, input.coldReason, new Date().toISOString(),
  ).run();
}
