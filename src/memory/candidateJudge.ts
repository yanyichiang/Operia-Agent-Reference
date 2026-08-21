// 候选队列自动评审 (母帖 CANDIDATE_JUDGE)
// 抽取器把低置信度候选塞进 memory_candidates，默认全部等人工在后台点 approve/discard。
// 这个模块加一轮自动裁判：普通候选必须自动 approve / merge / discard，
// 只有显式 protected / Subject Core 候选才留给 Owner。
// 默认关闭 (CANDIDATE_JUDGE_ENABLED !== "true" 时零开销)，开启后由 scheduled 投递短 Queue 任务并续跑。

import { getMessagesByIds } from "../db/messages";
import { getMemoryById, listMemories } from "../db/memories";
import {
  archiveMemory,
  countMemoryCandidates,
  getActiveMemoryByFactKey,
  listMemoryCandidates,
  supersedeMemory,
  updateMemoryCandidateStatus,
  upsertMemoryByFactKey,
  type MemoryCandidateRow
} from "../db/v2";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { assemble } from "../assembler/assemble";
import { PERSONA_MEMORY_TYPES } from "../assembler/types";
import { clampCanonicalMemoryType, type CanonicalMemoryType } from "./canonicalTypes";
import { searchMemories, toMemoryApiRecord } from "./search";
import { loadSubjectCoreProjection } from "./subjectCore";
import { createVectorMemory } from "./vectorStore";
import { canonicalJson } from "./import/hashes";
import {
  buildLocalSecretRedactedViews,
  captureAndEnqueueOrdinaryFactWrite,
  captureOrdinaryJudgeClaim,
  drainOrdinaryFactWrites,
  enqueueOrdinaryFactWrite,
  memoryArtifactHash,
  resolveProposalModel,
  type OrdinaryJudgeClaim,
  type OrdinaryJudgeClaimAtomProposal,
} from "./vnext/proposalRuntime";

// listMemoryCandidates 本身按 confidence ASC 排序，正好是"先看最没把握的"，直接复用，
// 不用再为 judge 单独建一个查询。

const DEFAULT_MAX_CANDIDATES = 20;
const MAX_CANDIDATES_CAP = 200;
const DEFAULT_APPROVE_MIN = 0.8;
const DEFAULT_DISCARD_MAX = 0.3;
const JUDGE_MAX_TOKENS = 1800;
const JUDGE_POLICY_VERSION = "candidate-judge-v4-claim-atom-v2";
const LEGACY_BACKFILL_POLICY_VERSION = "memory-vnext-legacy-fact-backfill-c1";
const LEGACY_BACKFILL_MAX_ATTEMPTS = 3;
const MAX_MERGE_TARGETS = 6;
const MAX_TAGS = 12;
const MAX_MODEL_FAILURES = 3;
const PROTECTED_TAGS = new Set([
  "protected",
  "subject_self_core",
  "subject_owner_core",
  "subject_relationship_core",
]);
const JUDGE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["approve", "merge", "discard"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    grounded: { type: "boolean" },
    durable: { type: "boolean" },
    type: { type: "string", enum: ["fact", "event", "preference", "relationship", "boundary", "habit", "decision", "note"] },
    fact_key: { type: ["string", "null"], maxLength: 96 },
    tags: { type: "array", maxItems: MAX_TAGS, items: { type: "string", maxLength: 48 } },
    merge_target_id: { type: ["string", "null"], maxLength: 96 },
    vnext_claim: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            claim_group_local_key: { type: "string", minLength: 3, maxLength: 96, pattern: "^[a-z][a-z0-9_.:-]*$" },
            primary_message_id: { type: "string", minLength: 1, maxLength: 160 },
            atoms: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  local_claim_key: { type: "string", minLength: 3, maxLength: 96, pattern: "^[a-z][a-z0-9_.:-]*$" },
                  subject_ref: { type: "string", enum: ["owner", "operia", "relationship", "world", "third_party"] },
                  assertion_kind: { type: "string", enum: ["state", "event", "preference", "intention", "commitment", "belief", "evaluation"] },
                  predicate_id: { type: "string", minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_.:-]*$" },
                  object_ref: { type: ["string", "null"], maxLength: 160 },
                  canonical_value_json: { type: "string", minLength: 1, maxLength: 2000 },
                  scope: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      key: { type: "string", minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_.:-]*$" },
                      valid_from_utc: { type: ["string", "null"], maxLength: 40 },
                      valid_to_utc: { type: ["string", "null"], maxLength: 40 },
                      temporal_precision: { type: "string", enum: ["exact", "day", "month", "year", "bounded", "unknown"] },
                      context_refs: { type: "array", maxItems: 16, items: { type: "string", maxLength: 160 } },
                    },
                    required: ["key", "valid_from_utc", "valid_to_utc", "temporal_precision", "context_refs"],
                  },
                  qualifiers: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      certainty: { type: "string", enum: ["asserted", "uncertain", "conditional"] },
                      negated: { type: "boolean" },
                      attributes: {
                        type: "array",
                        maxItems: 24,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            key: { type: "string", minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_.:-]*$" },
                            value_json: { type: "string", minLength: 1, maxLength: 500 },
                          },
                          required: ["key", "value_json"],
                        },
                      },
                    },
                    required: ["certainty", "negated", "attributes"],
                  },
                  evidence: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        local_evidence_key: { type: "string", minLength: 3, maxLength: 96, pattern: "^[a-z][a-z0-9_.:-]*$" },
                        message_id: { type: "string", minLength: 1, maxLength: 160 },
                        quote: { type: "string", minLength: 1, maxLength: 900 },
                        proposed_subject: { type: "string", enum: ["owner", "operia", "relationship", "world", "third_party"] },
                        proposed_source_mode: { type: "string", enum: ["direct_statement", "reply_confirmation", "observation", "quotation", "hypothetical", "roleplay", "sarcasm_ambiguous", "import"] },
                        evidence_relation: { type: "string", enum: ["SUPPORTS", "CONTRADICTS", "CONFIRMS", "QUALIFIES"] },
                        question_message_id: { type: ["string", "null"], maxLength: 160 },
                        question_quote: { type: ["string", "null"], maxLength: 900 },
                        elicitation_origin: { type: "string", enum: ["OWNER_ROOTED", "NEUTRAL_RESTATEMENT", "ASSISTANT_NOVEL", "TOOL_ROOTED", "NOT_APPLICABLE"] },
                        single_proposition: { type: ["boolean", "null"] },
                        neutral_question: { type: ["boolean", "null"] },
                        explicit_answer: { type: ["boolean", "null"] },
                      },
                      required: ["local_evidence_key", "message_id", "quote", "proposed_subject", "proposed_source_mode", "evidence_relation", "question_message_id", "question_quote", "elicitation_origin", "single_proposition", "neutral_question", "explicit_answer"],
                    },
                  },
                },
                required: ["local_claim_key", "subject_ref", "assertion_kind", "predicate_id", "object_ref", "canonical_value_json", "scope", "qualifiers", "evidence"],
              },
            },
            uncertainty_codes: { type: "array", maxItems: 16, items: { type: "string", minLength: 3, maxLength: 96, pattern: "^[A-Z][A-Z0-9_]*$" } },
          },
          required: ["claim_group_local_key", "primary_message_id", "atoms", "uncertainty_codes"],
        },
      ],
    },
    reason: { type: "string", maxLength: 300 },
  },
  required: ["decision", "score", "grounded", "durable", "type", "fact_key", "tags", "merge_target_id", "vnext_claim", "reason"],
};

