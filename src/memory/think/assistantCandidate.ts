import { saveAssistantMessage } from "../../db/messages";
import { getAnthropicCacheTtlMode } from "../../proxy/anthropicAdapter";
import type { Env, TokenUsage } from "../../types";
import { sha256Hex } from "../../utils/hash";
import type { HrsThinkExecutionRow } from "../../runtime/hrsThinkExecutionStore";

const ACCEPTED_THINK_CACHE_MODE = "think-0.15-canary-usage-v2";

type CandidatePayload = {
  content: string;
  finishReason: string | null;
  usage: TokenUsage;
};

type CandidateIdentity = Pick<HrsThinkExecutionRow,
  "conversation_id" | "namespace" | "source" | "request_model" | "upstream_model"
  | "provider" | "archive_idempotency_key" | "tg_batch_key" | "turn_order_key">;

type StoredCandidate = {
  id: string;
  conversation_id: string;
  namespace: string;
  role: string;
  content: string;
  source: string;
  client_message_hash: string | null;
  upstream_model: string | null;
  upstream_provider: string | null;
  request_model: string | null;
  stream: number;
  finish_reason: string | null;
  token_input: number | null;
  token_output: number | null;
  cache_mode: string | null;
  cache_ttl: string | null;
  cache_hit: number;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw_usage_json: string | null;
  publication_state: string;
  publication_ref: string | null;
  turn_order_key: number | null;
  turn_item_order: number | null;
  publication_resolved_at: string | null;
};

export function assertHrsAssistantCandidatePrerequisites(
  env: Pick<Env,"MEMORY_PUBLICATION_STATE_V2_ENABLED">,
  identity: CandidateIdentity,
): void {
  if (!identity.conversation_id) return;
  if (!identity.archive_idempotency_key?.trim()) {
    throw new Error("hrs_assistant_candidate_idempotency_missing");
  }
  if (identity.source !== "telegram") return;
  if (env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true") {
    throw new Error("hrs_assistant_candidate_publication_v2_required");
  }
  const match = /^tg:([a-f0-9]{64})(?::|$)/.exec(identity.archive_idempotency_key);
  if (!match || !identity.tg_batch_key || match[1] !== identity.tg_batch_key) {
    throw new Error("hrs_assistant_candidate_publication_identity_invalid");
  }
}

export async function stageHrsAssistantCandidate(
  env: Env,
  row: HrsThinkExecutionRow,
  payload: CandidatePayload,
): Promise<string | null> {
  assertHrsAssistantCandidatePrerequisites(env,row);
  if (!row.conversation_id) return null;
  const saved = await saveAssistantMessage(env.DB,{
    conversationId:row.conversation_id,
    namespace:row.namespace,
    source:row.source,
    content:payload.content,
    requestModel:row.request_model,
    upstreamModel:row.upstream_model,
    provider:row.provider,
    stream:false,
    finishReason:payload.finishReason,
    usage:payload.usage,
    cacheMode:ACCEPTED_THINK_CACHE_MODE,
    cacheTtl:getAnthropicCacheTtlMode(env),
    idempotencyKey:row.archive_idempotency_key,
    turnOrderKey:row.turn_order_key,
    publicationStateV2Enabled:env.MEMORY_PUBLICATION_STATE_V2_ENABLED === "true",
  });
  const exact = await requireExactHrsAssistantCandidate(env,row,payload);
  if (exact !== saved.id) throw new Error("hrs_assistant_candidate_identity_conflict");
  return exact;
}

export async function requireExactHrsAssistantCandidate(
  env: Env,
  row: HrsThinkExecutionRow,
  payload: CandidatePayload,
  options: { allowResolvedPublication?: boolean } = {},
): Promise<string | null> {
  assertHrsAssistantCandidatePrerequisites(env,row);
  if (!row.conversation_id || !row.archive_idempotency_key) return null;
  const idempotencyHash = await sha256Hex(
    `${row.conversation_id}:${row.namespace}:assistant-final:${row.archive_idempotency_key}`,
  );
  const expectedId = `msg_${idempotencyHash.slice(0,32)}`;
  const stored = await env.DB.prepare(`SELECT id,conversation_id,namespace,role,content,source,
      client_message_hash,upstream_model,upstream_provider,request_model,stream,finish_reason,
      token_input,token_output,cache_mode,cache_ttl,cache_hit,cache_read_tokens,
      cache_creation_tokens,raw_usage_json,publication_state,publication_ref,turn_order_key,
      turn_item_order,publication_resolved_at
    FROM messages WHERE id=?`).bind(expectedId).first<StoredCandidate>();
  const publicationRef = row.source === "telegram" ? `tg:${row.tg_batch_key}` : null;
  const publicationState = row.source === "telegram" ? "generated_unconfirmed" : "delivered";
  const publicationStateMatches = row.source !== "telegram"
    ? stored?.publication_state === publicationState
    : options.allowResolvedPublication
      ? ["generated_unconfirmed","delivered","delivered_partial","delivery_unknown","excluded"]
        .includes(stored?.publication_state ?? "")
      : stored?.publication_state === publicationState;
  const cacheRead = payload.usage.cache_read_input_tokens ?? null;
  const expected = Boolean(stored
    && stored.id === expectedId
    && stored.conversation_id === row.conversation_id
    && stored.namespace === row.namespace
    && stored.role === "assistant"
    && stored.content === payload.content
    && stored.source === row.source
    && stored.client_message_hash === idempotencyHash
    && stored.upstream_model === row.upstream_model
    && stored.upstream_provider === row.provider
    && stored.request_model === row.request_model
    && stored.stream === 0
    && stored.finish_reason === payload.finishReason
    && stored.token_input === (payload.usage.prompt_tokens ?? payload.usage.input_tokens ?? null)
    && stored.token_output === (payload.usage.completion_tokens ?? payload.usage.output_tokens ?? null)
    && stored.cache_mode === ACCEPTED_THINK_CACHE_MODE
    && stored.cache_ttl === getAnthropicCacheTtlMode(env)
    && stored.cache_hit === (typeof cacheRead === "number" && cacheRead > 0 ? 1 : 0)
    && stored.cache_read_tokens === cacheRead
    && stored.cache_creation_tokens === (payload.usage.cache_creation_input_tokens ?? null)
    && stored.raw_usage_json === JSON.stringify(payload.usage)
    && publicationStateMatches
    && stored.publication_ref === publicationRef
    && stored.turn_order_key === row.turn_order_key
    && stored.turn_item_order === 1
    && (row.source !== "telegram" || options.allowResolvedPublication || stored.publication_resolved_at === null));
  if (!expected) throw new Error("hrs_assistant_candidate_identity_conflict");
  return expectedId;
}
