import { saveUsageLog } from "../../db/usageLogs";
import { getAnthropicCacheTtlMode } from "../../proxy/anthropicAdapter";
import {
  enqueueHrsThinkRecovery,
  enqueueMemoryMaintenanceIfNeeded,
  enqueueRetentionIfNeeded,
  enqueueTgInferenceReady,
} from "../../queue/producer";
import {
  buildHrsFinalResponse,
  buildHrsHeldResponse,
  buildHrsPendingResponse,
} from "../../runtime/hrsThinkResponses";
import {
  completeHrsThinkExecutionForReplay,
  createOrReadHrsThinkExecution,
  HrsThinkExecutionConflictError,
  isTerminalHrsThinkState,
  listDueHrsThinkExecutions,
  markHrsThinkCleanupComplete,
  markHrsThinkAttentionComplete,
  markHrsThinkProjectionComplete,
  markHrsThinkProjectionPending,
  markHrsThinkObservationComplete,
  readHrsThinkExecution,
  readHrsThinkExecutionReceipt,
  requireHrsThinkExecutionAttention,
  transitionHrsThinkExecution,
  type HrsThinkExecutionIdentity,
  type HrsThinkExecutionRow,
} from "../../runtime/hrsThinkExecutionStore";
import { persistHrsTurnOutcome } from "../../runtime/hrsTelemetry";
import {
  requireTgInferenceAttention,
  storeTgDeferredThinkFinalPackage,
} from "../../tg/inferenceRun";
import type { Env, OpenAIChatResponse } from "../../types";
import { sha256Hex } from "../../utils/hash";
import { readCompletedInferenceReplay,storeInferencePresentation } from "../inferenceIdempotency";
import { requireApprovalContinuationPins } from "./approvalCompatibility";
import {
  enqueueThinkCodeModeContinuation,
  persistThinkCodeModeContinuation,
  stableThinkCodeModeRef,
} from "./codeModeContinuation";
import { finishThinkCanaryObservation, parkThinkCanaryObservation } from "./observationTelemetry";
import type {
  OperiaThinkOrchestrationIdentity,
  OperiaThinkProductionInspection,
  OperiaThinkProductionPreparation,
  OperiaThinkProductionReservation,
  OperiaThinkProductionSubmission,
  OperiaThinkRunInput,
  OperiaThinkRunResult,
} from "./OperiaThinkHarness";
import {
  enqueueThinkApprovalContinuation as enqueueApprovalContinuation,
  persistThinkApprovalContinuations,
  thinkApprovalAuthorityScopeHash,
} from "./approvalContinuation";
import { persistThinkSdkActionProjections } from "./sdkActionProjection";
import {
  assertHrsAssistantCandidatePrerequisites,
  requireExactHrsAssistantCandidate,
  stageHrsAssistantCandidate,
} from "./assistantCandidate";

const INITIAL_INSPECTION_DELAY_SECONDS = 2;
const ACTIVE_INSPECTION_DELAY_SECONDS = 5;
const CONTINUATION_INSPECTION_DELAY_SECONDS = 15;

type InferenceIdentity = { requestHash: string; source: string };

type ProductionThinkRpc = {
  setName(name: string): Promise<void>;
  prepareProductionTurn(
    input: OperiaThinkRunInput,
    orchestration: OperiaThinkOrchestrationIdentity,
  ): Promise<OperiaThinkProductionPreparation>;
  inspectProductionReservation(input: { requestId: string }): Promise<OperiaThinkProductionReservation | null>;
  submitPreparedProductionTurn(input: {
    requestId: string;
    submissionId: string;
  }): Promise<OperiaThinkProductionSubmission>;
  inspectProductionTurn(input: {
    requestId: string;
    submissionId: string;
  }): Promise<OperiaThinkProductionInspection>;
  completeProductionTurn(input: { requestId: string; submissionId: string }): Promise<void>;
};

export type AdmitHrsThinkExecutionInput = {
  env: Env;
  thinkInstanceId: string;
  runInput: OperiaThinkRunInput;
  clientRequestHash: string;
  inferenceIdentity: InferenceIdentity;
  requestIdentity: string;
  tgBatchKey: string | null;
  sourceIdentity: string;
  toolSurfaceHash: string;
  conversationId: string | null;
  source: string;
  requestModel: string;
  upstreamModel: string;
  archiveIdempotencyKey: string | null;
  latestUserMessageId: string | null;
  turnOrderKey: number | null;
  provider: string;
};

