// Authorized proposal/write boundary for callers outside memory/vnext.
// Models may propose through this surface; commit authority remains inside the
// Harness implementations exported here.
export function resolveProposalModel(
  env: {
    MEMORY_GROK_PROPOSAL_PRIMARY_ENABLED?: string;
    MEMORY_GROK_PROPOSAL_MODEL?: string;
  },
  legacyModel: string,
): string {
  if (env.MEMORY_GROK_PROPOSAL_PRIMARY_ENABLED !== "true") return legacyModel.trim();
  return env.MEMORY_GROK_PROPOSAL_MODEL?.trim() || "xai/grok-4.5";
}

export { buildLocalSecretRedactedViews } from "./secretViews";
export {
  captureAndEnqueueOrdinaryFactWrite,
  captureOrdinaryJudgeClaim,
  drainOrdinaryFactWrites,
  enqueueOrdinaryFactWrite,
  type OrdinaryJudgeClaim,
  type OrdinaryJudgeClaimAtomProposal,
} from "./ordinaryFactWriter";
export { memoryArtifactHash } from "./integrity";
