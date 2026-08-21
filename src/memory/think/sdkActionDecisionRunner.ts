import { enqueueThinkSdkActionDecision, enqueueThinkSdkActionState } from "../../queue/producer";
import type { Env, ThinkSdkActionDecisionQueueMessage } from "../../types";
import {
  claimThinkSdkActionExecution,
  completeThinkSdkActionSiblings,
  markThinkSdkActionAttention,
  markThinkSdkActionContinuing,
  readThinkSdkActionProjection,
  requeueThinkSdkActionDecision,
  type ThinkSdkActionProjectionRow,
} from "./sdkActionProjection";

const MAX_DECISION_ATTEMPTS = 3;

type ThinkSdkActionRpc = {
  setName(name: string): Promise<void>;
  resolveSdkToolApproval(input: {
    requestId: string;
    executionId: string;
    decision: "approve" | "reject";
  }): Promise<{ status?: string }>;
  failSdkToolActionDecision(input: { requestId: string; error: string }): Promise<void>;
};

export async function runThinkSdkActionDecision(
  env: Env,
  message: ThinkSdkActionDecisionQueueMessage,
): Promise<void> {
  let row = await readThinkSdkActionProjection(env.DB,message.approvalRef);
  if (!row) return;
  if (row.status === "continuing") {
    await enqueueThinkSdkActionState(env,row.request_id,0,0);
    return;
  }
  if (["completed","attention_required"].includes(row.status)) return;
  if (row.status !== "decision_pending" && row.status !== "resolving") return;

  const claimed = await claimThinkSdkActionExecution(env.DB,message.approvalRef);
  if (!claimed) {
    row = await readThinkSdkActionProjection(env.DB,message.approvalRef);
    if (row?.status === "resolving") await enqueueThinkSdkActionDecision(env,message.approvalRef,message.attempt,5);
    else if (row?.status === "continuing") await enqueueThinkSdkActionState(env,row.request_id,0,0);
    return;
  }
  if (claimed.decision !== "approve" && claimed.decision !== "reject") {
    await terminalizeDecisionFailure(env,claimed,"think_sdk_action_decision_missing");
    return;
  }

  try {
    if (!env.OPERIA_THINK) throw new Error("think_sdk_action_namespace_missing");
    const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(claimed.think_instance_id)) as unknown as ThinkSdkActionRpc;
    await think.setName(claimed.think_instance_id);
    const result = await think.resolveSdkToolApproval({
      requestId:claimed.request_id,
      executionId:claimed.execution_id,
      decision:claimed.decision,
    });
    if (result?.status !== "accepted" && result?.status !== "already_resolved") {
      throw new Error(`think_sdk_action_resolution_${boundedCode(result?.status || "invalid")}`);
    }
    await markThinkSdkActionContinuing(env.DB,claimed.approval_ref);
    await completeThinkSdkActionSiblings(env.DB,claimed.request_id,claimed.approval_ref);
    // This post-transition event closes the race where Think's terminal hook
    // publishes before the D1 projection becomes eligible.
    await enqueueThinkSdkActionState(env,claimed.request_id,0,0);
  } catch (error) {
    const code = boundedCode(error instanceof Error ? error.message : String(error));
    if (message.attempt + 1 < MAX_DECISION_ATTEMPTS) {
      await requeueThinkSdkActionDecision(env.DB,claimed.approval_ref,code);
      await enqueueThinkSdkActionDecision(env,claimed.approval_ref,message.attempt+1,2 ** (message.attempt+1));
      return;
    }
    await terminalizeDecisionFailure(env,claimed,code || "think_sdk_action_resolution_failed");
  }
}

async function terminalizeDecisionFailure(
  env: Env,
  row: ThinkSdkActionProjectionRow,
  code: string,
): Promise<void> {
  try {
    if (!env.OPERIA_THINK) throw new Error("think_sdk_action_namespace_missing");
    const think = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(row.think_instance_id)) as unknown as ThinkSdkActionRpc;
    await think.setName(row.think_instance_id);
    await think.failSdkToolActionDecision({ requestId:row.request_id, error:code });
    await markThinkSdkActionContinuing(env.DB,row.approval_ref);
    await completeThinkSdkActionSiblings(env.DB,row.request_id,row.approval_ref);
    await enqueueThinkSdkActionState(env,row.request_id,0,0);
  } catch (terminalError) {
    await markThinkSdkActionAttention(env.DB,row.approval_ref,
      boundedCode(terminalError instanceof Error ? terminalError.message : String(terminalError)) || code);
  }
}

function boundedCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g,"_").slice(0,160) || "think_sdk_action_resolution_failed";
}
