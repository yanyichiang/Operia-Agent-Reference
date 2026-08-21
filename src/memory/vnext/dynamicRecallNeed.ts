import type { DynamicRecallNeed } from "./contracts";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_DYNAMIC_RECALL_NEED_POLICY_VERSION = "memory-dynamic-recall-need-v2.0.0";

export type DynamicRecallLane = "fact_revision" | "episodic" | "subject" | "owner_model" | "point";

export type DynamicRecallContext = {
  currentRequest: string;
  requestIdentity?: string;
  liveContextSufficient?: boolean;
  explicitPrivateHistoryDependency?: boolean;
  requestedPersonalization?: boolean;
};

export type DynamicRecallDecision = {
  decisionId: string;
  need: DynamicRecallNeed;
  reasonCodes: string[];
  queryLanes: DynamicRecallLane[];
  deterministicFloorRequired: boolean;
  controlsStablePrefix: false;
  controlsRecentTurns: false;
  controlsRollingSummary: false;
  policyVersion: string;
};

const privateHistoryPatterns = [
  /(?:上次|之前|以前|当时|过去).{0,18}(?:说|聊|提|答应|决定|做|发生|告诉|记)/u,
  /(?:还|你)?记得/u,
  /(?:我们|你和我).{0,16}(?:说过|聊过|约定|答应|决定)/u,
  /(?:我|我的).{0,16}(?:过去|以前|上次|之前|历史|先前承诺)/u,
  /\b(?:remember|last time|previously|earlier|before|prior commitment|our earlier)\b/i,
];

const explicitPersonalizationPatterns = [
  /(?:按|根据|结合).{0,8}(?:我的|你对我的).{0,12}(?:偏好|习惯|风格|情况|经历|目标)/u,
  /(?:适合我|为我量身|你觉得我会|以你对我的了解)/u,
  /\b(?:based on my preferences|what suits me|given what you know about me|personalize for me)\b/i,
];

const pointContinuityPatterns = [
  /(?:你之前怎么看|你上次的观点|延续你的看法|你的长期看法)/u,
  /\b(?:your previous view|continue your earlier view)\b/i,
];

const selfContainedBypassPatterns = [
  /^(?:你好|嗨|早上好|下午好|晚上好|谢谢|好的|收到)[！!。.]?$/u,
  /^(?:翻译|改写|润色|总结|格式化)(?:以下|这段|下面).{1,600}$/su,
  /^(?:translate|rewrite|summarize|format)\s+(?:the following|this)\b/is,
];