export async function admitHrsThinkExecution(
  input: AdmitHrsThinkExecutionInput,
): Promise<{ row: HrsThinkExecutionRow; response: OpenAIChatResponse }> {
  assertDurableAdmissionBindings(input.env,input.requestIdentity);
  assertHrsAssistantCandidatePrerequisites(input.env,{
    conversation_id:input.conversationId,
    namespace:input.runInput.namespace ?? input.runInput.scope.ownerId,
    source:input.source,
    request_model:input.requestModel,
    upstream_model:input.upstreamModel,
    provider:input.provider,
    archive_idempotency_key:input.archiveIdempotencyKey,
    tg_batch_key:input.tgBatchKey,
    turn_order_key:input.turnOrderKey,
  });
  if (input.runInput.executionProfile === "answer_only") {
    throw new Error("hrs_think_answer_only_profile_forbidden");
  }
  const think = await productionThinkRpc(input.env,input.thinkInstanceId);
  const orchestration = orchestrationIdentity(input);
  // The DO owns the recoverable private input before D1 can authorize submit.
  // Prepare failures are never converted into a false HELD acknowledgement.
  const prepared = await think.prepareProductionTurn(input.runInput,orchestration);
  let row = (await createOrReadHrsThinkExecution(
    input.env.DB,executionIdentity(prepared,orchestration),
  )).row;
  if (isTerminalHrsThinkState(row.state)) {
    throw new HrsThinkExecutionConflictError("hrs_think_execution_already_terminal");
  }
  return acceptPreparedHrsThinkExecution(input.env,row,think);
}

export async function recoverHrsThinkReservation(input: {
  env: Env;
  thinkInstanceId: string;
  requestIdentity: string;
  clientRequestHash: string;
}): Promise<{ row: HrsThinkExecutionRow; response: OpenAIChatResponse } | null> {
  assertDurableAdmissionBindings(input.env,input.requestIdentity);
  const think = await productionThinkRpc(input.env,input.thinkInstanceId);
  const reservation = await think.inspectProductionReservation({ requestId:input.requestIdentity });
  if (!reservation) return null;
  const orchestration = reservation.orchestration;
  if (orchestration.thinkInstanceId !== input.thinkInstanceId
    || reservation.requestId !== input.requestIdentity
    || orchestration.clientRequestHash !== input.clientRequestHash) {
    throw new HrsThinkExecutionConflictError("hrs_think_reservation_identity_conflict");
  }
  assertHrsAssistantCandidatePrerequisites(input.env,{
    conversation_id:orchestration.conversationId,
    namespace:orchestration.namespace,
    source:orchestration.source,
    request_model:orchestration.requestModel,
    upstream_model:orchestration.upstreamModel,
    provider:orchestration.provider,
    archive_idempotency_key:orchestration.archiveIdempotencyKey,
    tg_batch_key:orchestration.tgBatchKey,
    turn_order_key:orchestration.turnOrderKey,
  });
  const row = (await createOrReadHrsThinkExecution(
    input.env.DB,executionIdentity(reservation,orchestration),
  )).row;
  if (isTerminalHrsThinkState(row.state)) return null;
  return acceptPreparedHrsThinkExecution(input.env,row,think);
}

async function acceptPreparedHrsThinkExecution(
  env: Env,
  initial: HrsThinkExecutionRow,
  think: ProductionThinkRpc,
): Promise<{ row: HrsThinkExecutionRow; response: OpenAIChatResponse }> {
  let row = initial;
  if (row.state === "prepared") {
    try {
      const submission = await think.submitPreparedProductionTurn({
        requestId:row.request_identity,
        submissionId:row.submission_id,
      });
      if (submission.status === "aborted" || submission.status === "skipped" || submission.status === "error") {
        await terminalizeAttention(env,row,`think_submission_${submission.status}`,think);
        throw new Error(`hrs_think_submission_${submission.status}`);
      }
      row = await transitionHrsThinkExecution({
        db:env.DB,current:row,from:["prepared"],to:"submitted",
        nextInspectionAt:futureIso(INITIAL_INSPECTION_DELAY_SECONDS),
      });
    } catch (error) {
      // A transport loss after submit is an unknown acknowledgement, not
      // permission to issue another identity. The prepared row and DO input
      // remain recoverable under the same submission/idempotency keys.
      if (isDeterministicSubmissionFailure(error)) throw error;
      await enqueueHrsThinkRecovery(env,row.execution_id,0,INITIAL_INSPECTION_DELAY_SECONDS)
        .catch(logWakeFailure("hrs_submit_unknown_recovery_wake"));
    }
  }

  const response = buildHrsHeldResponse({
    executionId:row.execution_id,
    submissionId:row.submission_id,
    requestModel:row.request_model,
    createdAt:row.created_at,
  });
  await storeInferencePresentation(env.DB,{
    idempotencyKey:row.request_identity,
    upstreamStatus:200,
    identity:inferenceIdentity(row),
    kind:"harness_held",
    responseJson:JSON.stringify(response),
  });
  if (row.state === "submitted") {
    row = await transitionHrsThinkExecution({
      db:env.DB,current:row,from:["submitted"],to:"held",
      nextInspectionAt:futureIso(INITIAL_INSPECTION_DELAY_SECONDS),
    });
  }
  if (row.state === "held") await persistHeldOutcomeBestEffort(env,row);
  await enqueueTgInferenceReady(env,row.request_identity).catch(logWakeFailure("hrs_held_ready_wake"));
  await enqueueHrsThinkRecovery(env,row.execution_id,0,INITIAL_INSPECTION_DELAY_SECONDS)
    .catch(logWakeFailure("hrs_initial_recovery_wake"));
  return { row,response };
}

