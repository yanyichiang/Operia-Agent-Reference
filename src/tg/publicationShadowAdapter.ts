import type { Env, OpenAIChatResponse } from "../types";
import {
  comparePublicationShadowReadOnly,
  projectPublicationShadow,
  recordShadowProjectionDiagnostic,
  type ShadowLegacyPath,
  type ShadowLegacyProjection,
  type ShadowNormalizedEvidence,
  type ShadowOpenSequenceDivergenceCode,
  type ShadowProjectionInput,
} from "../publication/shadow";
import type {
  InferenceRunCompleteness,
  NormalizedDeliveryEvidenceClass,
  PublicationPurpose,
  PublicationStageBatch,
  PublicationStageItem,
  PublicationTextRole,
} from "../publication/types";
import { splitIntoBubbles } from "./telegram";

type PublicationShadowEnv = Pick<Env,
  "DB"|"PUBLICATION_OUTCOME_SHADOW_ENABLED"|"PUBLICATION_DELIVERY_AUTHORITY_ENABLED"
>;

export type PublicationShadowObservation =
  | { kind:"disabled" }
  | { kind:"projected"; publicationId:string; state:"delivered"|"rejected"|"unknown"; divergenceCode:string; replayed:boolean; sequenceSealed:boolean }
  | { kind:"classified"; publicationId:string; divergenceCode:string }
  | { kind:"failed_open"; publicationId:string; divergenceCode:"SHADOW_PROJECTION_ERROR" };

type LegacyOutboxRow = {
  id: string;
  intent_key: string;
  payload_json: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  bubble_index?: number | null;
};

type LegacyInferenceRow = {
  batch_key: string;
  chat_id: string;
  status: string;
  first_response_json: string | null;
  final_package_json: string | null;
  terminal_completeness: string | null;
  created_at: string;
  updated_at: string;
};

