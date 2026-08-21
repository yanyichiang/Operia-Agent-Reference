import type { D1ConversationImportDerivationLedger } from "./derivationLedger";
import { deleteMockImportVector, ensureMockImportVector } from "./derivation";
import type { ImportVectorStore, LocalDerivationActionExecutor } from "./derivationTypes";
import { canonicalJson } from "./hashes";

function boundedErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "derivation_action_failed";
  const normalized = raw.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 80);
  return normalized || "derivation_action_failed";
}

function leaseExpiry(now: string): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_lease_timestamp");
  return new Date(timestamp + 5 * 60_000).toISOString();
}

export async function runLocalDerivationStep(input: {
  runId: string;
  batchId: string;
  ledger: D1ConversationImportDerivationLedger;
  executor: LocalDerivationActionExecutor;
  now: string;
}): Promise<{ status: "advanced" | "partial" | "attention" | "ready"; cursor: number | null }> {
  const item = await input.ledger.getNextImpactItem(input.runId);
  if (!item) {
    if (!await input.ledger.finalizeRunIfComplete(input.runId, input.now)) throw new Error("derivation_run_not_complete");
    return { status: "ready", cursor: null };
  }
  if (item.status === "attention") return { status: "attention", cursor: item.sourceOrder };
  const actionKey = item.actionKey;
  const executionLeaseId = `impact:${actionKey}`;
  const lease = await input.ledger.claimImpactExecution({
    runId: input.runId,
    expectedCursor: item.sourceOrder,
    expectedGeneration: item.generation,
    actionKey,
    executionLeaseId,
    now: input.now,
    leaseExpiresAt: leaseExpiry(input.now),
  });
  if (lease === "busy" || lease === "attention") {
    return { status: "attention", cursor: item.sourceOrder };
  }
  const reconcile = async (): Promise<"not_started" | "completed" | "unknown"> => {
    try {
      return await input.executor.inspect(item);
    } catch {
      return "unknown";
    }
  };
  const finishCompleted = async () => {
    try {
      return { status: "advanced" as const, cursor: await input.ledger.completeImpactItem({
        runId: input.runId, expectedCursor: item.sourceOrder, expectedGeneration: item.generation,
        actionKey, executionLeaseId, now: input.now,
      }) };
    } catch {
      let progress: Awaited<ReturnType<D1ConversationImportDerivationLedger["inspectImpactProgress"]>>;
      try {
        progress = await input.ledger.inspectImpactProgress(input.runId, item.sourceOrder);
      } catch {
        await input.ledger.recordAttention({ batchId: input.batchId, action: "derivation_d1_inspect_unknown",
          counts: { cursor: item.sourceOrder, ref_kind: item.refKind }, now: input.now }).catch(() => undefined);
        return { status: "attention" as const, cursor: item.sourceOrder };
      }
      if (progress.itemStatus === "ready" && progress.cursor > item.sourceOrder) {
        return { status: "advanced" as const, cursor: progress.cursor };
      }
      if (progress.itemStatus === "started" && progress.actionKey === actionKey
        && progress.executionLeaseId === executionLeaseId && await reconcile() === "completed") {
        try {
          return { status: "advanced" as const, cursor: await input.ledger.completeImpactItem({
            runId: input.runId, expectedCursor: item.sourceOrder, expectedGeneration: progress.generation,
            actionKey, executionLeaseId, now: input.now,
          }) };
        } catch {
          const retried = await input.ledger.inspectImpactProgress(input.runId, item.sourceOrder);
          if (retried.itemStatus === "ready" && retried.cursor > item.sourceOrder) {
            return { status: "advanced" as const, cursor: retried.cursor };
          }
        }
      }
      return freezeUnknown("d1_outcome_unknown");
    }
  };
  const freezeUnknown = async (errorCode: string) => {
    const marked = await input.ledger.markImpactAttention({
      runId: input.runId,
      expectedCursor: item.sourceOrder,
      expectedGeneration: item.generation,
      actionKey,
      executionLeaseId,
      errorCode,
      now: input.now,
    });
    if (!marked) throw new Error("derivation_attention_conflict");
    await input.ledger.recordAttention({
      batchId: input.batchId,
      action: "derivation_action_unknown",
      counts: { cursor: item.sourceOrder, ref_kind: item.refKind },
      now: input.now,
    });
    return { status: "attention" as const, cursor: item.sourceOrder };
  };
  const before = await reconcile();
  if (before === "completed") return await finishCompleted();
  if (before === "unknown") return freezeUnknown("action_inspect_unknown");
  try {
    await input.executor.apply(item);
    const after = await reconcile();
    if (after === "completed") return await finishCompleted();
    if (after === "unknown") return freezeUnknown("action_outcome_unknown");
    throw new Error("action_not_completed");
  } catch (error) {
    const afterError = await reconcile();
    if (afterError === "completed") return await finishCompleted();
    if (afterError === "unknown") return freezeUnknown("action_outcome_unknown");
    const errorCode = boundedErrorCode(error);
    const marked = await input.ledger.markImpactRetry({
      runId: input.runId,
      expectedCursor: item.sourceOrder,
      expectedGeneration: item.generation,
      actionKey,
      executionLeaseId,
      errorCode,
      now: input.now,
    });
    if (!marked) throw error;
    await input.ledger.recordAttention({
      batchId: input.batchId,
      action: "derivation_action_retry",
      counts: { cursor: item.sourceOrder, generation: item.generation, ref_kind: item.refKind },
      now: input.now,
    });
    return { status: "partial", cursor: item.sourceOrder };
  }
}