export async function resumeHrsThinkExecution(
  env: Env,
  input: { executionId: string; attempt?: number },
): Promise<void> {
  const attempt = Math.max(0,Math.floor(input.attempt ?? 0));
  let row = await readHrsThinkExecution(env.DB,input.executionId);
  if (!row) return;
  if (isTerminalHrsThinkState(row.state)) {
    if (row.state === "completed") await ensureCompletedProjection(env,row);
    if (row.state === "attention_required") await ensureAttentionProjection(env,row);
    await ensureProductionCleanup(env,row);
    if (row.state === "completed") await ensureCompletedObservation(env,row);
    return;
  }

  if (row.state === "held" && row.terminal_status === "continuation_pending") {
    const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
    if (receipt.projection_result_hash === row.terminal_result_hash
      && receipt.projection_completed_at !== null && receipt.cleanup_completed_at !== null) {
      if (receipt.observation_completed_at === null) await ensurePendingObservation(env,row);
      return;
    }
  }

  const completedReplay = await readCompletedInferenceReplay(env.DB,row.request_identity,inferenceIdentity(row));
  if (completedReplay) {
    await terminalizeFromCompletedReplay(env,row,completedReplay);
    return;
  }

  const think = await productionThinkRpc(env,row.think_instance_id);
  try {
    if (row.state === "prepared") {
      const submission = await think.submitPreparedProductionTurn({
        requestId:row.request_identity,
        submissionId:row.submission_id,
      });
      if (submission.status === "aborted" || submission.status === "skipped" || submission.status === "error") {
        await terminalizeAttention(env,row,`think_submission_${submission.status}`,think);
        return;
      }
      row = await transitionHrsThinkExecution({
        db:env.DB,current:row,from:["prepared"],to:"submitted",
        nextInspectionAt:futureIso(INITIAL_INSPECTION_DELAY_SECONDS),
        recoveryAttempt:Math.max(row.recovery_attempt,attempt),
      });
    }

    const inspection = await think.inspectProductionTurn({
      requestId:row.request_identity,
      submissionId:row.submission_id,
    });
    if (inspection.state === "attention_required") {
      await terminalizeAttention(env,row,inspection.error,think);
      return;
    }
    if (inspection.state === "held") {
      const nextState = inspection.submissionStatus === "running" ? "running" : "held";
      row = await transitionHrsThinkExecution({
        db:env.DB,current:row,from:[row.state],to:nextState,
        nextInspectionAt:futureIso(ACTIVE_INSPECTION_DELAY_SECONDS),
        recoveryAttempt:Math.max(row.recovery_attempt,attempt),
      });
      await persistHeldOutcomeBestEffort(env,row);
      await enqueueHrsThinkRecovery(env,row.execution_id,attempt + 1,ACTIVE_INSPECTION_DELAY_SECONDS);
      return;
    }
    await projectProductionResult(env,row,inspection.result,think,attempt);
  } catch (error) {
    if (error instanceof HrsThinkExecutionConflictError) {
      const observed = await readHrsThinkExecution(env.DB,row.execution_id);
      if (observed && observed.revision > row.revision) {
        if (observed.state === "completed") await ensureCompletedProjection(env,observed);
        return;
      }
    }
    throw error;
  }
}

export async function enqueueDueHrsThinkExecutions(env: Env, limit = 25): Promise<number> {
  if (!env.MEMORY_QUEUE) return 0;
  const due = await listDueHrsThinkExecutions(env.DB,new Date().toISOString(),limit);
  for (const row of due) {
    await enqueueHrsThinkRecovery(env,row.execution_id,row.recovery_attempt,0);
  }
  return due.length;
}