type LegacyDeliveryBatchRow = {
  batch_key: string;
  outbox_ids_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type LegacyParagraphBatchRow = {
  batch_key: string;
  state: string;
  final_closed: number;
  created_at: string;
  updated_at: string;
};

type LegacyParagraphItemRow = LegacyOutboxRow & {
  bubble_index: number;
  item_kind?: string;
  canonical_bubble_index?: number | null;
  text: string;
  effective_payload_json: string;
  outbox_present: number;
};

type LegacyContinuationRow = {
  id: string;
  task_id: string;
  chat_id: string;
  batch_key: string;
  status: string;
  final_response_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type LegacyReceiptRow = {
  receipt_id: string;
  root_task_id: string | null;
  delivery_status: string;
  created_at: string;
  updated_at: string;
};

type ParsedFinalPackage = {
  response?: OpenAIChatResponse;
  toolTraces?: unknown[];
};

type MappedShadow = {
  input: ShadowProjectionInput;
};

type DurableTextProjection =
  | { kind:"representable"; textRole:PublicationTextRole; visibleTextFragment:string | null }
  | { kind:"unrepresentable" };

function shadowEnabled(env: PublicationShadowEnv): boolean {
  return env.PUBLICATION_OUTCOME_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

function nativeAuthorityEnabled(env: PublicationShadowEnv): boolean {
  return "PUBLICATION_DELIVERY_AUTHORITY_ENABLED" in env
    && env.PUBLICATION_DELIVERY_AUTHORITY_ENABLED?.trim().toLowerCase() === "true";
}

function isRecord(value: unknown): value is Record<string,unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: string): Record<string,unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseFinalPackage(value: string): ParsedFinalPackage | null {
  const parsed = parseRecord(value);
  if (!parsed) return null;
  const response = isRecord(parsed.response) ? parsed.response as OpenAIChatResponse : undefined;
  return { response,toolTraces:Array.isArray(parsed.toolTraces) ? parsed.toolTraces : [] };
}

function assistantText(response: OpenAIChatResponse | undefined): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (content == null) return "";
  return JSON.stringify(content).trim();
}

function systemNotice(response: OpenAIChatResponse | undefined): string | null {
  const think = response?.operia_think;
  if (!isRecord(think)) return null;
  const notice = think.channel_notice;
  if (notice === "tool_call_failed") return "系统提示：工具调用失败，未返回结果；系统没有自动重试。";
  if (notice === "tool_call_rejected") return "系统提示：工具调用已拒绝，未执行，也没有返回结果。";
  return null;
}

function staticFallback(response: OpenAIChatResponse | undefined): boolean {
  const finalization = response?.operia_telegram_finalization;
  return isRecord(finalization)
    && typeof finalization.disposition === "string"
    && finalization.disposition.startsWith("static_fallback_");
}

function generationCompleteness(
  durable: string | null,
  response: OpenAIChatResponse | undefined,
): InferenceRunCompleteness | null {
  if (durable === "complete" || durable === "partial" || durable === "failed" || durable === "attention") {
    return durable;
  }
  const raw = response?.choices?.[0]?.finish_reason;
  const reason = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (["stop","end_turn","stop_sequence"].includes(reason)) return "complete";
  if (["length","max_tokens"].includes(reason)) return "partial";
  if (reason === "error") return "failed";
  return reason ? "attention" : null;
}

function plainPayloadProjection(
  payloadJson: string,
  purpose: PublicationPurpose,
): DurableTextProjection {
  const payload = parseRecord(payloadJson);
  if (!payload) return {kind:"unrepresentable"};
  const raw = typeof payload.text === "string" ? payload.text
    : typeof payload.caption === "string" ? payload.caption : null;
  if (raw === null) {
    return {kind:"representable",textRole:"none",visibleTextFragment:null};
  }
  const trimmed = raw.trim();
  if (!trimmed) return {kind:"representable",textRole:"none",visibleTextFragment:null};
  if (typeof payload.parse_mode === "string" && payload.parse_mode.trim()) {
    return {kind:"unrepresentable"};
  }
  return {
    kind:"representable",
    textRole:purpose === "assistant_response" ? "assistant" : "system",
    visibleTextFragment:trimmed,
  };
}

/** Telegram-specific error classification ends here. Publication receives only
 * normalized evidence classes. */
export function classifyLegacyTelegramOutboxEvidence(
  row: Pick<LegacyOutboxRow,"status"|"last_error">,
): NormalizedDeliveryEvidenceClass | null {
  if (row.status === "pending" || row.status === "leased") return "pending";
  if (row.status === "sending") return "sending";
  if (row.status === "sent") return "sent";
  if (row.status !== "attention_required") return null;
  if (row.last_error === "telegram_http_400") return "rejected";
  if ([
    "telegram_send_outcome_unknown",
    "send_outcome_unknown",
    "telegram_edit_outcome_unknown_retryable",
  ].includes(row.last_error ?? "")) return "unknown";
  return null;
}

function evidenceFromOutbox(row: LegacyOutboxRow): ShadowNormalizedEvidence | null {
  const evidenceClass = classifyLegacyTelegramOutboxEvidence(row);
  if (!evidenceClass) return null;
  return {
    deliveryItemId:`shadow:tg-outbox:${row.id}`,
    evidenceRef:evidenceClass === "pending" ? null : `legacy-tg-outbox:${row.id}:${evidenceClass}`,
    evidenceClass,
    observedAt:row.updated_at,
  };
}

function stageItemFromOutbox(
  row: LegacyOutboxRow,
  deliveryBatchId: string,
  sequenceIndex: number,
  projection: Extract<DurableTextProjection,{kind:"representable"}>,
): PublicationStageItem {
  return {
    deliveryItemId:`shadow:tg-outbox:${row.id}`,
    payloadRef:`tg-outbox:${row.id}`,
    intentKey:row.intent_key,
    deliveryBatchId,
    sequenceIndex,
    required:true,
    textRole:projection.textRole,
    visibleTextFragment:projection.visibleTextFragment,
  };
}

function durableCanonicalProjection(
  fragment: string,
  purpose: PublicationPurpose,
): Extract<DurableTextProjection,{kind:"representable"}> {
  return {
    kind:"representable",
    textRole:purpose === "assistant_response" ? "assistant" : "system",
    visibleTextFragment:fragment.trim(),
  };
}

function legacyProjection(
  state: ShadowLegacyProjection["state"],
  visibleText: string | null,
  options: { directAppend?:boolean } = {},
): ShadowLegacyProjection {
  if (options.directAppend) {
    return { state,conversationDisposition:"publish",memoryDisposition:"publish",visibleText };
  }
  if (state === "delivered") {
    return { state,conversationDisposition:"publish",memoryDisposition:"publish",visibleText };
  }
  if (state === "delivered_partial") {
    return { state,conversationDisposition:"publish",memoryDisposition:"exclude",visibleText };
  }
  if (state === "delivery_unknown") {
    return { state,conversationDisposition:"exclude",memoryDisposition:"hold",visibleText:null };
  }
  return { state,conversationDisposition:"exclude",memoryDisposition:"exclude",visibleText:null };
}

function emptyStage(
  publicationId: string,
  inferenceRunId: string,
  recipientScope: string,
  purpose: PublicationPurpose,
  createdAt: string,
): ShadowProjectionInput["stage"] {
  return {
    publicationId,channel:"telegram",recipientScope,inferenceRunId,purpose,
    batches:[],items:[],createdAt,
  };
}

function terminalEvidenceComplete(evidence: ShadowNormalizedEvidence[], items: PublicationStageItem[]): boolean {
  if (evidence.length !== items.length) return false;
  const byItem = new Map(evidence.map((item) => [item.deliveryItemId,item.evidenceClass]));
  return items.every((item) => {
    const state = byItem.get(item.deliveryItemId);
    return state === "sent" || state === "rejected" || state === "unknown" || state === "skipped";
  });
}

const GENERATION_COMPLETENESS_NOTICES: Partial<Record<InferenceRunCompleteness,string>> = {
  partial:"（这次回复因模型输出上限而不完整；系统没有自动续写。）",
  failed:"（这次模型回复以错误状态结束；系统没有自动重试。）",
  attention:"（这次模型回复的结束状态无法确认；系统没有自动重试。）",
};

function canonicalInferenceTextFragments(
  response: OpenAIChatResponse,
  completeness: InferenceRunCompleteness | null,
  purpose: PublicationPurpose,
): Array<Extract<DurableTextProjection,{kind:"representable"}>> {
  const notice = systemNotice(response);
  const base = notice ? [notice] : splitIntoBubbles(assistantText(response));
  const fragments = base.map((fragment) => durableCanonicalProjection(fragment,purpose));
  const completenessNotice = completeness ? GENERATION_COMPLETENESS_NOTICES[completeness] : null;
  if (completenessNotice && !notice) {
    fragments.push({kind:"representable",textRole:"system",visibleTextFragment:completenessNotice});
  }
  return fragments;
}

function inferenceOutboxProjection(
  row: LegacyOutboxRow,
  batchKey: string,
  canonicalTextFragments: Array<Extract<DurableTextProjection,{kind:"representable"}>>,
  purpose: PublicationPurpose,
): DurableTextProjection {
  const text = row.intent_key.match(new RegExp(`^tg-agent:${escapeRegExp(batchKey)}:text:(\\d+)$`));
  if (text) return canonicalTextFragments[Number(text[1])] ?? {kind:"unrepresentable"};
  if (row.intent_key.startsWith(`tg-agent:${batchKey}:result:`)
    || row.intent_key.startsWith(`tg-agent:${batchKey}:media:`)) {
    return plainPayloadProjection(row.payload_json,purpose);
  }
  return {kind:"unrepresentable"};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

function parseOutboxIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function hasToolContinuation(firstResponseJson: string | null, pkg: ParsedFinalPackage): boolean {
  if ((pkg.toolTraces?.length ?? 0) > 0) return true;
  if (!firstResponseJson) return false;
  const first = parseRecord(firstResponseJson) as OpenAIChatResponse | null;
  return Array.isArray(first?.choices?.[0]?.message?.tool_calls)
    && (first?.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0;
}

async function readOutboxRows(db: D1Database, ids: string[]): Promise<Map<string,LegacyOutboxRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.prepare(`SELECT id,intent_key,payload_json,status,last_error,created_at,updated_at
    FROM tg_agent_outbox WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<LegacyOutboxRow>();
  return new Map((rows.results ?? []).map((row) => [row.id,row]));
}

async function mapInferencePublication(db: D1Database, batchKey: string): Promise<MappedShadow> {
  const run = await db.prepare(`SELECT batch_key,chat_id,status,first_response_json,final_package_json,
      terminal_completeness,created_at,updated_at FROM tg_chat_inference_runs WHERE batch_key=?`)
    .bind(batchKey).first<LegacyInferenceRow>();
  const publicationId = `pub:telegram:inference:${batchKey}`;
  const inferenceRunId = `tg-inference:${batchKey}`;
  const fallbackCreatedAt = run?.created_at ?? new Date(0).toISOString();
  if (!run || !run.final_package_json) {
    return {
      input:{
        stage:emptyStage(publicationId,inferenceRunId,run?.chat_id ?? "unknown","assistant_response",fallbackCreatedAt),
        evidence:[],consumptionContext:{generationCompleteness:null},
        legacyPath:"ordinary_delivery_batch",legacy:legacyProjection("excluded",null),
        observedAt:run?.updated_at ?? fallbackCreatedAt,
        sequenceClosure:{kind:"open",divergenceCode:"SHADOW_ADAPTER_EVIDENCE_INCOMPLETE"},
      },
    };
  }
  const pkg = parseFinalPackage(run.final_package_json);
  if (!pkg?.response) {
    return {
      input:{
        stage:emptyStage(publicationId,inferenceRunId,run.chat_id,"assistant_response",run.created_at),
        evidence:[],consumptionContext:{generationCompleteness:null},legacyPath:"ordinary_delivery_batch",
        legacy:legacyProjection("excluded",null),observedAt:run.updated_at,
        sequenceClosure:{kind:"open",divergenceCode:"SHADOW_ADAPTER_UNREPRESENTABLE"},
      },
    };
  }
  const notice = systemNotice(pkg.response);
  const purpose: PublicationPurpose = notice || staticFallback(pkg.response) ? "non_assistant" : "assistant_response";
  const completeness = generationCompleteness(run.terminal_completeness,pkg.response);
  const batch = await db.prepare(`SELECT batch_key,outbox_ids_json,status,created_at,updated_at,completed_at
    FROM tg_chat_delivery_batches WHERE batch_key=?`).bind(batchKey).first<LegacyDeliveryBatchRow>();
  const paragraphBatch = await db.prepare(`SELECT batch_key,state,final_closed,created_at,updated_at
    FROM tg_paragraph_stream_batches WHERE batch_key=?`).bind(batchKey).first<LegacyParagraphBatchRow>();
  const paragraphRows = paragraphBatch
    ? await db.prepare(`SELECT i.*,i.outbox_id AS id,COALESCE(o.intent_key,'') AS intent_key,
        COALESCE(o.payload_json,json_object('text',i.text)) AS effective_payload_json,
        COALESCE(o.status,'missing') AS status,o.last_error,i.created_at,
        COALESCE(o.updated_at,i.created_at) AS updated_at,i.bubble_index,i.text,
        CASE WHEN o.id IS NULL THEN 0 ELSE 1 END AS outbox_present
      FROM tg_paragraph_stream_items i LEFT JOIN tg_agent_outbox o ON o.id=i.outbox_id
      WHERE i.batch_key=? ORDER BY i.bubble_index`).bind(batchKey).all<LegacyParagraphItemRow>()
    : { results:[] as LegacyParagraphItemRow[] };
  const paragraphItems = paragraphRows.results ?? [];
  const outboxIds = batch ? parseOutboxIds(batch.outbox_ids_json) : null;
  const finalRowsById = outboxIds ? await readOutboxRows(db,outboxIds) : new Map<string,LegacyOutboxRow>();
  const finalRows = outboxIds?.flatMap((id) => finalRowsById.get(id) ?? []) ?? [];

  const batches: PublicationStageBatch[] = [];
  const items: PublicationStageItem[] = [];
  const evidence: ShadowNormalizedEvidence[] = [];
  const comparisonEvidenceRefs: string[] = [];
  let textProjectionUnrepresentable = false;
  let sequenceIndex = 0;
  if (paragraphBatch) {
    const paragraphDeliveryBatchId = `paragraph:${batchKey}`;
    batches.push({deliveryBatchId:paragraphDeliveryBatchId,batchOrder:batches.length});
    for (const row of paragraphItems) {
      const toolPresentation = row.item_kind === "tool";
      const normalized: LegacyOutboxRow = row.outbox_present === 1
        ? {...row,payload_json:row.effective_payload_json}
        : {
        ...row,intent_key:toolPresentation
          ? `tg-agent:${batchKey}:presentation:tool:${row.bubble_index}`
          : `tg-agent:${batchKey}:text:${row.canonical_bubble_index ?? row.bubble_index}`,
        payload_json:row.effective_payload_json,
      };
      items.push(stageItemFromOutbox(
        normalized,paragraphDeliveryBatchId,sequenceIndex++,toolPresentation
          ? {kind:"representable",textRole:"none",visibleTextFragment:null}
          : durableCanonicalProjection(row.text,purpose),
      ));
      const itemEvidence = row.outbox_present === 1 ? evidenceFromOutbox(normalized) : null;
      if (itemEvidence) evidence.push(itemEvidence);
    }
  }
  const canonicalTextFragments = canonicalInferenceTextFragments(pkg.response,completeness,purpose);
  if (batch && outboxIds) {
    batches.push({deliveryBatchId:batch.batch_key,batchOrder:batches.length});
    for (const row of finalRows) {
      const itemEvidence = evidenceFromOutbox(row);
      const projection = inferenceOutboxProjection(row,batchKey,canonicalTextFragments,purpose);
      if (projection.kind === "unrepresentable") {
        textProjectionUnrepresentable = true;
        if (itemEvidence?.evidenceRef) comparisonEvidenceRefs.push(itemEvidence.evidenceRef);
        continue;
      }
      items.push(stageItemFromOutbox(row,batch.batch_key,sequenceIndex++,projection));
      if (itemEvidence) evidence.push(itemEvidence);
    }
  }

  const path: ShadowLegacyPath = paragraphItems.length > 0 ? "paragraph_prefix_final"
    : hasToolContinuation(run.first_response_json,pkg) ? "continuation_final" : "ordinary_delivery_batch";
  const observedAt = batch?.completed_at ?? batch?.updated_at ?? paragraphBatch?.updated_at ?? run.updated_at;
  const legacyState: ShadowLegacyProjection["state"] = batch?.status === "completed"
    ? purpose === "non_assistant" ? "excluded"
      : completeness === "complete" ? "delivered" : "delivered_partial"
    : batch?.status === "attention_required" ? "delivery_unknown" : "excluded";
  const legacyText = legacyState === "delivered" ? assistantText(pkg.response)
    : legacyState === "delivered_partial" ? `[回复不完整]\n${assistantText(pkg.response)}`.trim() : null;
  const input: ShadowProjectionInput = {
    stage:{
      publicationId,channel:"telegram",recipientScope:run.chat_id,inferenceRunId,purpose,
      batches:items.length > 0 ? batches : [],items,
      createdAt:batch?.created_at ?? paragraphBatch?.created_at ?? run.created_at,
    },
    evidence,
    comparisonEvidenceRefs,
    consumptionContext:{generationCompleteness:purpose === "assistant_response" ? completeness : null},
    legacyPath:path,
    legacy:legacyProjection(legacyState,legacyText),
    observedAt,
    sequenceClosure:{kind:"open",divergenceCode:"LEGACY_EVIDENCE_INCOMPLETE"},
  };
  const structureComplete = Boolean(batch && outboxIds
    && finalRows.length === outboxIds.length
    && (!paragraphBatch || (paragraphBatch.final_closed === 1 && paragraphBatch.state === "closed")));
  const deliveryEvidenceComplete = terminalEvidenceComplete(evidence,items)
    && items.length === paragraphItems.length + finalRows.length;
  let openCode: ShadowOpenSequenceDivergenceCode | null = null;
  if (textProjectionUnrepresentable) openCode = "SHADOW_TEXT_PROJECTION_UNREPRESENTABLE";
  else if (!batch || (paragraphBatch && (paragraphBatch.final_closed !== 1 || paragraphBatch.state !== "closed"))) {
    openCode = "SHADOW_REQUIRED_SEQUENCE_OPEN";
  } else if (!structureComplete || !deliveryEvidenceComplete || items.length === 0 || completeness === null) {
    openCode = "LEGACY_EVIDENCE_INCOMPLETE";
  }
  input.sequenceClosure = openCode
    ? {kind:"open",divergenceCode:openCode}
    : {
        kind:"closed",
        evidenceRef:`legacy-tg-publication:${batchKey}:required-sequence-closed`,
        observedAt,
      };
  return { input };
}

function directFinalOrder(left: LegacyOutboxRow, right: LegacyOutboxRow): number {
  const key = (row: LegacyOutboxRow): [number,number,number] => {
    const text = row.intent_key.match(/:final:text:(\d+)$/);
    if (text) return [0,Number(text[1]),0];
    const media = row.intent_key.match(/:final:media:(\d+):(\d+)$/);
    if (media) return [1,Number(media[1]),Number(media[2])];
    return [2,0,0];
  };
  const a = key(left); const b = key(right);
  return a[0]-b[0] || a[1]-b[1] || a[2]-b[2] || left.id.localeCompare(right.id);
}

async function mapDurableContinuation(db: D1Database, continuationId: string): Promise<MappedShadow> {
  const row = await db.prepare(`SELECT id,task_id,chat_id,batch_key,status,final_response_json,last_error,created_at,updated_at
    FROM tg_agent_continuations WHERE id=?`).bind(continuationId).first<LegacyContinuationRow>();
  const publicationId = `pub:telegram:continuation:${continuationId}`;
  const inferenceRunId = `tg-continuation:${continuationId}`;
  const createdAt = row?.created_at ?? new Date(0).toISOString();
  if (!row?.final_response_json) {
    return {
      input:{
        stage:emptyStage(publicationId,inferenceRunId,row?.chat_id ?? "unknown","assistant_response",createdAt),
        evidence:[],consumptionContext:{generationCompleteness:null},legacyPath:"deliver_durable_final",
        legacy:legacyProjection("excluded",null),observedAt:row?.updated_at ?? createdAt,
        sequenceClosure:{kind:"open",divergenceCode:"SHADOW_ADAPTER_EVIDENCE_INCOMPLETE"},
      },
    };
  }
  const response = parseRecord(row.final_response_json) as OpenAIChatResponse | null;
  const completeness = generationCompleteness(null,response ?? undefined);
  const outbox = await db.prepare(`SELECT id,intent_key,payload_json,status,last_error,created_at,updated_at
    FROM tg_agent_outbox WHERE intent_key LIKE ? OR intent_key LIKE ?`)
    .bind(`tg-agent:${row.batch_key}:final:text:%`,`tg-agent:${row.batch_key}:final:media:%`)
    .all<LegacyOutboxRow>();
  const rows = [...(outbox.results ?? [])].sort(directFinalOrder);
  const directTextRows = rows.filter((outboxRow) => outboxRow.intent_key.includes(":final:text:"));
  const canonicalBubbles = response ? splitIntoBubbles(assistantText(response)) : [];
  const canonicalTextStart = directTextRows.length - canonicalBubbles.length;
  const directTextProjectionById = new Map<string,DurableTextProjection>();
  for (const [index,outboxRow] of directTextRows.entries()) {
    directTextProjectionById.set(outboxRow.id,
      canonicalTextStart >= 0 && index >= canonicalTextStart
        ? durableCanonicalProjection(canonicalBubbles[index-canonicalTextStart],"assistant_response")
        : plainPayloadProjection(outboxRow.payload_json,"assistant_response"));
  }
  const batches: PublicationStageBatch[] = [];
  const items: PublicationStageItem[] = [];
  const evidence: ShadowNormalizedEvidence[] = [];
  const comparisonEvidenceRefs: string[] = [];
  let textProjectionUnrepresentable = false;
  let currentBatch = "";
  for (const [index,outboxRow] of rows.entries()) {
    const batchId = outboxRow.intent_key.includes(":final:text:")
      ? `legacy-direct:${row.batch_key}:final:text`
      : `legacy-direct:${row.batch_key}:final:media:${outboxRow.intent_key.match(/:final:media:(\d+):/)?.[1] ?? "unknown"}`;
    if (batchId !== currentBatch) {
      currentBatch = batchId;
      batches.push({deliveryBatchId:batchId,batchOrder:batches.length});
    }
    const normalized = evidenceFromOutbox(outboxRow);
    const projection = directTextProjectionById.get(outboxRow.id)
      ?? plainPayloadProjection(outboxRow.payload_json,"assistant_response");
    if (projection.kind === "unrepresentable") {
      textProjectionUnrepresentable = true;
      if (normalized?.evidenceRef) comparisonEvidenceRefs.push(normalized.evidenceRef);
      continue;
    }
    items.push(stageItemFromOutbox(outboxRow,batchId,index,projection));
    if (normalized) evidence.push(normalized);
  }
  const legacyState: ShadowLegacyProjection["state"] = row.status === "completed"
    ? completeness === "complete" ? "delivered" : "delivered_partial"
    : row.status === "attention_required" ? "delivery_unknown" : "excluded";
  const input: ShadowProjectionInput = {
    stage:{
      publicationId,channel:"telegram",recipientScope:row.chat_id,inferenceRunId,purpose:"assistant_response",
      batches:items.length > 0 ? batches : [],items,createdAt:row.created_at,
    },
    evidence,
    comparisonEvidenceRefs,
    consumptionContext:{generationCompleteness:completeness},
    legacyPath:"deliver_durable_final",
    legacy:legacyProjection(legacyState,legacyState === "delivered" || legacyState === "delivered_partial"
      ? assistantText(response ?? undefined) : null,{directAppend:row.status === "completed"}),
    observedAt:row.updated_at,
    sequenceClosure:{kind:"open",divergenceCode:"LEGACY_EVIDENCE_INCOMPLETE"},
  };
  let openCode: ShadowOpenSequenceDivergenceCode | null = null;
  if (textProjectionUnrepresentable) openCode = "SHADOW_TEXT_PROJECTION_UNREPRESENTABLE";
  else if (row.status !== "completed") openCode = "SHADOW_REQUIRED_SEQUENCE_OPEN";
  else if (!response || completeness === null || items.length === 0
    || items.length !== rows.length || !terminalEvidenceComplete(evidence,items)) {
    openCode = "LEGACY_EVIDENCE_INCOMPLETE";
  }
  input.sequenceClosure = openCode
    ? {kind:"open",divergenceCode:openCode}
    : {
        kind:"closed",
        evidenceRef:`legacy-tg-continuation:${continuationId}:required-sequence-closed`,
        observedAt:row.updated_at,
      };
  return { input };
}

async function mapToolCommandBypass(
  db: D1Database,
  input: { chatId:string; taskId:string; receiptId:string },
): Promise<MappedShadow> {
  const receipt = await db.prepare(`SELECT receipt_id,root_task_id,delivery_status,created_at,updated_at
    FROM tg_system_receipts WHERE receipt_id=?`).bind(input.receiptId).first<LegacyReceiptRow>();
  const publicationId = `pub:telegram:tool-command:${input.taskId}`;
  const inferenceRunId = `tg-tool-command:${input.taskId}`;
  const createdAt = receipt?.created_at ?? new Date(0).toISOString();
  const rows = receipt ? await db.prepare(`SELECT id,intent_key,payload_json,status,last_error,created_at,updated_at,bubble_index
    FROM tg_agent_outbox WHERE receipt_id=? ORDER BY bubble_index,id`)
    .bind(receipt.receipt_id).all<LegacyOutboxRow>() : {results:[] as LegacyOutboxRow[]};
  const outboxRows = rows.results ?? [];
  const batchId = `legacy-receipt:${input.receiptId}`;
  const items: PublicationStageItem[] = [];
  const evidence: ShadowNormalizedEvidence[] = [];
  const comparisonEvidenceRefs: string[] = [];
  const visibleFragments: string[] = [];
  for (const [index,row] of outboxRows.entries()) {
    const normalized = evidenceFromOutbox(row);
    const projection = plainPayloadProjection(row.payload_json,"assistant_response");
    if (projection.kind === "unrepresentable") {
      if (normalized?.evidenceRef) comparisonEvidenceRefs.push(normalized.evidenceRef);
      continue;
    }
    items.push(stageItemFromOutbox(row,batchId,index,projection));
    if (normalized) evidence.push(normalized);
    if (projection.visibleTextFragment) visibleFragments.push(projection.visibleTextFragment);
  }
  const batches = items.length > 0 ? [{deliveryBatchId:batchId,batchOrder:0}] : [];
  const legacyState: ShadowLegacyProjection["state"] = receipt?.delivery_status === "Sent"
    ? "delivered" : "delivery_unknown";
  const legacyText = visibleFragments.join("\n\n") || null;
  return {
    input:{
      stage:{
        publicationId,channel:"telegram",recipientScope:input.chatId,inferenceRunId,purpose:"assistant_response",
        batches,items,createdAt,
      },
      evidence,
      comparisonEvidenceRefs,
      // The legacy bypass discarded its inference completeness before the
      // durable receipt was staged. Gate B records the gap instead of guessing.
      consumptionContext:{generationCompleteness:null},
      legacyPath:"tool_command_direct_append",
      legacy:legacyProjection(legacyState,legacyText,{directAppend:true}),
      observedAt:receipt?.updated_at ?? createdAt,
      sequenceClosure:{kind:"open",divergenceCode:"LEGACY_DIRECT_APPEND_BYPASS"},
      forcedDivergenceCode:"LEGACY_DIRECT_APPEND_BYPASS",
    },
  };
}

function boundedShadowErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (/^[a-z0-9_:-]{1,120}$/i.test(error.message)) return error.message;
  return error.name || "error";
}

async function observeMapped(
  env: PublicationShadowEnv,
  base: { publicationId:string; inferenceRunId:string; recipientScope:string; legacyPath:ShadowLegacyPath },
  mapper: () => Promise<MappedShadow>,
): Promise<PublicationShadowObservation> {
  if (!shadowEnabled(env)) return {kind:"disabled"};
  let mapped: MappedShadow | null = null;
  try {
    mapped = await mapper();
    if (nativeAuthorityEnabled(env)) {
      const compared = await comparePublicationShadowReadOnly(env.DB,mapped.input);
      if (!compared.outcome) {
        return {
          kind:"classified",publicationId:mapped.input.stage.publicationId,
          divergenceCode:compared.comparison.divergenceCode,
        };
      }
      return {
        kind:"projected",publicationId:mapped.input.stage.publicationId,state:compared.outcome.state,
        divergenceCode:compared.comparison.divergenceCode,replayed:compared.replayed,sequenceSealed:true,
      };
    }
    const projected = await projectPublicationShadow(env.DB,mapped.input);
    if (projected.kind === "open") {
      return {
        kind:"classified",publicationId:mapped.input.stage.publicationId,
        divergenceCode:projected.comparison.divergenceCode,
      };
    }
    return {
      kind:"projected",publicationId:mapped.input.stage.publicationId,state:projected.outcome.state,
      divergenceCode:projected.comparison.divergenceCode,replayed:projected.replayed,
      sequenceSealed:projected.sequenceSealed,
    };
  } catch (error) {
    const observedAt = mapped?.input.observedAt ?? new Date().toISOString();
    const stage = mapped?.input.stage ?? emptyStage(
      base.publicationId,base.inferenceRunId,base.recipientScope,"assistant_response",observedAt,
    );
    try {
      await recordShadowProjectionDiagnostic(env.DB,{
        stage,legacyPath:mapped?.input.legacyPath ?? base.legacyPath,
        legacy:mapped?.input.legacy ?? {state:null,conversationDisposition:null,memoryDisposition:null,visibleText:null},
        observedAt,
        evidenceRefs:[
          ...(mapped?.input.comparisonEvidenceRefs ?? []),
          ...(mapped?.input.evidence.flatMap((item) => item.evidenceRef ? [item.evidenceRef] : []) ?? []),
        ],
        divergenceCode:"SHADOW_PROJECTION_ERROR",
      });
    } catch {
      // The shadow schema itself may be unavailable. Gate B remains fail-open.
    }
    console.warn("publication_shadow_projection_failed",{
      legacyPath:mapped?.input.legacyPath ?? base.legacyPath,
      publicationId:base.publicationId,
      code:boundedShadowErrorCode(error),
    });
    return {kind:"failed_open",publicationId:base.publicationId,divergenceCode:"SHADOW_PROJECTION_ERROR"};
  }
}

export async function observeLegacyInferencePublicationShadow(
  env: PublicationShadowEnv,
  batchKey: string,
): Promise<PublicationShadowObservation> {
  return observeMapped(env,{
    publicationId:`pub:telegram:inference:${batchKey}`,
    inferenceRunId:`tg-inference:${batchKey}`,
    recipientScope:"unknown",
    legacyPath:"ordinary_delivery_batch",
  },() => mapInferencePublication(env.DB,batchKey));
}

export async function observeLegacyContinuationPublicationShadow(
  env: PublicationShadowEnv,
  input: { continuationId:string; chatId:string },
): Promise<PublicationShadowObservation> {
  return observeMapped(env,{
    publicationId:`pub:telegram:continuation:${input.continuationId}`,
    inferenceRunId:`tg-continuation:${input.continuationId}`,
    recipientScope:input.chatId,
    legacyPath:"deliver_durable_final",
  },() => mapDurableContinuation(env.DB,input.continuationId));
}

export async function observeLegacyToolCommandPublicationShadow(
  env: PublicationShadowEnv,
  input: { chatId:string; taskId:string; receiptId:string },
): Promise<PublicationShadowObservation> {
  return observeMapped(env,{
    publicationId:`pub:telegram:tool-command:${input.taskId}`,
    inferenceRunId:`tg-tool-command:${input.taskId}`,
    recipientScope:input.chatId,
    legacyPath:"tool_command_direct_append",
  },() => mapToolCommandBypass(env.DB,input));
}