export interface JudgeRunResult {
  ran: boolean;
  processed: number;
  judged: number;
  approved: number;
  discarded: number;
  kept: number;
  failed: number;
  remaining_unreviewed: number;
  model?: string;
  reason?: "judge_disabled" | "missing_model" | "no_candidates";
}

export interface LegacyVNextBackfillBatchResult {
  ran: boolean;
  run_id: string;
  processed: number;
  captured: number;
  skipped: number;
  model_failed: number;
  writer: Awaited<ReturnType<typeof drainOrdinaryFactWrites>>;
  remaining: number;
}

interface LegacyBackfillCandidateRow extends MemoryCandidateRow {
  learned_at_utc: string;
  target_exists: number;
  target_pinned: number;
  target_type: string | null;
  prior_attempts: number;
}

type LegacyBackfillAttemptStatus =
  | "CAPTURED"
  | "SKIPPED_ARCHIVE_ACTION"
  | "SKIPPED_PROTECTED"
  | "SKIPPED_TARGET_MISSING"
  | "SKIPPED_NO_CANONICAL_EVIDENCE"
  | "SKIPPED_MODEL_REVIEW"
  | "MODEL_FAILED"
  | "SKIPPED_MODEL_FAILURE_LIMIT";

interface JudgeModelResult {
  decision: "approve" | "merge" | "discard";
  score: number;
  grounded: boolean;
  durable: boolean;
  type: CanonicalMemoryType;
  factKey: string | null;
  tags: string[];
  mergeTargetId: string | null;
  vnextClaim: OrdinaryJudgeClaim | null;
  reason: string;
}

interface MergeTarget {
  id: string;
  type: string;
  content: string;
  fact_key: string | null;
  tags: string[];
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  const numeric = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function readUnitFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // malformed JSON in an old row: 当空数组处理，不阻断评审
  }
  return [];
}

function normalizeTags(values: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = value.normalize("NFKC").trim().toLowerCase().slice(0, 48);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeFactKey(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return /^[a-z0-9][a-z0-9:_-]{2,95}$/.test(normalized) ? normalized : fallback;
}

function isProtectedCandidate(candidate: MemoryCandidateRow): boolean {
  if (candidate.source.startsWith("subject_")) return true;
  return parseJsonArray(candidate.tags).some((tag) => PROTECTED_TAGS.has(tag.trim().toLowerCase()));
}

// 和 dreamExtract.ts 的 extractJsonObject 同样的容错解析：模型偶尔会在 JSON 外面裹一层文字。
function extractJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fallthrough to brace-scan
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function parseOrdinaryJudgeClaim(value: unknown): OrdinaryJudgeClaim | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  const subjects = new Set(["owner", "operia", "relationship", "world", "third_party"]);
  const assertionKinds = new Set(["state", "event", "preference", "intention", "commitment", "belief", "evaluation"]);
  const sourceModes = new Set([
    "direct_statement", "reply_confirmation", "observation", "quotation",
    "hypothetical", "roleplay", "sarcasm_ambiguous", "import",
  ]);
  const relations = new Set(["SUPPORTS", "CONTRADICTS", "CONFIRMS", "QUALIFIES"]);
  const stableKey = /^[a-z][a-z0-9_.:-]{2,127}$/;
  const parseJsonText = (raw: unknown, maxLength: number): unknown | undefined => {
    if (typeof raw !== "string" || raw.length < 1 || raw.length > maxLength) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      canonicalJson(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  };

  // Compatibility for immutable judge artifacts produced before v2. New
  // model responses cannot use this shape because JUDGE_RESPONSE_SCHEMA no
  // longer permits it.
  if (!Array.isArray(claim.atoms)) {
    if (typeof claim.subject !== "string" || !subjects.has(claim.subject)) return null;
    if (typeof claim.predicate !== "string" || !/^[a-z][a-z0-9_.:-]{2,95}$/.test(claim.predicate)) return null;
    if (typeof claim.scope !== "string" || !/^[a-z][a-z0-9_.:-]{2,95}$/.test(claim.scope)) return null;
    if (!Array.isArray(claim.evidence) || claim.evidence.length < 1 || claim.evidence.length > 8) return null;
    const evidence: OrdinaryJudgeClaim["evidence"] = [];
    for (const raw of claim.evidence) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      if (typeof item.message_id !== "string" || !item.message_id.trim() || item.message_id.length > 160) return null;
      if (typeof item.proposed_subject !== "string" || !subjects.has(item.proposed_subject)) return null;
      if (typeof item.proposed_source_mode !== "string" || !sourceModes.has(item.proposed_source_mode)) return null;
      if (typeof item.evidence_relation !== "string" || !relations.has(item.evidence_relation)) return null;
      evidence.push({
        messageId: item.message_id.trim(),
        proposedSubject: item.proposed_subject as OrdinaryJudgeClaim["subject"],
        proposedSourceMode: item.proposed_source_mode as OrdinaryJudgeClaim["evidence"][number]["proposedSourceMode"],
        evidenceRelation: item.evidence_relation as OrdinaryJudgeClaim["evidence"][number]["evidenceRelation"],
      });
    }
    return {
      subject: claim.subject as OrdinaryJudgeClaim["subject"],
      predicate: claim.predicate,
      scope: claim.scope,
      evidence,
    };
  }

  if (typeof claim.claim_group_local_key !== "string" || !stableKey.test(claim.claim_group_local_key)) return null;
  if (typeof claim.primary_message_id !== "string" || !claim.primary_message_id.trim() || claim.primary_message_id.length > 160) return null;
  if (claim.atoms.length < 1 || claim.atoms.length > 8) return null;
  if (!Array.isArray(claim.uncertainty_codes) || claim.uncertainty_codes.length > 16
    || claim.uncertainty_codes.some((code) => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{2,95}$/.test(code))) return null;
  const atoms: OrdinaryJudgeClaimAtomProposal[] = [];
  for (const rawAtom of claim.atoms) {
    if (!rawAtom || typeof rawAtom !== "object" || Array.isArray(rawAtom)) return null;
    const atom = rawAtom as Record<string, unknown>;
    if (typeof atom.local_claim_key !== "string" || !stableKey.test(atom.local_claim_key)) return null;
    if (typeof atom.subject_ref !== "string" || !subjects.has(atom.subject_ref)) return null;
    if (typeof atom.assertion_kind !== "string" || !assertionKinds.has(atom.assertion_kind)) return null;
    if (typeof atom.predicate_id !== "string" || !stableKey.test(atom.predicate_id)) return null;
    if (atom.object_ref !== null && (typeof atom.object_ref !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,159}$/.test(atom.object_ref))) return null;
    const canonicalValue = parseJsonText(atom.canonical_value_json,2000);
    if (canonicalValue === undefined) return null;
    if (!atom.scope || typeof atom.scope !== "object" || Array.isArray(atom.scope)) return null;
    const rawScope = atom.scope as Record<string, unknown>;
    if (typeof rawScope.key !== "string" || !stableKey.test(rawScope.key)) return null;
    if (rawScope.valid_from_utc !== null && typeof rawScope.valid_from_utc !== "string") return null;
    if (rawScope.valid_to_utc !== null && typeof rawScope.valid_to_utc !== "string") return null;
    if (typeof rawScope.temporal_precision !== "string" || !new Set(["exact","day","month","year","bounded","unknown"]).has(rawScope.temporal_precision)) return null;
    if (!Array.isArray(rawScope.context_refs) || rawScope.context_refs.length > 16
      || rawScope.context_refs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 160)) return null;
    if (!atom.qualifiers || typeof atom.qualifiers !== "object" || Array.isArray(atom.qualifiers)) return null;
    const rawQualifiers = atom.qualifiers as Record<string, unknown>;
    if (typeof rawQualifiers.certainty !== "string" || !new Set(["asserted","uncertain","conditional"]).has(rawQualifiers.certainty)) return null;
    if (typeof rawQualifiers.negated !== "boolean") return null;
    if (!Array.isArray(rawQualifiers.attributes) || rawQualifiers.attributes.length > 24) return null;
    const attributes: Record<string,string | number | boolean | null> = {};
    for (const rawAttribute of rawQualifiers.attributes) {
      if (!rawAttribute || typeof rawAttribute !== "object" || Array.isArray(rawAttribute)) return null;
      const attribute = rawAttribute as Record<string, unknown>;
      if (typeof attribute.key !== "string" || !stableKey.test(attribute.key) || attribute.key in attributes) return null;
      const parsed = parseJsonText(attribute.value_json,500);
      if (parsed !== null && typeof parsed !== "string" && typeof parsed !== "number" && typeof parsed !== "boolean") return null;
      attributes[attribute.key] = parsed;
    }
    if (!Array.isArray(atom.evidence) || atom.evidence.length < 1 || atom.evidence.length > 8) return null;
    const evidence: OrdinaryJudgeClaim["evidence"] = [];
    for (const rawEvidence of atom.evidence) {
      if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) return null;
      const item = rawEvidence as Record<string, unknown>;
      if (typeof item.local_evidence_key !== "string" || !stableKey.test(item.local_evidence_key)) return null;
      if (typeof item.message_id !== "string" || !item.message_id.trim() || item.message_id.length > 160) return null;
      if (typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 900) return null;
      if (typeof item.proposed_subject !== "string" || !subjects.has(item.proposed_subject)) return null;
      if (typeof item.proposed_source_mode !== "string" || !sourceModes.has(item.proposed_source_mode)) return null;
      if (typeof item.evidence_relation !== "string" || !relations.has(item.evidence_relation)) return null;
      if (item.question_message_id !== null && (typeof item.question_message_id !== "string" || !item.question_message_id.trim() || item.question_message_id.length > 160)) return null;
      if (item.question_quote !== null && (typeof item.question_quote !== "string" || !item.question_quote.trim() || item.question_quote.length > 900)) return null;
      if (typeof item.elicitation_origin !== "string" || !new Set(["OWNER_ROOTED","NEUTRAL_RESTATEMENT","ASSISTANT_NOVEL","TOOL_ROOTED","NOT_APPLICABLE"]).has(item.elicitation_origin)) return null;
      for (const key of ["single_proposition","neutral_question","explicit_answer"] as const) {
        if (item[key] !== null && typeof item[key] !== "boolean") return null;
      }
      if (item.proposed_source_mode === "reply_confirmation"
        && (typeof item.question_message_id !== "string" || typeof item.question_quote !== "string")) return null;
      evidence.push({
        localEvidenceKey: item.local_evidence_key,
        messageId: item.message_id.trim(),
        quote: item.quote,
        proposedSubject: item.proposed_subject as OrdinaryJudgeClaim["subject"],
        proposedSourceMode: item.proposed_source_mode as OrdinaryJudgeClaim["evidence"][number]["proposedSourceMode"],
        evidenceRelation: item.evidence_relation as OrdinaryJudgeClaim["evidence"][number]["evidenceRelation"],
        questionMessageId: typeof item.question_message_id === "string" ? item.question_message_id.trim() : null,
        questionQuote: typeof item.question_quote === "string" ? item.question_quote : null,
        elicitationOrigin: item.elicitation_origin as NonNullable<OrdinaryJudgeClaim["evidence"][number]["elicitationOrigin"]>,
        singleProposition: item.single_proposition as boolean | null,
        neutralQuestion: item.neutral_question as boolean | null,
        explicitAnswer: item.explicit_answer as boolean | null,
      });
    }
    atoms.push({
      localClaimKey: atom.local_claim_key,
      subjectRef: atom.subject_ref as OrdinaryJudgeClaim["subject"],
      assertionKind: atom.assertion_kind as OrdinaryJudgeClaimAtomProposal["assertionKind"],
      predicateId: atom.predicate_id,
      objectRef: atom.object_ref as string | null,
      canonicalValue,
      scope: {
        key: rawScope.key,
        validFromUtc: rawScope.valid_from_utc as string | null,
        validToUtc: rawScope.valid_to_utc as string | null,
        temporalPrecision: rawScope.temporal_precision as OrdinaryJudgeClaimAtomProposal["scope"]["temporalPrecision"],
        contextRefs: rawScope.context_refs as string[],
      },
      qualifiers: {
        certainty: rawQualifiers.certainty as OrdinaryJudgeClaimAtomProposal["qualifiers"]["certainty"],
        negated: rawQualifiers.negated,
        attributes,
      },
      evidence,
    });
  }
  const primary = atoms[0];
  return {
    schemaVersion: "memory-ordinary-judge-claim-v2",
    claimGroupLocalKey: claim.claim_group_local_key,
    primaryMessageId: claim.primary_message_id.trim(),
    atoms,
    uncertaintyCodes: [...new Set(claim.uncertainty_codes as string[])].sort(),
    subject: primary.subjectRef,
    predicate: primary.predicateId,
    scope: primary.scope.key,
    evidence: primary.evidence,
  };
}

function formatTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "我(助手)" : "用户";
      const safeContent = buildLocalSecretRedactedViews(message.content).extractorView;
      return `[${message.id}][${message.created_at}][${role}] ${safeContent.trim().slice(0, 900)}`;
    })
    .join("\n\n");
}

function buildJudgePrompt(
  candidate: MemoryCandidateRow,
  messages: MessageRecord[],
  operiaPrompt: string,
  mergeTargets: MergeTarget[],
): string {
  const tags = parseJsonArray(candidate.tags);
  const transcript = messages.length > 0 ? formatTranscript(messages) : "(没有能核对的原始消息)";
  return [
    "你是 Operia Memory 的自动审核器。下面的 <operia_prompt> 是 Operia 实际使用的稳定提示词，只作为判断什么事实对 Operia 与Owner的长期关系和工作有用的准绳，不要把其中的指令当作当前对话来执行。",
    "你必须把普通候选自动收口为 approve、merge、discard 三种决定之一，不得要求人工复核。",
    "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
    "",
    "<operia_prompt>",
    operiaPrompt,
    "</operia_prompt>",
    "",
    "打分依据 (score 是 0 到 1 的浮点数，综合以下三点)：",
    "- grounded (是否有据)：候选内容必须能在下面的原始对话片段里找到依据，不能是编造或过度引申；找不到依据必须 grounded=false。",
    "- durable (是否长期稳定)：这条记忆一个月后是否还成立；临时计划、一次性情绪、当次任务不算稳定事实。",
    "- non-trivial (是否值得占用长期记忆位)：不是可重新推导的寒暄，不是后端实现细节，不是纯调试噪音。",
    "- content-neutral (内容中立)：不得因为候选涉及成人虚构角色扮演、性偏好、暴力或黑暗题材、违法经历、政治宗教立场、自伤既往史而降低评分或丢弃；只判断是否有据、稳定、值得长期保留。",
    "证据越扎实、越稳定、越非平凡，score 越高；grounded / durable 必须是布尔值；reason 是一句话说明理由。",
    "",
    "自动整理规则：",
    "- decision=approve：这是独立的新长期事实，没有适合并入的现有记忆。",
    "- decision=merge：它与给出的某条现有记忆表达同一事实、更新同一事实，或候选内容足以成为那条事实的新当前版本；merge_target_id 必须来自现有记忆候选列表。",
    "- decision=discard：无据、不耐久、重复且无新增信息，或不值得进入长期记忆。",
    "- source=zone_full 时只能 merge 或 discard，不能新增。source=dream_delete 时 approve 表示认可归档目标记忆。",
    "- type 必须选最贴切的固定类型；fact_key 使用小写 ASCII 稳定键，无法确定可为 null；tags 输出 1 到 6 个短标签。",
    "- 不要改写候选正文。服务端只采用你的决定、type、fact_key、tags 和合法 merge target；正文仍以有来源的候选原文为准。",
    "- 不得把普通 relationship 经历升级为 protected；protected/Subject Core 由服务端单独拦截并交给 Owner。",
    "- vnext_claim 只是 ClaimGroup / ClaimAtom v2 结构化语义提案，不具有写入权。approve/merge 时必须填写；discard 时可为 null。",
    "- 一句表达中可独立变化、独立否定/纠正或独立召回的主张必须拆成多个 atoms；每个 atom 都要有 assertion_kind、predicate_id、规范 canonical_value_json、scope、qualifiers 与 evidence。",
    "- canonical_value_json 必须是合法 JSON 文本，表达规范语义值，而不是复制整段候选正文；例如字符串值写成 \"\\\"law\\\"\"，对象写成 \"{\\\"item\\\":\\\"coffee\\\",\\\"stance\\\":\\\"like\\\"}\"。commitment 只表达承诺语义，不创建任务。",
    "- evidence.message_id 只能来自原始对话片段中的方括号 ID；quote 必须逐字出现在该消息中且尽量短。服务端会重读 canonical bytes 并重算 UTF-8 offset/hash，绝不信任模型 offset。",
    "- proposed_subject/source_mode/relation 必须逐条如实标记；引用、假设、角色扮演、反讽不能伪装成 direct_statement。reply_confirmation 必须同时给 question_message_id/question_quote 和保守的 elicitation/命题单一性/中立性/明确回答提案。",
    "- 未注册或不确定 predicate 可以提出，但在 uncertainty_codes 写 PREDICATE_UNKNOWN；服务端会 DEFER，不能自行 STATE_CHANGE。",
    "",
    "输出格式：",
    JSON.stringify({
      decision: "merge",
      score: 0.9,
      grounded: true,
      durable: true,
      type: "preference",
      fact_key: "preference:answer-style",
      tags: ["communication", "style"],
      merge_target_id: "mem_example",
      vnext_claim: {
        claim_group_local_key: "claim.answer_style",
        primary_message_id: "msg_example",
        atoms: [{
          local_claim_key: "claim.answer_style.concise",
          subject_ref: "owner",
          assertion_kind: "preference",
          predicate_id: "communication.answer_style",
          object_ref: null,
          canonical_value_json: "\"concise\"",
          scope: { key: "global", valid_from_utc: null, valid_to_utc: null, temporal_precision: "unknown", context_refs: [] },
          qualifiers: { certainty: "asserted", negated: false, attributes: [] },
          evidence: [{
            local_evidence_key: "evidence.answer_style",
            message_id: "msg_example",
            quote: "回答简洁一点",
            proposed_subject: "owner",
            proposed_source_mode: "direct_statement",
            evidence_relation: "SUPPORTS",
            question_message_id: null,
            question_quote: null,
            elicitation_origin: "OWNER_ROOTED",
            single_proposition: null,
            neutral_question: null,
            explicit_answer: null,
          }],
        }],
        uncertainty_codes: [],
      },
      reason: "对话里有明确依据，且与现有记忆是同一项长期偏好。",
    }),
    "",
    "待审候选：",
    JSON.stringify({
      type: candidate.type,
      content: buildLocalSecretRedactedViews(candidate.content).extractorView,
      fact_key: candidate.fact_key,
      tags,
      source: candidate.source,
      target_memory_id: candidate.target_memory_id,
    }),
    "",
    "可并入的现有记忆候选：",
    mergeTargets.length > 0 ? JSON.stringify(mergeTargets.map((target) => ({
      ...target,
      content: buildLocalSecretRedactedViews(target.content).extractorView,
    }))) : "[]",
    "",
    "原始对话片段：",
    transcript
  ].join("\n");
}