async function projectProductionResult(
  env: Env,
  row: HrsThinkExecutionRow,
  result: OperiaThinkRunResult,
  think: ProductionThinkRpc,
  attempt: number,
): Promise<void> {
  if (result.status !== "completed" && result.status !== "parked") {
    await terminalizeAttention(env,row,`think_result_${boundedCode(result.status || result.error)}`,think);
    return;
  }
  if (result.pendingCodeMode || result.pendingApprovals.length > 0 || result.pendingSdkApprovals.length > 0) {
    await projectPendingContinuation(env,row,result,think,attempt);
    return;
  }
  let built: Awaited<ReturnType<typeof buildHrsFinalResponse>>;
  try {
    built = await buildHrsFinalResponse(row,result);
  } catch (error) {
    if (error instanceof Error && error.message === "hrs_think_completed_without_text") {
      await terminalizeAttention(env,row,error.message,think);
      return;
    }
    throw error;
  }
  const responseJson = JSON.stringify(built.response);
  // Candidate generation is the durable precondition for replay completion.
  // A crash after this write reuses and verifies the same deterministic row;
  // a staging failure leaves both execution and inference replay nonterminal.
  const savedAssistantId = await stageHrsAssistantCandidate(env,row,{
    content:built.filteredContent,
    finishReason:built.response.choices?.[0]?.finish_reason ?? null,
    usage:built.usage,
  });
  row = await completeHrsThinkExecutionForReplay(env.DB,{
    executionId:row.execution_id,requestIdentity:row.request_identity,responseJson,terminalStatus:"completed",
    modelCallCount:result.modelCalls,
    toolCallCount:result.toolCalls,
    directCallCount:result.directCalls,
    codeModeCallCount:result.codeModeCalls,
    recoveryAttempt:Math.max(row.recovery_attempt,attempt),
  });
  await ensureCompletedProjection(env,row,built.response);
  await ensureProductionCleanup(env,row,think);
  await observeCompletedResult(env,row,result,savedAssistantId,built.usage);
}

async function projectPendingContinuation(
  env: Env,
  row: HrsThinkExecutionRow,
  result: OperiaThinkRunResult,
  think: ProductionThinkRpc,
  attempt: number,
): Promise<void> {
  const authorityScopeHash = await thinkApprovalAuthorityScopeHash({
    ownerId:row.owner_id,chatId:row.chat_id,scopeKind:row.scope_kind,threadKey:row.thread_key,
  });
  let projectedSdkApprovals: unknown[] | undefined;
  let pendingCodeMode: Record<string,unknown> | null = null;
  if (result.pendingSdkApprovals.length > 0) {
    projectedSdkApprovals = await persistThinkSdkActionProjections({
      db:env.DB,requestId:row.request_identity,thinkInstanceId:row.think_instance_id,authorityScopeHash,
      pending:result.pendingSdkApprovals,inferenceRequestHash:row.inference_request_hash,
      inferenceSource:row.inference_source,conversationId:row.conversation_id,namespace:row.namespace,
      source:row.source,requestModel:row.request_model,upstreamModel:row.upstream_model,
      archiveIdempotencyKey:row.archive_idempotency_key,tgBatchKey:row.tg_batch_key,
      hrsExecutionId:row.execution_id,
    });
  }
  if (result.pendingApprovals.length > 0) {
    const pinned = result.pendingApprovals.map((approval) => ({ ...approval,...requireApprovalContinuationPins(approval) }));
    await persistThinkApprovalContinuations(env.DB,pinned.map((approval) => ({
      approvalRef:approval.approvalRef,requestId:row.request_identity,thinkInstanceId:row.think_instance_id,
      agentTaskId:approval.taskId,agentTicketId:approval.ticketId,thinkTaskId:approval.thinkTaskId,
      agentCallKey:approval.agentCallKey,toolKey:approval.toolKey,argsHash:approval.argsHash,
      schemaHash:approval.schemaHash,policyVersion:approval.policyVersion,pauseGeneration:approval.pauseGeneration,
      authorityScopeHash,inferenceRequestHash:row.inference_request_hash,inferenceSource:row.inference_source,
      conversationId:row.conversation_id,namespace:row.namespace,source:row.source,requestModel:row.request_model,
      upstreamModel:row.upstream_model,archiveIdempotencyKey:row.archive_idempotency_key,
      tgBatchKey:row.tg_batch_key,hrsExecutionId:row.execution_id,expiresAt:approval.expiresAt,
    })));
    for (const approval of pinned) {
      const delay = Math.max(1,Math.min(900,Math.ceil((Date.parse(approval.expiresAt)-Date.now())/1_000)));
      await enqueueApprovalContinuation(env,approval.approvalRef,0,delay);
    }
  }
  if (result.pendingCodeMode) {
    const ref = await stableThinkCodeModeRef(row.request_identity,result.pendingCodeMode.executionId);
    await persistThinkCodeModeContinuation(env.DB,{
      codemodeRef:ref,requestId:row.request_identity,agentRequestId:result.pendingCodeMode.requestId,
      thinkInstanceId:row.think_instance_id,agentExecutionId:result.pendingCodeMode.executionId,
      authorityScopeHash,inferenceRequestHash:row.inference_request_hash,inferenceSource:row.inference_source,
      conversationId:row.conversation_id,namespace:row.namespace,source:row.source,
      requestModel:row.request_model,upstreamModel:row.upstream_model,
      archiveIdempotencyKey:row.archive_idempotency_key,tgBatchKey:row.tg_batch_key,
      hrsExecutionId:row.execution_id,
      expiresAt:new Date(Date.now()+15*60_000).toISOString(),
    });
    await enqueueThinkCodeModeContinuation(env,ref);
    pendingCodeMode = { codemode_ref:ref,execution_id:result.pendingCodeMode.executionId,status:"pending_agent" };
  }
  const response = await buildHrsPendingResponse({ row,result,projectedSdkApprovals,pendingCodeMode });
  const responseHash = await sha256Hex(JSON.stringify(response));
  row = await transitionHrsThinkExecution({
    db:env.DB,current:row,from:[row.state],to:"held",
    nextInspectionAt:futureIso(CONTINUATION_INSPECTION_DELAY_SECONDS),
    terminalResultHash:responseHash,terminalStatus:"continuation_pending",
    modelCallCount:result.modelCalls,toolCallCount:result.toolCalls,directCallCount:result.directCalls,
    codeModeCallCount:result.codeModeCalls,recoveryAttempt:Math.max(row.recovery_attempt,attempt),
  });
  await markHrsThinkProjectionPending(env.DB,{ executionId:row.execution_id,resultHash:responseHash });
  if (row.tg_batch_key) await storeTgPackage(env,row,response,"harness_durable");
  if (row.tg_batch_key) await enqueueTgInferenceReady(env,row.request_identity);
  await markHrsThinkProjectionComplete(env.DB,{ executionId:row.execution_id,resultHash:responseHash });
  await ensureProductionCleanup(env,row,think);
  await observePendingResult(env,row,result);
}

