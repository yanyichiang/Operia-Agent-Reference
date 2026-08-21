import { runMemoryRetention } from "../memory/retention";
import { archiveTgAgentRoomInference, processTgChat, resumeTgAgentContinuations, resumeTgInferenceDelivery, resumeTgInferenceReady, resumeTgInferenceRun, resumeTgInferenceWatchdog } from "../tg/process";
import { waitForAgentTask } from "../tg/agentClient";
import type { Env, QueueMessage } from "../types";
import { runMemoryMaintenance } from "../memory/maintenance";
import { runRoomSummary } from "../tg/roomSharedState";
import { resumeThinkApprovalContinuation } from "../memory/think/approvalContinuationRunner";
import { resumeThinkCodeModeContinuation } from "../memory/think/codeModeContinuationRunner";
import { projectThinkSdkActionState } from "../memory/think/sdkActionFinalProjector";
import { handleTgDraftPreview } from "../tg/draftPreview";
import { foldConversationStateAtRevision } from "../memory/conversationState";
import { handleTgParagraphStream } from "../tg/paragraphStream";
import { runThinkSdkActionDecision } from "../memory/think/sdkActionDecisionRunner";
import { indexPendingEpisodic } from "../memory/episodic";
import { findPendingDreamBackfillDate, runDailyMemoryDigest } from "../memory/dailyDigest";
import {
  finalizeLegacyVNextBackfillRun,
  runCandidateJudge,
  runLegacyVNextBackfillBatch,
} from "../memory/candidateJudge";
import { runNightReviewQueueStep } from "../memory/vnext/nightReviewRuntime";
import { consumeTgInferencePublicationOrLegacy } from "../tg/publicationConsumerAdapter";
import { consumePublicationConversation } from "../tg/conversationClient";
import { enqueuePublicationMemoryFollowups } from "./producer";
import { resumeHrsThinkExecution } from "../memory/think/durableProductionRunner";

function readJudgeBatchSize(env: Env, remaining: number): number {
  const value = Number(env.JUDGE_BATCH_SIZE || 5);
  const configured = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 20) : 5;
  return Math.min(configured, Math.max(remaining, 1));
}

