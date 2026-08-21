import { canonicalJson } from "../import/hashes";
import type { DynamicRecallNeed } from "./contracts";
import { memoryArtifactHash } from "./integrity";

export const MEMORY_COUNTERFACTUAL_EVALUATOR_VERSION = "memory-counterfactual-evaluation-v2.0.0";

export type CounterfactualArm = "BASE" | "OPERIA" | "ORACLE" | "ADVERSARIAL";

export type CounterfactualArmResult = {
  caseId: string;
  arm: CounterfactualArm;
  observedNeed: DynamicRecallNeed;
  dynamicPacketHash: string | null;
  dynamicPacketTokens: number;
  answerCorrect: boolean;
  appropriateAbstention: boolean;
  evidenceUtilized: boolean;
  unnecessaryInterference: boolean;
};

export type CounterfactualCaseResult = {
  caseId: string;
  expectedNeed: DynamicRecallNeed;
  arms: CounterfactualArmResult[];
};

export type CounterfactualThresholds = {
  maxMemoryInducedRegressionRate: number;
  maxUnnecessaryInjectionRate: number;
  maxNeedednessFalseNegativeRate: number;
  minSafeMarginalUtility: number;
};

export type CounterfactualSummary = {
  completeCaseCount: number;
  needfulGainCount: number;
  memoryInducedRegressionCount: number;
  oracleGapCount: number;
  evidenceUtilizationFailureCount: number;
  unnecessaryInjectionCount: number;
  needednessFalseNegativeCount: number;
  unnecessaryInterferenceCount: number;
  safeMarginalUtility: number;
  thresholds: CounterfactualThresholds;
  blockerCodes: string[];
  metricsHash: string;
  evaluatorVersion: string;
};

function armMap(result: CounterfactualCaseResult): Map<CounterfactualArm,CounterfactualArmResult> {
  const map = new Map<CounterfactualArm,CounterfactualArmResult>();
  for (const arm of result.arms) {
    if (arm.caseId !== result.caseId) throw new Error("memory_counterfactual_case_arm_identity_mismatch");
    if (map.has(arm.arm)) throw new Error("memory_counterfactual_arm_duplicate");
    if (arm.dynamicPacketTokens < 0 || !Number.isSafeInteger(arm.dynamicPacketTokens)) {
      throw new Error("memory_counterfactual_packet_tokens_invalid");
    }
    if (arm.arm === "BASE" && (arm.dynamicPacketHash !== null || arm.dynamicPacketTokens !== 0)) {
      throw new Error("memory_counterfactual_base_dynamic_packet_forbidden");
    }
    map.set(arm.arm,arm);
  }
  return map;
}

function validRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function summarizeCounterfactualResults(input: {
  cases: CounterfactualCaseResult[];
  thresholds: CounterfactualThresholds;
}): Promise<CounterfactualSummary> {
  if (!validRate(input.thresholds.maxMemoryInducedRegressionRate)
    || !validRate(input.thresholds.maxUnnecessaryInjectionRate)
    || !validRate(input.thresholds.maxNeedednessFalseNegativeRate)
    || !Number.isFinite(input.thresholds.minSafeMarginalUtility)) {
    throw new Error("memory_counterfactual_threshold_invalid");
  }
  const caseIds = new Set<string>();
  let needfulGainCount = 0;
  let memoryInducedRegressionCount = 0;
  let oracleGapCount = 0;
  let evidenceUtilizationFailureCount = 0;
  let unnecessaryInjectionCount = 0;
  let needednessFalseNegativeCount = 0;
  let unnecessaryInterferenceCount = 0;
  for (const item of input.cases) {
    if (caseIds.has(item.caseId)) throw new Error("memory_counterfactual_case_duplicate");
    caseIds.add(item.caseId);
    const arms = armMap(item);
    const base = arms.get("BASE");
    const operia = arms.get("OPERIA");
    const oracle = arms.get("ORACLE");
    const adversarial = arms.get("ADVERSARIAL");
    if (!base || !operia || !oracle || !adversarial) throw new Error("memory_counterfactual_four_arms_required");
    if (!base.answerCorrect && operia.answerCorrect) needfulGainCount += 1;
    if (base.answerCorrect && !operia.answerCorrect) memoryInducedRegressionCount += 1;
    if (oracle.answerCorrect && !operia.answerCorrect) oracleGapCount += 1;
    if (!oracle.answerCorrect || (oracle.answerCorrect && !oracle.evidenceUtilized)) {
      evidenceUtilizationFailureCount += 1;
    }
    if (item.expectedNeed === "BYPASS" && (operia.dynamicPacketHash !== null || operia.dynamicPacketTokens > 0)) {
      unnecessaryInjectionCount += 1;
    }
    if (item.expectedNeed === "REQUIRED"
      && (operia.observedNeed === "BYPASS" || operia.dynamicPacketHash === null)) {
      needednessFalseNegativeCount += 1;
    }
    if (operia.unnecessaryInterference) unnecessaryInterferenceCount += 1;
  }
  const completeCaseCount = input.cases.length;
  const denominator = Math.max(completeCaseCount,1);
  const safeMarginalUtility = (needfulGainCount - memoryInducedRegressionCount - unnecessaryInterferenceCount) / denominator;
  const blockerCodes: string[] = [];
  if (memoryInducedRegressionCount / denominator > input.thresholds.maxMemoryInducedRegressionRate) {
    blockerCodes.push("MEMORY_INDUCED_REGRESSION_RATE_EXCEEDED");
  }
  if (unnecessaryInjectionCount / denominator > input.thresholds.maxUnnecessaryInjectionRate) {
    blockerCodes.push("UNNECESSARY_INJECTION_RATE_EXCEEDED");
  }
  if (needednessFalseNegativeCount / denominator > input.thresholds.maxNeedednessFalseNegativeRate) {
    blockerCodes.push("NEEDEDNESS_FALSE_NEGATIVE_RATE_EXCEEDED");
  }
  if (safeMarginalUtility < input.thresholds.minSafeMarginalUtility) {
    blockerCodes.push("SAFE_MARGINAL_UTILITY_BELOW_FLOOR");
  }
  const core = {
    completeCaseCount,needfulGainCount,memoryInducedRegressionCount,oracleGapCount,
    evidenceUtilizationFailureCount,unnecessaryInjectionCount,needednessFalseNegativeCount,
    unnecessaryInterferenceCount,safeMarginalUtility,
    thresholds: input.thresholds,
    blockerCodes: blockerCodes.sort(),
    evaluatorVersion: MEMORY_COUNTERFACTUAL_EVALUATOR_VERSION,
  };
  const metricsHash = await memoryArtifactHash("memory-counterfactual-summary-v2",core);
  return { ...core,metricsHash };
}