async function terminalizeFromCompletedReplay(
  env: Env,
  row: HrsThinkExecutionRow,
  responseJson: string,
): Promise<void> {
  let response: OpenAIChatResponse;
  try { response = JSON.parse(responseJson) as OpenAIChatResponse; }
  catch { await terminalizeAttention(env,row,"hrs_completed_replay_invalid"); return; }
  const hash = await sha256Hex(responseJson);
  row = await transitionHrsThinkExecution({
    db:env.DB,current:row,from:[row.state],to:"completed",terminalResultHash:hash,
    terminalStatus:"completed_replay",recoveryAttempt:row.recovery_attempt+1,
  });
  await markHrsThinkProjectionPending(env.DB,{ executionId:row.execution_id,resultHash:hash });
  await ensureCompletedProjection(env,row,response);
  await ensureProductionCleanup(env,row);
  await persistTerminalOutcomeBestEffort(env,row,"completed",null);
}

async function ensureCompletedProjection(
  env: Env,
  row: HrsThinkExecutionRow,
  response?: OpenAIChatResponse,
): Promise<void> {
  const encoded = response
    ? JSON.stringify(response)
    : await readCompletedInferenceReplay(env.DB,row.request_identity,inferenceIdentity(row));
  if (!encoded) throw new Error("hrs_completed_replay_missing");
  const parsed = response ?? JSON.parse(encoded) as OpenAIChatResponse;
  const resultHash = await sha256Hex(encoded);
  const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
  if (receipt.projection_result_hash === resultHash && receipt.projection_completed_at !== null) return;
  if (receipt.projection_result_hash !== resultHash) {
    await markHrsThinkProjectionPending(env.DB,{ executionId:row.execution_id,resultHash });
  }
  if (row.tg_batch_key) {
    await storeTgPackage(env,row,parsed,projectionPhase(parsed));
  }
  await enqueueCompletedProjectionWakes(env,row);
  await markHrsThinkProjectionComplete(env.DB,{ executionId:row.execution_id,resultHash });
}

async function enqueueCompletedProjectionWakes(env: Env,row: HrsThinkExecutionRow): Promise<void> {
  await enqueueTgInferenceReady(env,row.request_identity);
}

async function ensureProductionCleanup(
  env: Env,
  row: HrsThinkExecutionRow,
  think?: ProductionThinkRpc,
): Promise<void> {
  const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
  if (receipt.cleanup_completed_at !== null) return;
  const rpc = think ?? await productionThinkRpc(env,row.think_instance_id);
  await rpc.completeProductionTurn({ requestId:row.request_identity,submissionId:row.submission_id });
  await markHrsThinkCleanupComplete(env.DB,row.execution_id);
}

