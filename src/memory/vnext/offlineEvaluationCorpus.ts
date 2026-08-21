import type {
  CounterfactualArm,
  CounterfactualArmResult,
  CounterfactualCaseResult,
  CounterfactualSummary,
  CounterfactualThresholds,
} from "./counterfactualEvaluation";
import { summarizeCounterfactualResults } from "./counterfactualEvaluation";
import type { DynamicRecallNeed } from "./contracts";

export const MEMORY_COUNTERFACTUAL_CORPUS_SCHEMA_VERSION = "memory-counterfactual-corpus-v1";

export type CounterfactualCorpusKind = "synthetic_contract" | "owner_private_replay";
export type CounterfactualThresholdPolicy = "fixture_only" | "owner_frozen";

export type OfflineCounterfactualCorpus = {
  schema_version: string;
  corpus_id: string;
  corpus_kind: CounterfactualCorpusKind;
  owner_reviewed: boolean;
  threshold_policy: CounterfactualThresholdPolicy;
  minimum_case_count: number;
  thresholds: CounterfactualThresholds;
  cases: Array<{
    case_id: string;
    expected_need: DynamicRecallNeed;
    invariant: {
      stable_prefix_hash: string;
      live_context_hash: string;
      request_hash: string;
      primary_provider: string;
      primary_model: string;
      decoding_config: Record<string,unknown>;
      tool_availability_hash: string;
    };
    arms: Array<{
      arm: CounterfactualArm;
      observed_need: DynamicRecallNeed;
      dynamic_packet_hash: string | null;
      dynamic_packet_tokens: number;
      output_hash: string;
      answer_correct: boolean;
      appropriate_abstention: boolean;
      evidence_utilized: boolean;
      unnecessary_interference: boolean;
    }>;
  }>;
};

export type OfflineCounterfactualReport = {
  corpusId: string;
  corpusKind: CounterfactualCorpusKind;
  caseCount: number;
  summary: CounterfactualSummary;
  behaviorEvidenceQualifiesForCutoverReview: boolean;
  productionCutoverAuthorized: false;
  releaseBlockerCodes: string[];
  evidenceClass: "SYNTHETIC_CONTRACT_ONLY" | "OWNER_PRIVATE_BEHAVIOR_EVIDENCE";
};

function isRecord(value: unknown): value is Record<string,unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown,code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function booleanValue(value: unknown,code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function integerValue(value: unknown,code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function needValue(value: unknown): DynamicRecallNeed {
  if (value !== "BYPASS" && value !== "OPTIONAL" && value !== "REQUIRED") {
    throw new Error("memory_counterfactual_corpus_need_invalid");
  }
  return value;
}

function armValue(value: unknown): CounterfactualArm {
  if (value !== "BASE" && value !== "OPERIA" && value !== "ORACLE" && value !== "ADVERSARIAL") {
    throw new Error("memory_counterfactual_corpus_arm_invalid");
  }
  return value;
}

function thresholdsValue(value: unknown): CounterfactualThresholds {
  if (!isRecord(value)) throw new Error("memory_counterfactual_corpus_thresholds_invalid");
  const names = [
    "maxMemoryInducedRegressionRate",
    "maxUnnecessaryInjectionRate",
    "maxNeedednessFalseNegativeRate",
    "minSafeMarginalUtility",
  ] as const;
  const parsed = Object.fromEntries(names.map((name) => {
    const item = value[name];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error(`memory_counterfactual_corpus_threshold_${name}_invalid`);
    }
    return [name,item];
  })) as CounterfactualThresholds;
  return parsed;
}

export function parseOfflineCounterfactualCorpus(value: unknown): OfflineCounterfactualCorpus {
  if (!isRecord(value)) throw new Error("memory_counterfactual_corpus_object_required");
  if (value.schema_version !== MEMORY_COUNTERFACTUAL_CORPUS_SCHEMA_VERSION) {
    throw new Error("memory_counterfactual_corpus_schema_unsupported");
  }
  const corpusKind = value.corpus_kind;
  if (corpusKind !== "synthetic_contract" && corpusKind !== "owner_private_replay") {
    throw new Error("memory_counterfactual_corpus_kind_invalid");
  }
  const thresholdPolicy = value.threshold_policy;
  if (thresholdPolicy !== "fixture_only" && thresholdPolicy !== "owner_frozen") {
    throw new Error("memory_counterfactual_threshold_policy_invalid");
  }
  if (!Array.isArray(value.cases)) throw new Error("memory_counterfactual_corpus_cases_required");
  const caseIds = new Set<string>();
  const cases = value.cases.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("memory_counterfactual_corpus_case_invalid");
    const caseId = stringValue(candidate.case_id,"memory_counterfactual_corpus_case_id_required");
    if (caseIds.has(caseId)) throw new Error("memory_counterfactual_corpus_case_duplicate");
    caseIds.add(caseId);
    if (!isRecord(candidate.invariant)) throw new Error("memory_counterfactual_corpus_invariant_required");
    const invariant = candidate.invariant;
    if (!isRecord(invariant.decoding_config)) throw new Error("memory_counterfactual_decoding_config_invalid");
    if (!Array.isArray(candidate.arms)) throw new Error("memory_counterfactual_corpus_arms_required");
    const seenArms = new Set<CounterfactualArm>();
    const arms = candidate.arms.map((candidateArm) => {
      if (!isRecord(candidateArm)) throw new Error("memory_counterfactual_corpus_arm_invalid");
      const arm = armValue(candidateArm.arm);
      if (seenArms.has(arm)) throw new Error("memory_counterfactual_corpus_arm_duplicate");
      seenArms.add(arm);
      const packetHash = candidateArm.dynamic_packet_hash;
      if (packetHash !== null && (typeof packetHash !== "string" || !packetHash)) {
        throw new Error("memory_counterfactual_corpus_packet_hash_invalid");
      }
      const packetTokens = integerValue(candidateArm.dynamic_packet_tokens,"memory_counterfactual_corpus_packet_tokens_invalid");
      if ((packetHash === null) !== (packetTokens === 0)) {
        throw new Error("memory_counterfactual_corpus_packet_token_pair_invalid");
      }
      if (arm === "BASE" && packetHash !== null) throw new Error("memory_counterfactual_corpus_base_packet_forbidden");
      if ((arm === "ORACLE" || arm === "ADVERSARIAL") && packetHash === null) {
        throw new Error("memory_counterfactual_corpus_diagnostic_packet_required");
      }
      return {
        arm,
        observed_need: needValue(candidateArm.observed_need),
        dynamic_packet_hash: packetHash,
        dynamic_packet_tokens: packetTokens,
        output_hash: stringValue(candidateArm.output_hash,"memory_counterfactual_corpus_output_hash_required"),
        answer_correct: booleanValue(candidateArm.answer_correct,"memory_counterfactual_corpus_answer_label_required"),
        appropriate_abstention: booleanValue(candidateArm.appropriate_abstention,"memory_counterfactual_corpus_abstention_label_required"),
        evidence_utilized: booleanValue(candidateArm.evidence_utilized,"memory_counterfactual_corpus_utilization_label_required"),
        unnecessary_interference: booleanValue(candidateArm.unnecessary_interference,"memory_counterfactual_corpus_interference_label_required"),
      };
    });
    if (seenArms.size !== 4) throw new Error("memory_counterfactual_corpus_four_arms_required");
    return {
      case_id: caseId,
      expected_need: needValue(candidate.expected_need),
      invariant: {
        stable_prefix_hash: stringValue(invariant.stable_prefix_hash,"memory_counterfactual_stable_prefix_hash_required"),
        live_context_hash: stringValue(invariant.live_context_hash,"memory_counterfactual_live_context_hash_required"),
        request_hash: stringValue(invariant.request_hash,"memory_counterfactual_request_hash_required"),
        primary_provider: stringValue(invariant.primary_provider,"memory_counterfactual_primary_provider_required"),
        primary_model: stringValue(invariant.primary_model,"memory_counterfactual_primary_model_required"),
        decoding_config: invariant.decoding_config,
        tool_availability_hash: stringValue(invariant.tool_availability_hash,"memory_counterfactual_tool_hash_required"),
      },
      arms,
    };
  });
  return {
    schema_version: MEMORY_COUNTERFACTUAL_CORPUS_SCHEMA_VERSION,
    corpus_id: stringValue(value.corpus_id,"memory_counterfactual_corpus_id_required"),
    corpus_kind: corpusKind,
    owner_reviewed: booleanValue(value.owner_reviewed,"memory_counterfactual_owner_reviewed_required"),
    threshold_policy: thresholdPolicy,
    minimum_case_count: integerValue(value.minimum_case_count,"memory_counterfactual_minimum_case_count_invalid"),
    thresholds: thresholdsValue(value.thresholds),
    cases,
  };
}