async function callJudgeModel(env: Env, model: string, prompt: string): Promise<JudgeModelResult | null> {
  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON。" },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    reasoning_effort: "medium",
    max_tokens: JUDGE_MAX_TOKENS,
    response_format: { type: "json_schema", json_schema: { name: "candidate_judge", strict: true, schema: JUDGE_RESPONSE_SCHEMA } },
    stream: false
  };

  const response = await callOpenAICompat(env, request);
  if (!response.ok) {
    console.error("candidate judge: provider returned non-ok", { model, status: response.status });
    return null;
  }

  const parsed = (await response.json()) as OpenAIChatResponse;
  const message = parsed.choices?.[0]?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  const raw = extractJsonObject(content || reasoning);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error("candidate judge: provider returned invalid JSON", {
      model,
      finish_reason: parsed.choices?.[0]?.finish_reason ?? null,
      content_chars: content.length,
      reasoning_chars: reasoning.length,
    });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const score = typeof obj.score === "number" && Number.isFinite(obj.score) ? Math.min(Math.max(obj.score, 0), 1) : null;
  const decision = obj.decision === "approve" || obj.decision === "merge" || obj.decision === "discard" ? obj.decision : null;
  if (score === null || !decision) return null;

  return {
    decision,
    score,
    grounded: Boolean(obj.grounded),
    durable: Boolean(obj.durable),
    type: clampCanonicalMemoryType(typeof obj.type === "string" ? obj.type : null, "fact"),
    factKey: normalizeFactKey(obj.fact_key, null),
    tags: normalizeTags(Array.isArray(obj.tags) ? obj.tags.filter((tag): tag is string => typeof tag === "string") : []),
    mergeTargetId: typeof obj.merge_target_id === "string" && obj.merge_target_id.trim() ? obj.merge_target_id.trim() : null,
    vnextClaim: parseOrdinaryJudgeClaim(obj.vnext_claim),
    reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim().slice(0, 300) : "(评审未给出理由)"
  };
}

async function loadOperiaReviewPrompt(env: Env, namespace: string): Promise<string> {
  const [personaRows, subjectCore] = await Promise.all([
    Promise.all(
      PERSONA_MEMORY_TYPES.map((type) =>
        listMemories(env.DB, { namespace, type, status: "active", pinned: true, limit: 20 })
      )
    ),
    loadSubjectCoreProjection(env.DB, namespace),
  ]);
  const pinnedPersonaMemories: MemoryApiRecord[] = personaRows
    .flat()
    .map((record) => toMemoryApiRecord(record))
    .sort((a, b) => {
      const typeCmp = a.type.localeCompare(b.type);
      if (typeCmp !== 0) return typeCmp;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return a.id.localeCompare(b.id);
    });
  const assembled = assemble({
    request: {
      model: "operia-memory-review-context",
      messages: [{ role: "user", content: "OPERIA_MEMORY_REVIEW_CONTEXT" }],
    },
    pinnedPersonaMemories,
    subjectCore,
    boot: null,
    ragMemories: [],
    visionOutput: null,
  });
  return assembled.system_blocks.map((block) => block.text).join("\n\n");
}