async function ensureAttentionProjection(env: Env,row: HrsThinkExecutionRow): Promise<void> {
  const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
  if (receipt.attention_completed_at !== null) return;
  if (row.tg_batch_key) {
    await requireTgInferenceAttention(env.DB,row.tg_batch_key,"harness_durable",row.error_code ?? "unknown");
  }
  await markHrsThinkAttentionComplete(env.DB,row.execution_id);
}

async function ensureCompletedObservation(env: Env,row: HrsThinkExecutionRow): Promise<void> {
  const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
  if (receipt.observation_completed_at !== null) return;
  const think = await productionThinkRpc(env,row.think_instance_id);
  const inspection = await think.inspectProductionTurn({
    requestId:row.request_identity,submissionId:row.submission_id,
  });
  if (inspection.state !== "result_ready") throw new Error("hrs_think_terminal_observation_result_missing");
  if (inspection.result.pendingApprovals.length > 0 || inspection.result.pendingSdkApprovals.length > 0
    || inspection.result.pendingCodeMode) {
    await observePendingResult(env,row,inspection.result);
    return;
  }
  const built = await buildHrsFinalResponse(row,inspection.result);
  const savedAssistantId = await requireExactHrsAssistantCandidate(env,row,{
    content:built.filteredContent,
    finishReason:built.response.choices?.[0]?.finish_reason ?? null,
    usage:built.usage,
  },{ allowResolvedPublication:true });
  await observeCompletedResult(env,row,inspection.result,savedAssistantId,built.usage);
}

async function ensurePendingObservation(env: Env,row: HrsThinkExecutionRow): Promise<void> {
  const receipt = await readHrsThinkExecutionReceipt(env.DB,row.execution_id);
  if (receipt.observation_completed_at !== null) return;
  const think = await productionThinkRpc(env,row.think_instance_id);
  const inspection = await think.inspectProductionTurn({
    requestId:row.request_identity,submissionId:row.submission_id,
  });
  if (inspection.state !== "result_ready") throw new Error("hrs_think_pending_observation_result_missing");
  if (inspection.result.pendingApprovals.length === 0 && inspection.result.pendingSdkApprovals.length === 0
    && !inspection.result.pendingCodeMode) {
    throw new Error("hrs_think_pending_observation_identity_conflict");
  }
  await observePendingResult(env,row,inspection.result);
}

async function observePendingResult(
  env: Env,
  row: HrsThinkExecutionRow,
  result: OperiaThinkRunResult,
): Promise<void> {
  const latencyMs = elapsedMs(row.created_at);
  if (result.status === "parked") {
    await parkThinkCanaryObservation(env,{ requestId:row.request_identity,result,latencyMs });
  } else {
    await finishThinkCanaryObservation(env,{ requestId:row.request_identity,result,latencyMs,
      qualifyingContext:{naturalSource:true,replay:false,continuation:false,synthetic:false} });
  }
  await markHrsThinkObservationComplete(env.DB,row.execution_id);
}

async function storeTgPackage(
  env: Env,
  row: HrsThinkExecutionRow,
  response: OpenAIChatResponse,
  phase: "think_approval_continuation" | "think_codemode_continuation" | "think_sdk_action" | "harness_durable",
): Promise<void> {
  if (!row.tg_batch_key) return;
  const tg = await env.DB.prepare("SELECT reply_to_message_id FROM tg_chat_inference_runs WHERE batch_key=?")
    .bind(row.tg_batch_key).first<{ reply_to_message_id:number|null }>();
  const marker = response.operia_think && typeof response.operia_think === "object"
    && !Array.isArray(response.operia_think) ? response.operia_think as Record<string,unknown> : {};
  const responseJson = JSON.stringify(response);
  const responseHash = await sha256Hex(responseJson);
  if (marker.harness_pending_projection === true) {
    if (row.state !== "held" || row.terminal_status !== "continuation_pending"
      || row.terminal_result_hash !== responseHash) {
      throw new HrsThinkExecutionConflictError("hrs_think_pending_projection_authority_conflict");
    }
  } else {
    if (row.state !== "completed" || row.terminal_result_hash !== responseHash) {
      throw new HrsThinkExecutionConflictError("hrs_think_final_projection_authority_conflict");
    }
    const replay = await env.DB.prepare(`SELECT status,response_json FROM inference_idempotency
      WHERE idempotency_key=? AND request_hash=? AND source=?`).bind(
      row.request_identity,row.inference_request_hash,row.inference_source,
    ).first<{status:string;response_json:string|null}>();
    if (!replay || replay.status !== "completed" || replay.response_json !== responseJson) {
      throw new HrsThinkExecutionConflictError("hrs_think_final_projection_replay_conflict");
    }
  }
  await storeTgDeferredThinkFinalPackage(env.DB,row.tg_batch_key,{
    response,mediaIntents:[],toolTraces:[],replyToMessageId:tg?.reply_to_message_id ?? null,
    resultCapsules:Array.isArray(marker.result_capsules) ? marker.result_capsules : [],
  },phase,{
    idempotencyKey:row.request_identity,requestHash:row.inference_request_hash,source:row.inference_source,
  });
}