function toCaseResult(item: OfflineCounterfactualCorpus["cases"][number]): CounterfactualCaseResult {
  const arms: CounterfactualArmResult[] = item.arms.map((arm) => ({
    caseId: item.case_id,
    arm: arm.arm,
    observedNeed: arm.observed_need,
    dynamicPacketHash: arm.dynamic_packet_hash,
    dynamicPacketTokens: arm.dynamic_packet_tokens,
    answerCorrect: arm.answer_correct,
    appropriateAbstention: arm.appropriate_abstention,
    evidenceUtilized: arm.evidence_utilized,
    unnecessaryInterference: arm.unnecessary_interference,
  }));
  return { caseId:item.case_id,expectedNeed:item.expected_need,arms };
}

export async function evaluateOfflineCounterfactualCorpus(value: unknown): Promise<OfflineCounterfactualReport> {
  const corpus = parseOfflineCounterfactualCorpus(value);
  const summary = await summarizeCounterfactualResults({ cases:corpus.cases.map(toCaseResult),thresholds:corpus.thresholds });
  const releaseBlockerCodes = [...summary.blockerCodes];
  if (corpus.corpus_kind !== "owner_private_replay") releaseBlockerCodes.push("OWNER_PRIVATE_BEHAVIOR_CORPUS_REQUIRED");
  if (corpus.threshold_policy !== "owner_frozen") releaseBlockerCodes.push("OWNER_FROZEN_THRESHOLDS_REQUIRED");
  if (!corpus.owner_reviewed) releaseBlockerCodes.push("OWNER_REVIEW_REQUIRED");
  if (corpus.cases.length < corpus.minimum_case_count) releaseBlockerCodes.push("MINIMUM_CASE_COUNT_NOT_MET");
  const blockers = [...new Set(releaseBlockerCodes)].sort();
  return {
    corpusId: corpus.corpus_id,
    corpusKind: corpus.corpus_kind,
    caseCount: corpus.cases.length,
    summary,
    behaviorEvidenceQualifiesForCutoverReview: blockers.length === 0,
    productionCutoverAuthorized: false,
    releaseBlockerCodes: blockers,
    evidenceClass: corpus.corpus_kind === "synthetic_contract"
      ? "SYNTHETIC_CONTRACT_ONLY" : "OWNER_PRIVATE_BEHAVIOR_EVIDENCE",
  };
}
