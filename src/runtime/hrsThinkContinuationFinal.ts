import { completeInferenceReplay } from "../memory/inferenceIdempotency";
import { enqueueTgInferenceReady, enqueueTgInferenceResume } from "../queue/producer";
import type { Env } from "../types";
import { completeHrsThinkExecutionForReplay, markHrsThinkProjectionComplete } from "./hrsThinkExecutionStore";
import { persistHrsTurnOutcome } from "./hrsTelemetry";
import { sha256Hex } from "../utils/hash";

export type ThinkContinuationAuthority = "accepted" | "hrs";

export async function completeThinkContinuationReplay(input: {
  env: Env;
  hrsExecutionId: string | null;
  requestIdentity: string;
  requestHash: string;
  source: string;
  responseJson: string;
  terminalStatus: string;
}): Promise<ThinkContinuationAuthority> {
  if (!input.hrsExecutionId) {
    await completeInferenceReplay(input.env.DB,input.requestIdentity,input.responseJson,200,{
      requestHash:input.requestHash,source:input.source,
    });
    return "accepted";
  }
  const row = await completeHrsThinkExecutionForReplay(input.env.DB,{
    executionId:input.hrsExecutionId,requestIdentity:input.requestIdentity,
    responseJson:input.responseJson,terminalStatus:input.terminalStatus,
  });
  await persistHrsTurnOutcome({
    db:input.env.DB,requestId:row.request_identity,revision:2,status:"completed",
    modelCallCount:row.model_call_count,toolCallCount:row.tool_call_count,
    directCallCount:row.direct_call_count,recoveryReason:input.terminalStatus,
  }).catch((error) => console.error("hrs_continuation_outcome_telemetry_degraded",{
    code:String(error instanceof Error ? error.message : error).slice(0,160),
  }));
  return "hrs";
}

export async function enqueueThinkContinuationFinalWake(input: {
  env: Env;
  authority: ThinkContinuationAuthority;
  requestIdentity: string;
  tgBatchKey: string | null;
  hrsExecutionId?: string | null;
  responseJson?: string;
}): Promise<void> {
  if (!input.tgBatchKey) return;
  if (input.authority === "hrs") {
    await enqueueTgInferenceReady(input.env,input.requestIdentity);
    if (input.hrsExecutionId && input.responseJson) {
      await markHrsThinkProjectionComplete(input.env.DB,{
        executionId:input.hrsExecutionId,
        resultHash:await sha256Hex(input.responseJson),
      });
    }
    return;
  }
  await enqueueTgInferenceResume(input.env,input.tgBatchKey,0);
}