export async function runLocalEmbeddingStep(input: {
  intentId: string;
  ledger: D1ConversationImportDerivationLedger;
  store: ImportVectorStore;
  vector?: number[];
  now: string;
}): Promise<"ready" | "deleted" | "retry" | "attention"> {
  const intent = await input.ledger.getEmbeddingIntent(input.intentId);
  if (intent.status === "ready" || intent.status === "deleted" || intent.status === "attention") return intent.status;
  const executionLeaseId = `embedding:${input.intentId}`;
  const lease = await input.ledger.claimEmbeddingExecution({
    id: input.intentId,
    expectedGeneration: intent.generation,
    executionLeaseId,
    now: input.now,
    leaseExpiresAt: leaseExpiry(input.now),
  });
  if (lease === "busy" || lease === "attention") return "attention";
  if (lease === "terminal") {
    const terminal = await input.ledger.getEmbeddingIntent(input.intentId);
    return terminal.status === "ready" || terminal.status === "deleted" || terminal.status === "attention"
      ? terminal.status : "attention";
  }
  try {
    if (intent.operation === "write") {
      if (!input.vector) throw new Error("embedding_vector_missing");
      await ensureMockImportVector(input.store, intent.manifest, input.vector);
      if (!await input.ledger.markEmbeddingReady({ id: input.intentId, expectedGeneration: intent.generation,
        executionLeaseId, status: "ready", now: input.now })) {
        throw new Error("embedding_d1_outcome_unknown");
      }
      return "ready";
    }
    await deleteMockImportVector(input.store, intent.manifest);
    if (!await input.ledger.markEmbeddingReady({ id: input.intentId, expectedGeneration: intent.generation,
      executionLeaseId, status: "deleted", now: input.now })) {
      throw new Error("embedding_d1_outcome_unknown");
    }
    return "deleted";
  } catch (error) {
    const code = boundedErrorCode(error);
    const inspection = await input.store.inspect(intent.manifest.vectorId).catch(() => ({ status: "unknown" as const }));
    const completed = intent.operation === "write"
      ? inspection.status === "matched" && canonicalJson(inspection.manifest) === canonicalJson(intent.manifest)
      : inspection.status === "missing";
    if (completed) {
      const terminal = intent.operation === "write" ? "ready" : "deleted";
      const refreshed = await input.ledger.getEmbeddingIntent(input.intentId);
      if (refreshed.status === terminal) return terminal;
      if (await input.ledger.markEmbeddingReady({ id: input.intentId, expectedGeneration: intent.generation,
        executionLeaseId, status: terminal, now: input.now })) {
        return terminal;
      }
    }
    const manifestMismatch = inspection.status === "matched"
      && canonicalJson(inspection.manifest) !== canonicalJson(intent.manifest);
    if (inspection.status === "unknown" || inspection.status === "mismatch" || manifestMismatch || code.includes("outcome_unknown")) {
      await input.ledger.markEmbeddingAttention({ id: input.intentId, expectedGeneration: intent.generation,
        executionLeaseId, errorCode: code, now: input.now });
      await input.ledger.recordAttention({ batchId: intent.batchId, action: "embedding_reconcile_attention",
        counts: { operation: intent.operation, ref_kind: intent.manifest.refKind }, now: input.now });
      return "attention";
    }
    await input.ledger.markEmbeddingRetry({ id: input.intentId, expectedGeneration: intent.generation,
      executionLeaseId, errorCode: code, now: input.now });
    return "retry";
  }
}