function matchesAny(text: string,patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function queryLanesFor(input: DynamicRecallContext,need: DynamicRecallNeed): DynamicRecallLane[] {
  if (need === "BYPASS") return [];
  const request = input.currentRequest.normalize("NFKC");
  const lanes = new Set<DynamicRecallLane>();
  if (need === "REQUIRED") {
    lanes.add("fact_revision");
    lanes.add("episodic");
    if (/(?:身份|关系|权限|边界|你是谁|我是谁)|\b(?:identity|relationship|permission|boundary)\b/i.test(request)) {
      lanes.add("subject");
    }
  } else {
    lanes.add("fact_revision");
  }
  if (input.requestedPersonalization || matchesAny(request,explicitPersonalizationPatterns)) lanes.add("owner_model");
  if (matchesAny(request,pointContinuityPatterns)) lanes.add("point");
  return [...lanes].sort();
}

export async function decideDynamicRecallNeed(input: DynamicRecallContext): Promise<DynamicRecallDecision> {
  const request = input.currentRequest.normalize("NFKC").trim();
  let need: DynamicRecallNeed;
  const reasonCodes: string[] = [];
  if (!request) {
    need = "BYPASS";
    reasonCodes.push("EMPTY_CURRENT_REQUEST");
  } else if (input.explicitPrivateHistoryDependency || matchesAny(request,privateHistoryPatterns)) {
    need = "REQUIRED";
    reasonCodes.push(input.explicitPrivateHistoryDependency
      ? "CALLER_CONFIRMED_PRIVATE_HISTORY_DEPENDENCY"
      : "EXPLICIT_PRIVATE_HISTORY_REFERENCE");
  } else if (matchesAny(request,explicitPersonalizationPatterns)) {
    need = "REQUIRED";
    reasonCodes.push("ANSWER_DEPENDS_ON_OWNER_SPECIFIC_CONTEXT");
  } else if (input.liveContextSufficient) {
    need = "BYPASS";
    reasonCodes.push("LIVE_CONTEXT_EXPLICITLY_SUFFICIENT");
  } else if (matchesAny(request,selfContainedBypassPatterns)) {
    need = "BYPASS";
    reasonCodes.push("SELF_CONTAINED_REQUEST");
  } else {
    need = "OPTIONAL";
    reasonCodes.push("UNCERTAIN_DEFAULT_OPTIONAL");
  }
  const queryLanes = queryLanesFor(input,need);
  const core = {
    need,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    queryLanes,
    deterministicFloorRequired: need === "REQUIRED",
    controlsStablePrefix: false as const,
    controlsRecentTurns: false as const,
    controlsRollingSummary: false as const,
    policyVersion: MEMORY_DYNAMIC_RECALL_NEED_POLICY_VERSION,
  };
  const hash = await memoryArtifactHash("memory-dynamic-recall-decision-v2", {
    requestIdentity: input.requestIdentity ?? null,
    request,
    liveContextSufficient: input.liveContextSufficient === true,
    explicitPrivateHistoryDependency: input.explicitPrivateHistoryDependency === true,
    requestedPersonalization: input.requestedPersonalization === true,
    ...core,
  });
  return { decisionId: `drn_${hash.slice(0,32)}`,...core };
}

export async function persistDynamicRecallDecision(input: {
  db: D1Database;
  decision: DynamicRecallDecision;
  requestIdHash: string;
  namespaceHash: string;
  queryHash: string;
  liveContextSufficient: boolean;
  mode: "SHADOW" | "ENFORCED";
  createdAtUtc: string;
}): Promise<void> {
  await input.db.prepare(`INSERT OR IGNORE INTO memory_dynamic_recall_decisions(
    decision_id,request_id_hash,namespace_hash,query_hash,need,live_context_sufficient,
    reason_codes_json,query_lanes_json,deterministic_floor_required,mode,policy_version,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    input.decision.decisionId,input.requestIdHash,input.namespaceHash,input.queryHash,input.decision.need,
    input.liveContextSufficient ? 1 : 0,JSON.stringify(input.decision.reasonCodes),
    JSON.stringify(input.decision.queryLanes),input.decision.deterministicFloorRequired ? 1 : 0,
    input.mode,input.decision.policyVersion,input.createdAtUtc,
  ).run();
}

export async function persistDynamicRecallOutcome(input: {
  db: D1Database;
  decision: DynamicRecallDecision;
  status: "BYPASSED" | "FOUND" | "EMPTY" | "MISS" | "DEGRADED";
  candidateCount: number;
  selectedGroupCount: number;
  packetHash: string | null;
  reasonCode: string;
  elapsedMs: number;
  createdAtUtc: string;
}): Promise<string> {
  const hash = await memoryArtifactHash("memory-dynamic-recall-outcome-v2", {
    decisionId: input.decision.decisionId,status: input.status,candidateCount: input.candidateCount,
    selectedGroupCount: input.selectedGroupCount,packetHash: input.packetHash,reasonCode: input.reasonCode,
  });
  const outcomeId = `dro_${hash.slice(0,32)}`;
  await input.db.prepare(`INSERT OR IGNORE INTO memory_dynamic_recall_outcomes(
    outcome_id,decision_id,status,candidate_count,selected_group_count,packet_hash,reason_code,
    elapsed_ms,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    outcomeId,input.decision.decisionId,input.status,input.candidateCount,input.selectedGroupCount,
    input.packetHash,input.reasonCode,Math.max(0,Math.floor(input.elapsedMs)),input.createdAtUtc,
  ).run();
  return outcomeId;
}