async function terminalizeAttention(
  env: Env,
  row: HrsThinkExecutionRow,
  error: string,
  think?: ProductionThinkRpc,
): Promise<void> {
  const code = boundedCode(error);
  row = await requireHrsThinkExecutionAttention(env.DB,{
    executionId:row.execution_id,requestIdentity:row.request_identity,errorCode:code,
    recoveryAttempt:row.recovery_attempt+1,
  });
  await ensureAttentionProjection(env,row);
  await ensureProductionCleanup(env,row,think);
  await persistTerminalOutcomeBestEffort(env,row,"attention_required",code);
}

async function observeCompletedResult(
  env: Env,
  row: HrsThinkExecutionRow,
  result: OperiaThinkRunResult,
  savedAssistantId: string | null,
  usage: OpenAIChatResponse["usage"],
): Promise<void> {
  await Promise.all([
    finishThinkCanaryObservation(env,{
      requestId:row.request_identity,result,latencyMs:elapsedMs(row.created_at),
      qualifyingContext:{naturalSource:true,replay:false,continuation:false,synthetic:false},
    }),
    saveUsageLog(env.DB,{
      messageId:savedAssistantId,namespace:row.namespace,provider:row.provider,model:row.upstream_model,usage,
      cacheMode:"think-0.15-durable-submission-usage-v2",cacheTtl:getAnthropicCacheTtlMode(env),
      requestKind:"assistant_message:think_durable_submission",correlationId:row.tg_batch_key,
      totalMs:elapsedMs(row.created_at),
      idempotencyKey:`usage:hrs:${row.execution_id}`,
    }),
  ]);
  await persistTerminalOutcomeBestEffort(env,row,"completed",null);
  await markHrsThinkObservationComplete(env.DB,row.execution_id);
  await Promise.all([
    row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true"
      ? row.conversation_id && savedAssistantId
        ? enqueueMemoryMaintenanceIfNeeded(env,{
          namespace:row.namespace,conversationId:row.conversation_id,
          fromMessageId:row.latest_user_message_id ?? undefined,toMessageId:savedAssistantId,source:row.source,
        })
        : Promise.resolve()
      : Promise.resolve(),
    row.source !== "telegram" || env.MEMORY_PUBLICATION_STATE_V2_ENABLED !== "true"
      ? enqueueRetentionIfNeeded(env,row.namespace) : Promise.resolve(),
  ]).catch(logWakeFailure("hrs_think_post_observation_maintenance"));
}

async function persistHeldOutcomeBestEffort(env: Env, row: HrsThinkExecutionRow): Promise<void> {
  await persistHrsTurnOutcome({
    db:env.DB,requestId:row.request_identity,revision:1,status:"held",modelCallCount:0,
    toolCallCount:0,directCallCount:0,recoveryReason:"durable_submission_accepted",
  }).catch(logWakeFailure("hrs_held_outcome_telemetry"));
}

async function persistTerminalOutcomeBestEffort(
  env: Env,
  row: HrsThinkExecutionRow,
  status: "completed" | "attention_required",
  recoveryReason: string | null,
): Promise<void> {
  await persistHrsTurnOutcome({
    db:env.DB,requestId:row.request_identity,revision:2,status,
    modelCallCount:row.model_call_count,toolCallCount:row.tool_call_count,directCallCount:row.direct_call_count,
    modelTotalMs:elapsedMs(row.created_at),recoveryReason,
  }).catch(logWakeFailure("hrs_terminal_outcome_telemetry"));
}

async function productionThinkRpc(env: Env, name: string): Promise<ProductionThinkRpc> {
  if (!env.OPERIA_THINK) throw new Error("hrs_think_namespace_missing");
  const rpc = env.OPERIA_THINK.get(env.OPERIA_THINK.idFromName(name)) as unknown as ProductionThinkRpc;
  await rpc.setName(name);
  return rpc;
}

function assertDurableAdmissionBindings(env: Env, requestIdentity: string): void {
  if (env.TG_MEMORY_OUTCOME_V2_ENABLED !== "true") throw new Error("hrs_think_inference_presentation_required");
  if (!env.MEMORY_QUEUE) throw new Error("hrs_think_recovery_queue_required");
  if (/^tg:[a-f0-9]{64}$/.test(requestIdentity) && !env.TG_QUEUE) {
    throw new Error("hrs_think_tg_ready_queue_required");
  }
  if (!env.OPERIA_THINK) throw new Error("hrs_think_namespace_missing");
}