export type CounterfactualInvariantInput = {
  stablePrefixHash: string;
  liveContextHash: string;
  requestHash: string;
  primaryProvider: string;
  primaryModel: string;
  decodingConfig: Record<string,unknown>;
};

export type CounterfactualExecutionPacket = {
  arm: CounterfactualArm;
  dynamicPacket: string | null;
  dynamicPacketHash: string | null;
};

export async function executeFourArmCase<T>(input: {
  invariant: CounterfactualInvariantInput;
  packets: Record<CounterfactualArm,CounterfactualExecutionPacket>;
  execute: (value: CounterfactualInvariantInput & CounterfactualExecutionPacket) => Promise<T>;
}): Promise<Record<CounterfactualArm,T>> {
  const arms: CounterfactualArm[] = ["BASE","OPERIA","ORACLE","ADVERSARIAL"];
  for (const arm of arms) {
    const packet = input.packets[arm];
    if (packet.arm !== arm) throw new Error("memory_counterfactual_packet_arm_mismatch");
    if (arm === "BASE" && (packet.dynamicPacket !== null || packet.dynamicPacketHash !== null)) {
      throw new Error("memory_counterfactual_base_packet_forbidden");
    }
    if ((packet.dynamicPacket === null) !== (packet.dynamicPacketHash === null)) {
      throw new Error("memory_counterfactual_packet_hash_pair_invalid");
    }
    if (packet.dynamicPacket !== null) {
      const actualHash = await memoryArtifactHash("memory-counterfactual-dynamic-packet-v2",packet.dynamicPacket);
      if (actualHash !== packet.dynamicPacketHash) throw new Error("memory_counterfactual_packet_hash_mismatch");
    }
  }
  const entries = await Promise.all(arms.map(async (arm) => [arm,await input.execute({
    ...input.invariant,...input.packets[arm],
  })] as const));
  return Object.fromEntries(entries) as Record<CounterfactualArm,T>;
}

export async function persistCounterfactualSummary(input: {
  db: D1Database;
  corpusId: string;
  primaryProvider: string;
  primaryModel: string;
  summary: CounterfactualSummary;
  createdAtUtc: string;
}): Promise<string> {
  const summaryId = `cfs_${input.summary.metricsHash.slice(0,32)}`;
  await input.db.prepare(`INSERT INTO memory_counterfactual_summaries(
    summary_id,corpus_id,primary_provider,primary_model,evaluator_version,complete_case_count,
    needful_gain_count,memory_induced_regression_count,oracle_gap_count,evidence_utilization_failure_count,
    unnecessary_injection_count,neededness_false_negative_count,unnecessary_interference_count,
    safe_marginal_utility,thresholds_json,blocker_codes_json,metrics_hash,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    summaryId,input.corpusId,input.primaryProvider,input.primaryModel,input.summary.evaluatorVersion,
    input.summary.completeCaseCount,input.summary.needfulGainCount,input.summary.memoryInducedRegressionCount,
    input.summary.oracleGapCount,input.summary.evidenceUtilizationFailureCount,input.summary.unnecessaryInjectionCount,
    input.summary.needednessFalseNegativeCount,input.summary.unnecessaryInterferenceCount,
    input.summary.safeMarginalUtility,canonicalJson(input.summary.thresholds),
    canonicalJson(input.summary.blockerCodes),input.summary.metricsHash,input.createdAtUtc,
  ).run();
  return summaryId;
}