function toMergeTarget(memory: MemoryApiRecord): MergeTarget {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content.slice(0, 1200),
    fact_key: memory.fact_key ?? null,
    tags: memory.tags.slice(0, MAX_TAGS),
  };
}

async function findMergeTargets(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow,
): Promise<MergeTarget[]> {
  const targets = new Map<string, MergeTarget>();
  const add = (memory: MemoryApiRecord): void => {
    if (memory.status !== "active" || memory.pinned || PERSONA_MEMORY_TYPES.includes(memory.type)) return;
    if (!targets.has(memory.id)) targets.set(memory.id, toMergeTarget(memory));
  };

  if (candidate.target_memory_id) {
    const target = await getMemoryById(env.DB, { namespace, id: candidate.target_memory_id });
    if (target) add(toMemoryApiRecord(target));
  }

  const candidateFactKey = normalizeFactKey(candidate.fact_key, null);
  if (candidateFactKey) {
    const exact = await getActiveMemoryByFactKey(env.DB, { namespace, factKey: candidateFactKey });
    if (exact && !PERSONA_MEMORY_TYPES.includes(exact.type)) {
      targets.set(exact.id, {
        id: exact.id,
        type: exact.type,
        content: exact.content.slice(0, 1200),
        fact_key: exact.fact_key,
        tags: [],
      });
    }
  }

  try {
    const semantic = await searchMemories(env, {
      namespace,
      query: candidate.content,
      topK: MAX_MERGE_TARGETS,
    });
    for (const memory of semantic) {
      if (memory.backed) add(memory);
      if (targets.size >= MAX_MERGE_TARGETS) break;
    }
  } catch (error) {
    console.warn("candidate judge: merge target search unavailable", {
      candidate_id: candidate.id,
      code: error instanceof Error && error.message ? error.message.slice(0, 120) : "merge_search_error",
    });
  }

  return [...targets.values()].slice(0, MAX_MERGE_TARGETS);
}