function orchestrationIdentity(input: AdmitHrsThinkExecutionInput): OperiaThinkOrchestrationIdentity {
  if (input.runInput.executionProfile === "answer_only") {
    throw new Error("hrs_think_answer_only_profile_forbidden");
  }
  return {
    clientRequestHash:input.clientRequestHash,
    inferenceRequestHash:input.inferenceIdentity.requestHash,
    inferenceSource:input.inferenceIdentity.source,
    tgBatchKey:input.tgBatchKey,
    sourceIdentity:input.sourceIdentity,
    thinkInstanceId:input.thinkInstanceId,
    toolSurfaceHash:input.toolSurfaceHash,
    ownerId:input.runInput.scope.ownerId,
    chatId:input.runInput.scope.chatId,
    scopeKind:input.runInput.scope.scopeKind,
    threadKey:input.runInput.scope.threadKey,
    namespace:input.runInput.namespace ?? input.runInput.scope.ownerId,
    conversationId:input.conversationId,
    source:input.source,
    requestModel:input.requestModel,
    upstreamModel:input.upstreamModel,
    archiveIdempotencyKey:input.archiveIdempotencyKey,
    latestUserMessageId:input.latestUserMessageId,
    turnOrderKey:input.turnOrderKey,
    provider:input.provider,
    executionProfile:input.runInput.executionProfile,
  };
}

function executionIdentity(
  prepared: OperiaThinkProductionPreparation,
  orchestration: OperiaThinkOrchestrationIdentity,
): HrsThinkExecutionIdentity {
  return {
    requestIdentity:prepared.requestId,
    clientRequestHash:orchestration.clientRequestHash,
    inferenceRequestHash:orchestration.inferenceRequestHash,
    inferenceSource:orchestration.inferenceSource,
    tgBatchKey:orchestration.tgBatchKey,
    sourceIdentity:orchestration.sourceIdentity,
    ownerId:orchestration.ownerId,
    chatId:orchestration.chatId,
    scopeKind:orchestration.scopeKind,
    threadKey:orchestration.threadKey,
    thinkInstanceId:orchestration.thinkInstanceId,
    submissionId:prepared.submissionId,
    submissionIdempotencyKey:prepared.idempotencyKey,
    inputHash:prepared.inputHash,
    executionProfile:orchestration.executionProfile,
    toolSurfaceHash:orchestration.toolSurfaceHash,
    namespace:orchestration.namespace,
    conversationId:orchestration.conversationId,
    source:orchestration.source,
    requestModel:orchestration.requestModel,
    upstreamModel:orchestration.upstreamModel,
    archiveIdempotencyKey:orchestration.archiveIdempotencyKey,
    latestUserMessageId:orchestration.latestUserMessageId,
    turnOrderKey:orchestration.turnOrderKey,
    provider:orchestration.provider,
  };
}

function inferenceIdentity(row: HrsThinkExecutionRow): InferenceIdentity {
  return { requestHash:row.inference_request_hash,source:row.inference_source };
}

function projectionPhase(response: OpenAIChatResponse):
  "think_approval_continuation" | "think_codemode_continuation" | "think_sdk_action" | "harness_durable" {
  const marker = response.operia_think && typeof response.operia_think === "object"
    && !Array.isArray(response.operia_think) ? response.operia_think as Record<string,unknown> : {};
  if (marker.sdk_action_continuation === true || marker.sdk_action_status != null) return "think_sdk_action";
  if (marker.codemode_continuation === true || marker.codemode_terminal === true) return "think_codemode_continuation";
  if (marker.approval_continuation === true || marker.approval_terminal === true) return "think_approval_continuation";
  return "harness_durable";
}

function futureIso(seconds: number): string {
  return new Date(Date.now()+Math.max(1,Math.floor(seconds))*1_000).toISOString();
}

function elapsedMs(createdAt: string): number {
  const started = Date.parse(createdAt);
  return Number.isFinite(started) ? Math.max(0,Date.now()-started) : 0;
}

function boundedCode(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[^a-zA-Z0-9:_-]/g,"_").slice(0,180) || "unknown";
}

function isDeterministicSubmissionFailure(error: unknown): boolean {
  const code = boundedCode(error);
  return code.startsWith("hrs_think_submission_")
    || code.includes("identity_conflict")
    || code.includes("submission_mismatch")
    || code.includes("input_conflict");
}

function logWakeFailure(scope: string): (error: unknown) => void {
  return (error) => console.error(scope,{ code:boundedCode(error) });
}