export async function handleQueueMessage(message: QueueMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
  switch (message.type) {
    case "memory_maintenance":
      await runMemoryMaintenance(env, message);
      return;
    case "episodic_index":
      await indexPendingEpisodic(env, { namespace: message.namespace, limit: 20, includeFailed: message.includeFailed });
      return;
    case "dream_digest": {
      const result = await runDailyMemoryDigest(env, message.namespace, {
        dateLabel: message.dateLabel,
        trigger: "cron",
      });
      const remainingRuns = Math.max(Math.floor(message.remainingRuns) - 1, 0);
      if (!env.MEMORY_QUEUE || remainingRuns === 0) return;

      if (result.ran && result.stats.hasMore) {
        await env.MEMORY_QUEUE.send({
          type: "dream_digest",
          namespace: message.namespace,
          remainingRuns,
          dateLabel: result.stats.date,
        }, { delaySeconds: 1 });
        return;
      }

      if (!result.ran && !["already_done", "no_messages"].includes(result.reason)) return;
      const backfillDate = await findPendingDreamBackfillDate(env, message.namespace, { lookback: 3 });
      if (backfillDate) {
        await env.MEMORY_QUEUE.send({
          type: "dream_digest",
          namespace: message.namespace,
          remainingRuns,
          dateLabel: backfillDate,
        }, { delaySeconds: 1 });
      }
      return;
    }
    case "candidate_judge": {
      const remainingCandidates = Math.max(Math.floor(message.remainingCandidates), 1);
      const result = await runCandidateJudge(env, message.namespace, {
        limit: readJudgeBatchSize(env, remainingCandidates),
      });
      const nextBudget = remainingCandidates - result.processed;
      if (
        env.MEMORY_QUEUE
        && result.ran
        && result.processed > 0
        && result.remaining_unreviewed > 0
        && nextBudget > 0
      ) {
        await env.MEMORY_QUEUE.send({
          type: "candidate_judge",
          namespace: message.namespace,
          remainingCandidates: nextBudget,
        }, { delaySeconds: 1 });
      }
      return;
    }
    case "legacy_vnext_backfill": {
      const remainingCandidates = Math.max(Math.floor(message.remainingCandidates),1);
      const result = await runLegacyVNextBackfillBatch(env,{
        runId: message.runId,
        namespace: message.namespace,
        limit: readJudgeBatchSize(env,remainingCandidates),
      });
      const nextBudget = remainingCandidates - result.processed;
      if (env.MEMORY_QUEUE && result.remaining > 0 && result.processed > 0 && nextBudget > 0) {
        await env.MEMORY_QUEUE.send({
          type: "legacy_vnext_backfill",
          namespace: message.namespace,
          runId: message.runId,
          remainingCandidates: nextBudget,
        },{ delaySeconds: 1 });
        return;
      }
      await finalizeLegacyVNextBackfillRun(env.DB,{
        runId: message.runId,
        status: result.remaining === 0 ? "completed" : "budget_exhausted",
      });
      return;
    }
    case "memory_night_review": {
      const result = await runNightReviewQueueStep({ env,message });
      if (result.requeue) {
        if (!env.MEMORY_QUEUE) throw new Error("memory_night_review_queue_binding_missing");
        await env.MEMORY_QUEUE.send(result.requeue,{ delaySeconds: 1 });
      }
      return;
    }
    case "retention":
      await runMemoryRetention(env, message.namespace);
      return;
    case "tg_process":
      await processTgChat(env, message.chatId, ctx);
      return;
    case "tg_inference_resume":
      if (!ctx) throw new Error("tg_inference_resume_context_missing");
      // The durable run handles and checkpoints its own failures. Returning
      // normally prevents Cloudflare Queue retries from creating a second,
      // unbounded paid retry loop.
      await resumeTgInferenceRun(env, message.batchKey, ctx);
      return;
    case "tg_inference_ready":
      if (!ctx) throw new Error("tg_inference_ready_context_missing");
      await resumeTgInferenceReady(env, message.idempotencyKey, ctx);
      return;
    case "tg_inference_watchdog":
      if (!ctx) throw new Error("tg_inference_watchdog_context_missing");
      await resumeTgInferenceWatchdog(env, message.batchKey, message.probe, ctx);
      return;
    case "tg_inference_delivery":
      await resumeTgInferenceDelivery(env, message, ctx);
      return;
    case "tg_draft_preview":
      // The handler absorbs all Telegram failures: ephemeral previews are
      // at-most-once and must never enter the Queue retry loop.
      await handleTgDraftPreview(env,message);
      return;
    case "tg_conversation_append":
      if (await archiveTgAgentRoomInference(env,message.batchKey)) return;
      await consumeTgInferencePublicationOrLegacy(
        env,message.batchKey,
        {consumeConversation:consumePublicationConversation,
          enqueueMemoryFollowups:enqueuePublicationMemoryFollowups},
      );
      return;
    case "conversation_fold":
      if (env.WORKER_ROLE !== "memory") throw new Error("conversation_fold_memory_worker_required");
      await foldConversationStateAtRevision(env, message.recipientId, message.expectedRevision);
      return;
    case "tg_paragraph_stream": {
      if (env.WORKER_ROLE !== "tgbot" || env.TG_PARAGRAPH_STREAM_ENABLED !== "true") {
        throw new Error("tg_paragraph_stream_not_enabled");
      }
      const result = await handleTgParagraphStream(env, message);
      if (result.kind === "waiting") throw new Error("tg_paragraph_stream_waiting");
      return;
    }
    case "tg_room_summary":
      await runRoomSummary(env, message);
      return;
    case "think_approval_resume":
      await resumeThinkApprovalContinuation(env, message, ctx);
      return;
    case "think_codemode_resume":
      await resumeThinkCodeModeContinuation(env, message, ctx);
      return;
    case "think_sdk_action_state":
      await projectThinkSdkActionState(env, message.requestId, message.attempt);
      return;
    case "think_sdk_action_decision":
      await runThinkSdkActionDecision(env, message);
      return;
    case "hrs_think_recover":
      await resumeHrsThinkExecution(env, message);
      return;
    case "tg_agent_resume": {
      if (!ctx) throw new Error("tg_agent_resume_context_missing");
      const result = await waitForAgentTask(env, message.taskId);
      await resumeTgAgentContinuations(env, ctx);
      if (result.status === "pending" && message.attempt < 5 && env.MEMORY_QUEUE) {
        await env.MEMORY_QUEUE.send(
          { type: "tg_agent_resume", taskId: message.taskId, attempt: message.attempt + 1 },
          { delaySeconds: 5 },
        );
      }
      return;
    }
  }
}