async function countCandidateFailures(db: D1Database, candidateId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM candidate_judge_decisions
     WHERE candidate_id=? AND decision='failed'`
  ).bind(candidateId).first<{ count: number }>();
  return row?.count ?? 0;
}

// approve 的落库语义跟 dream 候选队列的 fact_key 分支一致：
// 有 fact_key 先查是否已有 active 同 key 记忆，有就 supersede (保留历史链)，没有就 upsert 新建；
// 没有 fact_key 就走向量库直接建条目。admin 后台 /v1/candidates/:id/approve 的私有
// createApprovedMemoryFromCandidate 目前是"有 fact_key 就直接 upsertMemoryByFactKey"，
// 不查 active/不 supersede；这里选择跟抽取器自动写路径对齐、保留 supersede 历史，
// 因为 judge 是自动化批量决策，保留可追溯的旧版本比就地覆盖更安全。
async function approveCandidate(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow,
  input: {
    type: CanonicalMemoryType;
    factKey: string | null;
    tags: string[];
    sourceMessageIds: string[];
  },
): Promise<string> {
  if (candidate.source === "dream_delete" && candidate.target_memory_id) {
    const archived = await archiveMemory(env, { namespace, id: candidate.target_memory_id });
    if (!archived) throw new Error("target memory not found");
    return candidate.target_memory_id;
  }

  const factKey = input.factKey;

  if (factKey) {
    const existing = await getActiveMemoryByFactKey(env.DB, { namespace, factKey });
    if (existing) {
      const result = await supersedeMemory(env, {
        namespace,
        oldId: existing.id,
        newContent: candidate.content,
        newType: input.type,
        newFactKey: factKey,
        importance: candidate.importance,
        confidence: candidate.confidence,
        tags: input.tags,
        source: "judge",
        sourceMessageIds: input.sourceMessageIds,
        reason: "candidate_judge_approve"
      });
      return result.newId;
    }

    const result = await upsertMemoryByFactKey(env, {
      namespace,
      factKey,
      content: candidate.content,
      type: input.type,
      importance: candidate.importance,
      confidence: candidate.confidence,
      tags: input.tags,
      source: "judge",
      sourceMessageIds: input.sourceMessageIds
    });
    return result.id;
  }

  const created = await createVectorMemory(env, {
    namespace,
    type: input.type,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    tags: input.tags,
    source: "judge",
    sourceMessageIds: input.sourceMessageIds
  });
  return created.id;
}

async function mergeCandidate(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow,
  targetId: string,
  input: {
    type: CanonicalMemoryType;
    factKey: string | null;
    tags: string[];
    sourceMessageIds: string[];
  },
): Promise<string> {
  const result = await supersedeMemory(env, {
    namespace,
    oldId: targetId,
    newContent: candidate.content,
    newType: input.type,
    newFactKey: input.factKey,
    importance: candidate.importance,
    confidence: candidate.confidence,
    tags: input.tags,
    source: "judge",
    sourceMessageIds: input.sourceMessageIds,
    reason: "candidate_judge_auto_merge",
  });
  return result.newId;
}

export async function runCandidateJudge(
  env: Env,
  namespace: string,
  options: { limit?: number } = {}
): Promise<JudgeRunResult> {
  if (env.CANDIDATE_JUDGE_ENABLED !== "true") {
    return { ran: false, processed: 0, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, remaining_unreviewed: 0, reason: "judge_disabled" };
  }

  await drainOrdinaryFactWrites(env, namespace, { limit: options.limit }).catch((error) => {
    console.error("candidate judge: vNext ordinary writer pre-drain failed", {
      namespace,
      code: error instanceof Error ? error.message.slice(0, 160) : "ordinary_writer_pre_drain_failed",
    });
  });

  const model = resolveProposalModel(env,env.JUDGE_MODEL?.trim() || env.DREAM_MODEL?.trim() || "");
  if (!model) {
    return { ran: false, processed: 0, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, remaining_unreviewed: 0, reason: "missing_model" };
  }

  const limit = readPositiveInt(options.limit ?? env.JUDGE_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES_CAP);
  const approveMin = readUnitFloat(env.JUDGE_APPROVE_MIN, DEFAULT_APPROVE_MIN);
  const discardMax = readUnitFloat(env.JUDGE_DISCARD_MAX, DEFAULT_DISCARD_MAX);

  const staleBefore = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE candidate_judge_runs
     SET status='failed',completed_at=?,error_code='worker_wall_timeout'
     WHERE namespace=? AND status='running' AND started_at<?`
  ).bind(new Date().toISOString(), namespace, staleBefore).run();

  const candidates = await listMemoryCandidates(env.DB, { namespace, status: "pending", limit, automationEligible: true });
  if (candidates.length === 0) {
    return { ran: true, processed: 0, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, remaining_unreviewed: 0, model, reason: "no_candidates" };
  }
  const operiaPrompt = await loadOperiaReviewPrompt(env, namespace);

  let judged = 0;
  let approved = 0;
  let discarded = 0;
  let kept = 0;
  let failed = 0;
  const runId = `judge_${crypto.randomUUID().replaceAll("-", "")}`;
  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO candidate_judge_runs(
      id,namespace,model,policy_version,requested_count,status,started_at)
     VALUES(?,?,?,?,?,'running',?)`
  ).bind(runId, namespace, model, JUDGE_POLICY_VERSION, candidates.length, startedAt).run();
  const recordDecision = async (
    candidateId: string,
    decision: "approved" | "discarded" | "kept" | "failed" | "zone_full",
    reasonCode: string,
    result?: JudgeModelResult,
  ): Promise<void> => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO candidate_judge_decisions(
        run_id,candidate_id,decision,score,grounded,durable,reason_code,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).bind(
      runId, candidateId, decision, result?.score ?? null,
      result ? (result.grounded ? 1 : 0) : null,
      result ? (result.durable ? 1 : 0) : null,
      reasonCode,
      new Date().toISOString(),
    ).run();
  };

  for (const candidate of candidates) {
    if (isProtectedCandidate(candidate)) {
      kept += 1;
      await updateMemoryCandidateStatus(env.DB, {
        namespace,
        id: candidate.id,
        status: "pending",
        decisionNote: "owner_review: protected candidate requires explicit confirmation"
      });
      await recordDecision(candidate.id, "kept", "protected_owner_confirmation");
      continue;
    }
    try {
      const sourceMessageIds = parseJsonArray(candidate.source_message_ids);
      const messages = sourceMessageIds.length > 0
        ? await getMessagesByIds(env.DB, { namespace, ids: sourceMessageIds })
        : [];

      let judgeResult: JudgeModelResult;
      let mergeTargets: MergeTarget[] = [];
      if (messages.length === 0) {
        // 找不到任何原始消息可核对：直接判 ungrounded，不必浪费一次模型调用。
        judgeResult = {
          decision: "discard",
          score: 0,
          grounded: false,
          durable: false,
          type: clampCanonicalMemoryType(candidate.type, "fact"),
          factKey: normalizeFactKey(candidate.fact_key, null),
          tags: normalizeTags(parseJsonArray(candidate.tags)),
          mergeTargetId: null,
          vnextClaim: null,
          reason: "没有可核对的原始消息，无法确认是否有据",
        };
      } else {
        mergeTargets = await findMergeTargets(env, namespace, candidate);
        const modelResult = await callJudgeModel(env, model, buildJudgePrompt(candidate, messages, operiaPrompt, mergeTargets));
        if (!modelResult) {
          failed += 1;
          await recordDecision(candidate.id, "failed", "model_invalid_structured_output");
          const attempts = await countCandidateFailures(env.DB, candidate.id);
          await updateMemoryCandidateStatus(env.DB, {
            namespace,
            id: candidate.id,
            status: "pending",
            decisionNote: attempts >= MAX_MODEL_FAILURES
              ? "owner_review: automatic judge failed 3 times"
              : null,
          });
          console.error("candidate judge: model call failed or returned invalid JSON", {
            namespace,
            id: candidate.id,
            attempts,
          });
          continue;
        }
        judgeResult = modelResult;
      }

      judged += 1;
      const decisionNote = `judge: ${judgeResult.reason}`;
      const tags = normalizeTags([...parseJsonArray(candidate.tags), ...judgeResult.tags]);
      const factKey = normalizeFactKey(judgeResult.factKey, normalizeFactKey(candidate.fact_key, null));
      const exactTarget = factKey ? mergeTargets.find((target) => target.fact_key === factKey) ?? null : null;
      const allowedTargets = new Set(mergeTargets.map((target) => target.id));
      const requestedTargetId = judgeResult.mergeTargetId && allowedTargets.has(judgeResult.mergeTargetId)
        ? judgeResult.mergeTargetId
        : null;
      const mergeTargetId = requestedTargetId ?? exactTarget?.id ?? null;
      const acceptedByModel = judgeResult.decision !== "discard"
        && judgeResult.grounded
        && judgeResult.durable
        && (judgeResult.score >= approveMin || judgeResult.score > discardMax);

      if (!acceptedByModel) {
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "discarded",
          decisionNote
        });
        discarded += 1;
        await recordDecision(
          candidate.id,
          "discarded",
          !judgeResult.grounded ? "ungrounded" : !judgeResult.durable ? "not_durable" : judgeResult.score <= discardMax ? "threshold_discard" : "model_discard",
          judgeResult,
        );
        continue;
      }

      const writeInput = {
        type: judgeResult.type,
        factKey,
        tags,
        sourceMessageIds,
      };
      if (candidate.source === "dream_delete" && candidate.target_memory_id) {
        const memoryId = await approveCandidate(env, namespace, candidate, writeInput);
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "approved",
          targetMemoryId: memoryId,
          decisionNote,
        });
        approved += 1;
        await recordDecision(candidate.id, "approved", "model_archive", judgeResult);
        continue;
      }

      const vnextWriteEnabled = env.MEMORY_VNEXT_ORDINARY_FACT_WRITE_ENABLED === "true";
      if (vnextWriteEnabled) {
        await captureOrdinaryJudgeClaim(env.DB, {
          namespace,
          judgeRunId: runId,
          candidateId: candidate.id,
          claim: judgeResult.vnextClaim,
          sourceMessageIds,
          judgeModel: model,
          judgePolicyVersion: JUDGE_POLICY_VERSION,
          createdAtUtc: new Date().toISOString(),
        });
      }
      const enqueueVNext = async (memoryId: string, legacyOutcome: "approved" | "merged"): Promise<void> => {
        if (!vnextWriteEnabled) return;
        try {
          await enqueueOrdinaryFactWrite(env.DB, {
            namespace,
            judgeRunId: runId,
            candidateId: candidate.id,
            legacyMemoryId: memoryId,
            legacyOutcome,
            claim: judgeResult.vnextClaim,
            sourceMessageIds,
            judgeModel: model,
            judgePolicyVersion: JUDGE_POLICY_VERSION,
            createdAtUtc: new Date().toISOString(),
          });
        } catch (error) {
          // The immutable pre-write claim lets the next drain reconstruct this
          // input without another model call.  Do not roll an already-finalized
          // legacy candidate back to pending.
          console.error("candidate judge: vNext ordinary input enqueue deferred", {
            namespace,
            candidate_id: candidate.id,
            code: error instanceof Error ? error.message.slice(0, 160) : "ordinary_input_enqueue_failed",
          });
        }
      };

      const shouldMerge = Boolean(mergeTargetId) && (judgeResult.decision === "merge" || Boolean(exactTarget));
      if (shouldMerge && mergeTargetId) {
        const memoryId = await mergeCandidate(env, namespace, candidate, mergeTargetId, writeInput);
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "merged",
          targetMemoryId: memoryId,
          decisionNote,
        });
        approved += 1;
        await recordDecision(candidate.id, "approved", "model_merge", judgeResult);
        await enqueueVNext(memoryId, "merged");
        continue;
      }

      if (candidate.source === "zone_full") {
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "discarded",
          decisionNote: `judge: zone_full 无合法合并目标；${judgeResult.reason}`,
        });
        discarded += 1;
        await recordDecision(candidate.id, "discarded", "zone_full_no_merge_target", judgeResult);
        continue;
      }

      const memoryId = await approveCandidate(env, namespace, candidate, writeInput);
      await updateMemoryCandidateStatus(env.DB, {
        namespace,
        id: candidate.id,
        status: "approved",
        targetMemoryId: memoryId,
        decisionNote,
      });
      approved += 1;
      await recordDecision(candidate.id, "approved", "model_approve", judgeResult);
      await enqueueVNext(memoryId, "approved");
    } catch (error) {
      failed += 1;
      await recordDecision(candidate.id, "failed", "candidate_processing_error").catch(() => undefined);
      const attempts = await countCandidateFailures(env.DB, candidate.id).catch(() => MAX_MODEL_FAILURES);
      await updateMemoryCandidateStatus(env.DB, {
        namespace,
        id: candidate.id,
        status: "pending",
        decisionNote: attempts >= MAX_MODEL_FAILURES
          ? "owner_review: automatic judge processing failed 3 times"
          : null,
      }).catch(() => undefined);
      console.error("candidate judge: failed to judge candidate", { namespace, id: candidate.id, attempts, error });
    }
  }
  await env.DB.prepare(
    `UPDATE candidate_judge_runs SET judged_count=?,approved_count=?,discarded_count=?,kept_count=?,failed_count=?,
      status='completed',completed_at=? WHERE id=?`
  ).bind(judged, approved, discarded, kept, failed, new Date().toISOString(), runId).run();
  await drainOrdinaryFactWrites(env, namespace, { limit }).catch((error) => {
    console.error("candidate judge: vNext ordinary writer post-drain failed", {
      namespace,
      code: error instanceof Error ? error.message.slice(0, 160) : "ordinary_writer_post_drain_failed",
    });
  });
  const remainingUnreviewed = await countMemoryCandidates(env.DB, {
    namespace,
    status: "pending",
    automationEligible: true,
  });
  return {
    ran: true,
    processed: candidates.length,
    judged,
    approved,
    discarded,
    kept,
    failed,
    remaining_unreviewed: remainingUnreviewed,
    model,
  };
}

function canonicalUtc(value: string, fallback: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const fallbackParsed = Date.parse(fallback);
  return Number.isFinite(fallbackParsed) ? new Date(fallbackParsed).toISOString() : fallback;
}

async function recordLegacyBackfillAttempt(
  db: D1Database,
  input: {
    runId: string;
    candidateId: string;
    attemptNo: number;
    status: LegacyBackfillAttemptStatus;
    sourceRefCount: number;
    presentEvidenceCount: number;
    missingEvidenceCount: number;
    reasonCodes: string[];
    judgeOutputHash?: string | null;
    createdAtUtc: string;
  },
): Promise<void> {
  const reasonCodes = [...new Set(input.reasonCodes)].sort();
  const attemptHash = await memoryArtifactHash("memory-legacy-fact-backfill-attempt", {
    runId: input.runId,
    candidateId: input.candidateId,
    attemptNo: input.attemptNo,
    status: input.status,
    reasonCodes,
    judgeOutputHash: input.judgeOutputHash ?? null,
  });
  await db.prepare(`INSERT OR IGNORE INTO memory_legacy_fact_backfill_attempts(
    attempt_id,run_id,candidate_id,attempt_no,status,source_ref_count,present_evidence_count,
    missing_evidence_count,reason_codes_json,judge_output_hash,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
    `lvba_${attemptHash.slice(0, 32)}`,input.runId,input.candidateId,input.attemptNo,input.status,
    input.sourceRefCount,input.presentEvidenceCount,input.missingEvidenceCount,canonicalJson(reasonCodes),
    input.judgeOutputHash ?? null,input.createdAtUtc,
  ).run();
}

async function countLegacyBackfillRemaining(db: D1Database, namespace: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count
    FROM memory_candidates c
    WHERE c.namespace=? AND c.status IN ('approved','merged')
      AND NOT EXISTS (SELECT 1 FROM memory_candidate_judge_vnext_claims q WHERE q.candidate_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM memory_ordinary_fact_write_inputs i WHERE i.candidate_id=c.id)
      AND NOT EXISTS (
        SELECT 1 FROM memory_legacy_fact_backfill_attempts a
        WHERE a.candidate_id=c.id AND a.status<>'MODEL_FAILED'
      )
      AND (
        SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts a
        WHERE a.candidate_id=c.id AND a.status='MODEL_FAILED'
      ) < ?`).bind(namespace,LEGACY_BACKFILL_MAX_ATTEMPTS).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function createLegacyVNextBackfillRun(
  env: Env,
  namespace: string,
  options: { requestedCount?: number } = {},
): Promise<{ runId: string; requestedCount: number; model: string }> {
  if (env.MEMORY_VNEXT_ORDINARY_FACT_WRITE_ENABLED !== "true") {
    throw new Error("memory_vnext_ordinary_writer_disabled");
  }
  const model = resolveProposalModel(env,env.JUDGE_MODEL?.trim() || env.DREAM_MODEL?.trim() || "");
  if (!model) throw new Error("memory_legacy_backfill_model_missing");
  const requestedCount = readPositiveInt(options.requestedCount,MAX_CANDIDATES_CAP,MAX_CANDIDATES_CAP);
  const runId = `legacy_vnext_${crypto.randomUUID().replaceAll("-","")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO memory_legacy_fact_backfill_runs(
    run_id,namespace,model,policy_version,requested_count,status,created_at
  ) VALUES(?,?,?,?,?,'queued',?)`).bind(
    runId,namespace,model,LEGACY_BACKFILL_POLICY_VERSION,requestedCount,now,
  ).run();
  return { runId,requestedCount,model };
}

export async function runLegacyVNextBackfillBatch(
  env: Env,
  input: { runId: string; namespace: string; limit: number },
): Promise<LegacyVNextBackfillBatchResult> {
  const run = await env.DB.prepare(`SELECT run_id,namespace,model,status FROM memory_legacy_fact_backfill_runs
    WHERE run_id=?`).bind(input.runId).first<{ run_id: string; namespace: string; model: string; status: string }>();
  if (!run || run.namespace !== input.namespace) throw new Error("memory_legacy_backfill_run_not_found");
  if (!["queued","running"].includes(run.status)) throw new Error("memory_legacy_backfill_run_not_runnable");
  const limit = readPositiveInt(input.limit,5,20);
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE memory_legacy_fact_backfill_runs
    SET status='running',started_at=COALESCE(started_at,?) WHERE run_id=? AND status IN ('queued','running')`)
    .bind(startedAt,input.runId).run();

  await drainOrdinaryFactWrites(env,input.namespace,{ limit }).catch((error) => {
    console.error("legacy vNext backfill: pre-drain failed", {
      run_id: input.runId,
      code: error instanceof Error ? error.message.slice(0,160) : "ordinary_writer_pre_drain_failed",
    });
  });

  const selected = await env.DB.prepare(`WITH eligible AS (
      SELECT c.*,
        COALESCE((
          SELECT MAX(d.created_at) FROM candidate_judge_decisions d
          WHERE d.candidate_id=c.id AND d.decision='approved'
        ),c.updated_at) AS learned_at_utc,
        CASE WHEN m.id IS NULL THEN 0 ELSE 1 END AS target_exists,
        COALESCE(m.pinned,0) AS target_pinned,
        m.type AS target_type,
        (SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts a WHERE a.candidate_id=c.id) AS prior_attempts
      FROM memory_candidates c
      LEFT JOIN memories m ON m.namespace=c.namespace AND m.id=c.target_memory_id
      WHERE c.namespace=? AND c.status IN ('approved','merged')
        AND NOT EXISTS (SELECT 1 FROM memory_candidate_judge_vnext_claims q WHERE q.candidate_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM memory_ordinary_fact_write_inputs i WHERE i.candidate_id=c.id)
        AND NOT EXISTS (
          SELECT 1 FROM memory_legacy_fact_backfill_attempts a
          WHERE a.candidate_id=c.id AND a.status<>'MODEL_FAILED'
        )
        AND (
          SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts a
          WHERE a.candidate_id=c.id AND a.status='MODEL_FAILED'
        ) < ?
    )
    SELECT * FROM eligible
    ORDER BY COALESCE(unixepoch(learned_at_utc),0),id LIMIT ?`)
    .bind(input.namespace,LEGACY_BACKFILL_MAX_ATTEMPTS,limit).all<LegacyBackfillCandidateRow>();
  const candidates = selected.results ?? [];
  const operiaPrompt = candidates.some((candidate) =>
    candidate.source !== "dream_delete"
    && !isProtectedCandidate(candidate)
    && candidate.target_exists === 1
    && candidate.target_pinned !== 1
    && !PERSONA_MEMORY_TYPES.includes(candidate.target_type ?? "")
  ) ? await loadOperiaReviewPrompt(env,input.namespace) : "";
  const discardMax = readUnitFloat(env.JUDGE_DISCARD_MAX,DEFAULT_DISCARD_MAX);
  let captured = 0;
  let skipped = 0;
  let modelFailed = 0;

  for (const candidate of candidates) {
    const now = new Date().toISOString();
    const sourceMessageIds = [...new Set(parseJsonArray(candidate.source_message_ids))];
    const messages = sourceMessageIds.length > 0
      ? await getMessagesByIds(env.DB,{ namespace: input.namespace,ids: sourceMessageIds })
      : [];
    const presentIds = new Set(messages.map((message) => message.id));
    const missingEvidenceCount = sourceMessageIds.filter((id) => !presentIds.has(id)).length;
    const attemptNo = Math.min(Number(candidate.prior_attempts ?? 0) + 1,LEGACY_BACKFILL_MAX_ATTEMPTS);
    const record = async (status: LegacyBackfillAttemptStatus,reasonCodes: string[],judgeOutputHash?: string | null): Promise<void> => {
      await recordLegacyBackfillAttempt(env.DB,{
        runId: input.runId,candidateId: candidate.id,attemptNo,status,
        sourceRefCount: sourceMessageIds.length,presentEvidenceCount: messages.length,missingEvidenceCount,
        reasonCodes,judgeOutputHash,createdAtUtc: now,
      });
    };

    if (candidate.source === "dream_delete") {
      await record("SKIPPED_ARCHIVE_ACTION",["LEGACY_ARCHIVE_ACTION_NOT_FACT"]);
      skipped += 1;
      continue;
    }
    if (isProtectedCandidate(candidate) || candidate.target_pinned === 1 || PERSONA_MEMORY_TYPES.includes(candidate.target_type ?? "")) {
      await record("SKIPPED_PROTECTED",["PROTECTED_OWNER_CONFIRMATION_REQUIRED"]);
      skipped += 1;
      continue;
    }
    if (candidate.target_exists !== 1 || !candidate.target_memory_id) {
      await record("SKIPPED_TARGET_MISSING",["LEGACY_TARGET_MEMORY_MISSING"]);
      skipped += 1;
      continue;
    }
    if (messages.length === 0) {
      await record("SKIPPED_NO_CANONICAL_EVIDENCE",["CANONICAL_EVIDENCE_MISSING"]);
      skipped += 1;
      continue;
    }

    const judgeResult = await callJudgeModel(env,run.model,buildJudgePrompt(candidate,messages,operiaPrompt,[]));
    if (!judgeResult) {
      const terminal = attemptNo >= LEGACY_BACKFILL_MAX_ATTEMPTS;
      await record(
        terminal ? "SKIPPED_MODEL_FAILURE_LIMIT" : "MODEL_FAILED",
        [terminal ? "MODEL_FAILURE_LIMIT_REACHED" : "MODEL_INVALID_STRUCTURED_OUTPUT"],
      );
      modelFailed += 1;
      continue;
    }
    const judgeOutputHash = await memoryArtifactHash("memory-legacy-backfill-judge-output",judgeResult);
    const accepted = judgeResult.decision !== "discard"
      && judgeResult.grounded
      && judgeResult.durable
      && judgeResult.score > discardMax
      && judgeResult.vnextClaim !== null;
    if (!accepted) {
      const reasonCodes = [
        judgeResult.decision === "discard" ? "MODEL_DISCARD" : "MODEL_ACCEPT",
        judgeResult.grounded ? "MODEL_GROUNDED" : "MODEL_UNGROUNDED",
        judgeResult.durable ? "MODEL_DURABLE" : "MODEL_NOT_DURABLE",
        judgeResult.score > discardMax ? "MODEL_SCORE_ABOVE_FLOOR" : "MODEL_SCORE_BELOW_FLOOR",
        judgeResult.vnextClaim ? "MODEL_CLAIM_PRESENT" : "MODEL_CLAIM_MISSING",
      ];
      await record("SKIPPED_MODEL_REVIEW",reasonCodes,judgeOutputHash);
      skipped += 1;
      continue;
    }

    const learnedAtUtc = canonicalUtc(candidate.learned_at_utc,candidate.updated_at);
    await captureAndEnqueueOrdinaryFactWrite(env.DB,{
      namespace: input.namespace,
      judgeRunId: input.runId,
      candidateId: candidate.id,
      legacyMemoryId: candidate.target_memory_id,
      legacyOutcome: candidate.status === "merged" ? "merged" : "approved",
      claim: judgeResult.vnextClaim,
      sourceMessageIds,
      judgeModel: run.model,
      judgePolicyVersion: LEGACY_BACKFILL_POLICY_VERSION,
      createdAtUtc: now,
      origin: "legacy_backfill",
      learnedAtUtc,
      claimCapturedAtUtc: now,
      backfillRunId: input.runId,
    });
    await record("CAPTURED",["FRESH_PROPOSAL_CAPTURED","HARNESS_REVALIDATION_REQUIRED"],judgeOutputHash);
    captured += 1;
  }

  const writer = await drainOrdinaryFactWrites(env,input.namespace,{ limit: Math.max(captured,1) });
  const remaining = await countLegacyBackfillRemaining(env.DB,input.namespace);
  await reconcileLegacyBackfillRunCounters(env.DB,input.runId);
  return {
    ran: true,
    run_id: input.runId,
    processed: candidates.length,
    captured,
    skipped,
    model_failed: modelFailed,
    writer,
    remaining,
  };
}

export async function finalizeLegacyVNextBackfillRun(
  db: D1Database,
  input: { runId: string; status: "completed" | "budget_exhausted" | "failed" },
): Promise<void> {
  await reconcileLegacyBackfillRunCounters(db,input.runId);
  await db.prepare(`UPDATE memory_legacy_fact_backfill_runs SET status=?,completed_at=?
    WHERE run_id=? AND status IN ('queued','running')`).bind(input.status,new Date().toISOString(),input.runId).run();
}

async function reconcileLegacyBackfillRunCounters(db: D1Database,runId: string): Promise<void> {
  await db.prepare(`UPDATE memory_legacy_fact_backfill_runs SET
    processed_count=(SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts WHERE run_id=?),
    captured_count=(SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts WHERE run_id=? AND status='CAPTURED'),
    skipped_count=(SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts WHERE run_id=? AND status IN (
      'SKIPPED_ARCHIVE_ACTION','SKIPPED_PROTECTED','SKIPPED_TARGET_MISSING',
      'SKIPPED_NO_CANONICAL_EVIDENCE','SKIPPED_MODEL_REVIEW'
    )),
    model_failed_count=(SELECT COUNT(*) FROM memory_legacy_fact_backfill_attempts WHERE run_id=? AND status IN (
      'MODEL_FAILED','SKIPPED_MODEL_FAILURE_LIMIT'
    ))
    WHERE run_id=?`).bind(runId,runId,runId,runId,runId).run();
}
