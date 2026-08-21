import { buildSummaryProjection, previewDerivationDelete, validateCandidateExtraction } from "./derivation";
import { canonicalJson, domainSeparatedHash, sha256Hex } from "./hashes";
import type {
  CandidateExtractionResult,
  DerivationDeletePreview,
  DerivationImpactInput,
  DurableDerivationImpactItem,
  ImportVectorManifest,
  SummaryBounds,
  ValidatedCandidateExtraction,
} from "./derivationTypes";

function changes(result: D1Result | undefined): number {
  return Number((result?.meta as { changes?: number } | undefined)?.changes || 0);
}

export async function deriveReviewMemoryId(input: {
  namespace: string; candidateId: string; candidateRevision: number; decisionKeyHash: string;
}): Promise<string> {
  return `mem_ci_${(await domainSeparatedHash("operia/conversation-import/review-memory/v1", [
    input.namespace, input.candidateId, input.candidateRevision, input.decisionKeyHash,
  ])).slice(0, 32)}`;
}

export async function deriveReviewDecisionId(input: {
  namespace: string; candidateId: string; candidateRevision: number; decisionKeyHash: string;
}): Promise<string> {
  return `cird_${(await domainSeparatedHash("operia/conversation-import/review-decision/v1", [
    input.namespace, input.candidateId, input.candidateRevision, input.decisionKeyHash,
  ])).slice(0, 32)}`;
}

export class ConversationImportDerivationConflictError extends Error {
  constructor(readonly code: "batch_not_derivable" | "derivation_conflict" | "decision_conflict" | "cursor_conflict" | "terminal_state_conflict") {
    super(code);
  }
}

export interface ReadySummaryInput {
  id: string;
  namespace: string;
  batchId: string;
  conversationId: string;
  summaryText: string;
  bounds: SummaryBounds;
  summarizerModel: string;
  promptPolicyVersion: string;
  summarizerVersion: string;
  supersedesSummaryId?: string | null;
  now: string;
}

export interface CandidateDerivationInput {
  id: string;
  namespace: string;
  batchId: string;
  summaryId: string;
  extraction: CandidateExtractionResult;
  maxContentBytes: number;
  extractorVersion: string;
  policyVersion: string;
  now: string;
}

export interface ReviewDecisionInput {
  id: string;
  namespace: string;
  candidateId: string;
  decisionKeyHash: string;
  candidateRevision: number;
  decision: "approve" | "merge" | "supersede" | "discard";
  targetMemoryId: string | null;
  subjectMemoryId: string | null;
  reviewerHash: string;
  now: string;
}

export class D1ConversationImportDerivationLedger {
  constructor(private readonly db: D1Database) {}

  async assertBatchDerivable(namespace: string, batchId: string): Promise<void> {
    const row = await this.db.prepare("SELECT status FROM conversation_import_batches WHERE namespace=? AND id=?")
      .bind(namespace, batchId).first<{ status: string }>();
    if (!row || !["archived", "deriving", "ready"].includes(row.status)) {
      throw new ConversationImportDerivationConflictError("batch_not_derivable");
    }
  }

  private async graphState(namespace: string, batchId: string): Promise<{
    revision: number; state: "open" | "delete_frozen" | "recompute_frozen" | "embedding_attention_frozen"; frozenRunId: string | null;
  }> {
    const row = await this.db.prepare(`SELECT graph_revision,state,frozen_run_id
      FROM conversation_import_derivation_graphs WHERE namespace=? AND import_batch_id=?`)
      .bind(namespace, batchId).first<{ graph_revision: number;
        state: "open" | "delete_frozen" | "recompute_frozen" | "embedding_attention_frozen"; frozen_run_id: string | null }>();
    return row ? { revision: row.graph_revision, state: row.state, frozenRunId: row.frozen_run_id }
      : { revision: 0, state: "open", frozenRunId: null };
  }

  private graphMutation(namespace: string, batchId: string, expectedRevision: number, now: string): {
    nextRevision: number; statements: D1PreparedStatement[]; guard: string;
  } {
    const nextRevision = expectedRevision + 1;
    return {
      nextRevision,
      statements: [
        this.db.prepare(`INSERT OR IGNORE INTO conversation_import_derivation_graphs
          (import_batch_id,namespace,graph_revision,state,frozen_run_id,updated_at)
          SELECT id,namespace,0,'open',NULL,? FROM conversation_import_batches
          WHERE id=? AND namespace=? AND status IN ('archived','deriving','ready')`)
          .bind(now, batchId, namespace),
        this.db.prepare(`UPDATE conversation_import_derivation_graphs SET graph_revision=?,updated_at=?
          WHERE import_batch_id=? AND namespace=? AND graph_revision=? AND state='open'`)
          .bind(nextRevision, now, batchId, namespace, expectedRevision),
        this.db.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM conversation_import_derivation_graphs
          WHERE import_batch_id=? AND namespace=? AND graph_revision=? AND state='open'
        ) THEN 1 ELSE abs(-9223372036854775808) END AS fence_ok`)
          .bind(batchId, namespace, nextRevision),
      ],
      guard: `EXISTS (SELECT 1 FROM conversation_import_derivation_graphs g
        WHERE g.import_batch_id=? AND g.namespace=? AND g.graph_revision=? AND g.state='open')`,
    };
  }

  private assertGraphMutation(results: D1Result[], fenceIndex = 1): void {
    if (changes(results[fenceIndex]) !== 1) throw new ConversationImportDerivationConflictError("derivation_conflict");
  }

  private async executeGraphBatch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    try {
      return await this.db.batch(statements);
    } catch {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
  }

  async beginSummaryJob(input: {
    id: string; namespace: string; batchId: string; jobKey: string; inputHash: string; version: string; now: string;
  }): Promise<"inserted" | "reused"> {
    await this.assertBatchDerivable(input.namespace, input.batchId);
    const result = await this.db.prepare(`INSERT OR IGNORE INTO conversation_import_jobs
      (id,namespace,batch_id,kind,job_key,status,cursor,attempt,input_hash,version,processed_count,error_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.id, input.namespace, input.batchId, "summarize", input.jobKey,
      "running", 0, 1, input.inputHash, input.version, 0, 0, input.now, input.now).run();
    if (changes(result) === 1) return "inserted";
    const existing = await this.db.prepare("SELECT id,batch_id,input_hash,version FROM conversation_import_jobs WHERE namespace=? AND job_key=?")
      .bind(input.namespace, input.jobKey).first<{ id: string; batch_id: string; input_hash: string; version: string }>();
    if (!existing || existing.id !== input.id || existing.batch_id !== input.batchId
      || existing.input_hash !== input.inputHash || existing.version !== input.version) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    return "reused";
  }

  async advanceSummaryJob(input: { id: string; expectedCursor: number; nextCursor: number; processedCount: number; now: string }): Promise<number> {
    if (!Number.isInteger(input.nextCursor) || input.nextCursor <= input.expectedCursor) {
      throw new ConversationImportDerivationConflictError("cursor_conflict");
    }
    const result = await this.db.prepare(`UPDATE conversation_import_jobs
      SET cursor=?,processed_count=MAX(processed_count,?),status='running',error_code=NULL,updated_at=?
      WHERE id=? AND kind='summarize' AND cursor=? AND status IN ('running','retry')`)
      .bind(input.nextCursor, input.processedCount, input.now, input.id, input.expectedCursor).run();
    if (changes(result) !== 1) throw new ConversationImportDerivationConflictError("cursor_conflict");
    return input.nextCursor;
  }

  async markSummaryJobRetry(input: { id: string; expectedCursor: number; errorCode: string; now: string }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE conversation_import_jobs
      SET status='retry',error_count=error_count+1,error_code=?,updated_at=?
      WHERE id=? AND kind='summarize' AND cursor=? AND status IN ('running','retry')`)
      .bind(input.errorCode, input.now, input.id, input.expectedCursor).run();
    return changes(result) === 1;
  }

  async markSummaryJobReady(input: { id: string; expectedCursor: number; processedCount: number; now: string }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE conversation_import_jobs
      SET status='ready',processed_count=MAX(processed_count,?),error_code=NULL,updated_at=?
      WHERE id=? AND kind='summarize' AND cursor=? AND status IN ('running','retry')`)
      .bind(input.processedCount, input.now, input.id, input.expectedCursor).run();
    return changes(result) === 1;
  }

  async storeReadySummary(input: ReadySummaryInput): Promise<{ status: "inserted" | "reused"; summaryInputHash: string; outputHash: string; sourceMessageIds: string[] }> {
    await this.assertBatchDerivable(input.namespace, input.batchId);
    if (!input.summaryText.trim() || !Number.isInteger(input.bounds.maxOutputBytes) || input.bounds.maxOutputBytes <= 0
      || new TextEncoder().encode(input.summaryText).byteLength > input.bounds.maxOutputBytes) {
      throw new Error("summary_output_limit_exceeded");
    }
    const sourceRows = await this.db.prepare(`SELECT m.id,m.content_sha256,m.occurred_at_utc,m.canonical_role,
      m.private_normalized_text,bm.source_order,m.quarantine_status,bm.active
      FROM conversation_import_messages m
      JOIN conversation_import_batch_messages bm ON bm.message_id=m.id
      JOIN conversation_import_batch_conversations bc ON bc.batch_id=bm.batch_id AND bc.conversation_id=m.conversation_id
      WHERE bm.batch_id=? AND m.namespace=? AND m.conversation_id=? AND bm.active=1 AND m.quarantine_status='none'
        AND bc.inclusion_status='included' AND m.canonical_role IN ('owner','assistant')
        AND m.content_type IN ('text','markdown','code','mixed')
      ORDER BY bm.source_order,m.sequence,m.id`).bind(input.batchId, input.namespace, input.conversationId).all<{
        id: string; content_sha256: string; occurred_at_utc: string | null; canonical_role: "owner" | "assistant";
        private_normalized_text: string | null; source_order: number; quarantine_status: "none"; active: number;
      }>();
    const projection = await buildSummaryProjection((sourceRows.results || []).map((row) => ({
      id: row.id,
      conversationId: input.conversationId,
      contentSha256: row.content_sha256,
      occurredAtUtc: row.occurred_at_utc,
      canonicalRole: row.canonical_role,
      normalizedText: row.private_normalized_text || "",
      active: row.active === 1,
      quarantineStatus: row.quarantine_status,
      sourceOrder: row.source_order,
    })), input.bounds, {
      promptPolicyVersion: input.promptPolicyVersion,
      summarizerVersion: input.summarizerVersion,
      summarizerModel: input.summarizerModel,
    });
    if (projection.messageIds.length === 0) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const outputHash = await sha256Hex(input.summaryText);
    const existing = await this.db.prepare(`SELECT s.id,s.status,s.summary_text,l.output_hash FROM conversation_import_summaries s
      LEFT JOIN conversation_import_summary_lineage l ON l.summary_id=s.id
      WHERE s.namespace=? AND s.conversation_id=? AND s.summary_input_hash=? AND s.summarizer_version=? LIMIT 1`)
      .bind(input.namespace, input.conversationId, projection.inputHash, input.summarizerVersion)
      .first<{ id: string; status: string; summary_text: string | null; output_hash: string | null }>();
    if (existing) {
      if (existing.id !== input.id || existing.status !== "ready" || existing.summary_text !== input.summaryText
        || existing.output_hash !== outputHash) throw new ConversationImportDerivationConflictError("derivation_conflict");
      const linked = await this.db.prepare(`SELECT status FROM conversation_import_summary_batches
        WHERE summary_id=? AND import_batch_id=? AND summary_input_hash=?`)
        .bind(input.id, input.batchId, projection.inputHash).first<{ status: string }>();
      if (linked && linked.status !== "active") throw new ConversationImportDerivationConflictError("derivation_conflict");
      if (linked) {
        const edges = await this.db.prepare(`SELECT import_message_id,source_order,summary_input_hash,content_hash_at_derivation
          FROM conversation_import_summary_provenance WHERE summary_id=? AND import_batch_id=? ORDER BY source_order`)
          .bind(input.id, input.batchId).all<{ import_message_id: string; source_order: number;
            summary_input_hash: string; content_hash_at_derivation: string }>();
        const expectedEdges = projection.messageIds.map((messageId, sourceOrder) => ({
          import_message_id: messageId,
          source_order: sourceOrder,
          summary_input_hash: projection.inputHash,
          content_hash_at_derivation: (sourceRows.results || []).find((row) => row.id === messageId)?.content_sha256,
        }));
        if (canonicalJson(edges.results || []) !== canonicalJson(expectedEdges)) {
          throw new ConversationImportDerivationConflictError("derivation_conflict");
        }
      }
      if (!linked) {
        const graph = await this.graphState(input.namespace, input.batchId);
        if (graph.state !== "open") throw new ConversationImportDerivationConflictError("derivation_conflict");
        const fence = this.graphMutation(input.namespace, input.batchId, graph.revision, input.now);
        const statements = [...fence.statements,
          this.db.prepare(`INSERT INTO conversation_import_summary_batches
            (summary_id,import_batch_id,summary_input_hash,status,created_at)
            SELECT ?,?,?,?,? WHERE ${fence.guard}`)
            .bind(input.id, input.batchId, projection.inputHash, "active", input.now,
              input.batchId, input.namespace, fence.nextRevision)];
        projection.messageIds.forEach((messageId, sourceOrder) => {
          const source = (sourceRows.results || []).find((row) => row.id === messageId);
          statements.push(this.db.prepare(`INSERT INTO conversation_import_summary_provenance
            (summary_id,import_batch_id,import_message_id,source_order,summary_input_hash,content_hash_at_derivation,created_at)
            SELECT ?,?,?,?,?,?,? WHERE ${fence.guard}`)
            .bind(input.id, input.batchId, messageId, sourceOrder, projection.inputHash, source?.content_sha256, input.now,
              input.batchId, input.namespace, fence.nextRevision));
        });
        const results = await this.executeGraphBatch(statements);
        this.assertGraphMutation(results);
        if (changes(results[3]) !== 1) throw new ConversationImportDerivationConflictError("derivation_conflict");
      }
      return { status: "reused", summaryInputHash: projection.inputHash, outputHash, sourceMessageIds: projection.messageIds };
    }
    if (input.supersedesSummaryId) {
      const supersedes = await this.db.prepare(`SELECT id FROM conversation_import_summaries
        WHERE id=? AND namespace=? AND conversation_id=? AND status='ready' LIMIT 1`)
        .bind(input.supersedesSummaryId, input.namespace, input.conversationId).first<{ id: string }>();
      if (!supersedes) throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    const graph = await this.graphState(input.namespace, input.batchId);
    if (graph.state !== "open") throw new ConversationImportDerivationConflictError("derivation_conflict");
    const fence = this.graphMutation(input.namespace, input.batchId, graph.revision, input.now);
    const summaryInsert = input.supersedesSummaryId
      ? this.db.prepare(`INSERT INTO conversation_import_summaries
        (id,namespace,conversation_id,status,summary_text,summary_input_hash,summarizer_model,prompt_policy_version,summarizer_version,
         source_message_count,vector_status,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence.guard} AND EXISTS (
          SELECT 1 FROM conversation_import_summaries WHERE id=? AND namespace=? AND conversation_id=? AND status='ready'
        )`).bind(input.id, input.namespace, input.conversationId, "ready", input.summaryText, projection.inputHash,
          input.summarizerModel, input.promptPolicyVersion, input.summarizerVersion, projection.messageIds.length, "none", input.now, input.now,
          input.batchId, input.namespace, fence.nextRevision,
          input.supersedesSummaryId, input.namespace, input.conversationId)
      : this.db.prepare(`INSERT INTO conversation_import_summaries
        (id,namespace,conversation_id,status,summary_text,summary_input_hash,summarizer_model,prompt_policy_version,summarizer_version,
         source_message_count,vector_status,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence.guard}`)
        .bind(input.id, input.namespace, input.conversationId, "ready", input.summaryText, projection.inputHash,
          input.summarizerModel, input.promptPolicyVersion, input.summarizerVersion, projection.messageIds.length, "none", input.now, input.now,
          input.batchId, input.namespace, fence.nextRevision);
    const statements: D1PreparedStatement[] = [
      ...fence.statements,
      summaryInsert,
      this.db.prepare(`INSERT INTO conversation_import_summary_lineage
        (summary_id,supersedes_summary_id,derivation_policy_version,output_hash,created_at)
        SELECT ?,?,?,?,? WHERE ${fence.guard}`)
        .bind(input.id, input.supersedesSummaryId || null, input.promptPolicyVersion, outputHash, input.now,
          input.batchId, input.namespace, fence.nextRevision),
      this.db.prepare(`INSERT INTO conversation_import_summary_batches
        (summary_id,import_batch_id,summary_input_hash,status,created_at)
        SELECT ?,?,?,?,? WHERE ${fence.guard}`)
        .bind(input.id, input.batchId, projection.inputHash, "active", input.now,
          input.batchId, input.namespace, fence.nextRevision),
    ];
    projection.messageIds.forEach((messageId, sourceOrder) => {
      const source = (sourceRows.results || []).find((row) => row.id === messageId);
      statements.push(this.db.prepare(`INSERT INTO conversation_import_summary_provenance
        (summary_id,import_batch_id,import_message_id,source_order,summary_input_hash,content_hash_at_derivation,created_at)
        SELECT ?,?,?,?,?,?,? WHERE ${fence.guard}`).bind(input.id, input.batchId, messageId, sourceOrder, projection.inputHash,
          source?.content_sha256, input.now, input.batchId, input.namespace, fence.nextRevision));
    });
    if (input.supersedesSummaryId) {
      statements.push(this.db.prepare(`UPDATE conversation_import_summary_batches SET status='superseded'
        WHERE summary_id=? AND import_batch_id=? AND status='active' AND ${fence.guard}`)
        .bind(input.supersedesSummaryId, input.batchId, input.batchId, input.namespace, fence.nextRevision));
      statements.push(this.db.prepare(`UPDATE conversation_import_summaries SET status='superseded',updated_at=?
        WHERE id=? AND namespace=? AND conversation_id=? AND status='ready'
          AND EXISTS (SELECT 1 FROM conversation_import_summaries WHERE id=? AND status='ready')
          AND NOT EXISTS (SELECT 1 FROM conversation_import_summary_batches WHERE summary_id=? AND status='active')
          AND ${fence.guard}`)
        .bind(input.now, input.supersedesSummaryId, input.namespace, input.conversationId, input.id, input.supersedesSummaryId,
          input.batchId, input.namespace, fence.nextRevision));
    }
    const results = await this.executeGraphBatch(statements);
    this.assertGraphMutation(results);
    if (changes(results[3]) !== 1 || changes(results[4]) !== 1 || changes(results[5]) !== 1) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    if (input.supersedesSummaryId) {
      const terminal = await this.db.prepare(`SELECT
        (SELECT status FROM conversation_import_summaries WHERE id=?) AS new_status,
        (SELECT status FROM conversation_import_summaries WHERE id=?) AS old_status`)
        .bind(input.id, input.supersedesSummaryId).first<{ new_status: string | null; old_status: string | null }>();
      const oldSupport = await this.db.prepare(`SELECT status FROM conversation_import_summary_batches
        WHERE summary_id=? AND import_batch_id=?`).bind(input.supersedesSummaryId, input.batchId).first<{ status: string }>();
      if (terminal?.new_status !== "ready" || oldSupport?.status !== "superseded"
        || !["ready", "superseded"].includes(terminal.old_status || "")) {
        throw new ConversationImportDerivationConflictError("derivation_conflict");
      }
    }
    return { status: "inserted", summaryInputHash: projection.inputHash, outputHash, sourceMessageIds: projection.messageIds };
  }

  async storeCandidate(input: CandidateDerivationInput): Promise<{ status: "inserted" | "reused"; extraction: ValidatedCandidateExtraction }> {
    await this.assertBatchDerivable(input.namespace, input.batchId);
    const summary = await this.db.prepare(`SELECT s.summary_input_hash,s.namespace,s.status,l.output_hash
      FROM conversation_import_summaries s JOIN conversation_import_summary_lineage l ON l.summary_id=s.id
      JOIN conversation_import_summary_batches sb ON sb.summary_id=s.id
      WHERE s.id=? AND s.namespace=? AND s.status='ready' AND sb.import_batch_id=?
        AND sb.status='active' AND sb.summary_input_hash=s.summary_input_hash LIMIT 1`)
      .bind(input.summaryId, input.namespace, input.batchId)
      .first<{ summary_input_hash: string; namespace: string; status: string; output_hash: string }>();
    if (!summary) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const extraction = await validateCandidateExtraction(input.extraction, {
      summaryInputHash: summary.summary_input_hash,
      extractorVersion: input.extractorVersion,
      policyVersion: input.policyVersion,
      maxContentBytes: input.maxContentBytes,
    });
    const placeholders = extraction.sourceMessageIds.map(() => "?").join(",");
    const provenanceCount = await this.db.prepare(`SELECT COUNT(DISTINCT p.import_message_id) AS count
      FROM conversation_import_summary_provenance p JOIN conversation_import_summaries s ON s.id=p.summary_id
      WHERE p.summary_id=? AND p.import_batch_id=? AND s.namespace=? AND s.status='ready'
        AND p.import_message_id IN (${placeholders})`)
      .bind(input.summaryId, input.batchId, input.namespace, ...extraction.sourceMessageIds).first<{ count: number }>();
    if ((provenanceCount?.count || 0) !== extraction.sourceMessageIds.length) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    const existing = await this.db.prepare(`SELECT candidate_id,candidate_content_hash,policy_class,review_required FROM conversation_import_candidate_derivations
      WHERE import_batch_id=? AND candidate_input_hash=? AND extractor_version=? AND policy_version=? LIMIT 1`)
      .bind(input.batchId, extraction.inputHash, input.extractorVersion, input.policyVersion)
      .first<{ candidate_id: string; candidate_content_hash: string; policy_class: string; review_required: number }>();
    if (existing) {
      if (existing.candidate_id !== input.id || existing.candidate_content_hash !== extraction.contentHash
        || existing.policy_class !== extraction.policyClass || existing.review_required !== 1) {
        throw new ConversationImportDerivationConflictError("derivation_conflict");
      }
      return { status: "reused", extraction };
    }
    const graph = await this.graphState(input.namespace, input.batchId);
    if (graph.state !== "open") throw new ConversationImportDerivationConflictError("derivation_conflict");
    const fence = this.graphMutation(input.namespace, input.batchId, graph.revision, input.now);
    const statements: D1PreparedStatement[] = [
      ...fence.statements,
      this.db.prepare(`INSERT INTO memory_candidates
        (id,namespace,type,content,fact_key,confidence,importance,tags,source_message_ids,source,status,target_memory_id,decision_note,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence.guard}`)
        .bind(input.id, input.namespace, extraction.type, extraction.content, extraction.factKey,
          extraction.confidence, extraction.importance, "[]", JSON.stringify(extraction.sourceMessageIds),
          "conversation_import", "pending", extraction.conflictTargetMemoryId, null, input.now, input.now,
          input.batchId, input.namespace, fence.nextRevision),
      this.db.prepare(`INSERT INTO conversation_import_candidate_derivations
        (candidate_id,import_batch_id,summary_id,candidate_input_hash,candidate_content_hash,policy_class,conflict_target_memory_id,review_required,
         extractor_version,policy_version,candidate_revision,status,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence.guard}`)
        .bind(input.id, input.batchId, input.summaryId, extraction.inputHash, extraction.contentHash,
          extraction.policyClass, extraction.conflictTargetMemoryId, 1, input.extractorVersion, input.policyVersion, 1, "pending", input.now, input.now,
          input.batchId, input.namespace, fence.nextRevision),
    ];
    for (const messageId of extraction.sourceMessageIds) {
      statements.push(this.db.prepare(`INSERT INTO memory_candidate_provenance
        (candidate_id,import_batch_id,import_conversation_id,import_message_id,extractor_version,candidate_input_hash,
         conflict_class,sensitivity_class,created_at)
        SELECT ?,?,s.conversation_id,?,?,?, ?,?,? FROM conversation_import_summaries s
        WHERE s.id=? AND ${fence.guard}`)
        .bind(input.id, input.batchId, messageId, input.extractorVersion, extraction.inputHash,
          extraction.policyClass === "conflict" ? "conflict" : null,
          extraction.policyClass === "sensitive" || extraction.policyClass === "identity" ? extraction.policyClass : null,
          input.now, input.summaryId, input.batchId, input.namespace, fence.nextRevision));
    }
    const results = await this.executeGraphBatch(statements);
    this.assertGraphMutation(results);
    if (changes(results[3]) !== 1 || changes(results[4]) !== 1) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    return { status: "inserted", extraction };
  }

  async recordReviewDecision(input: ReviewDecisionInput): Promise<"inserted" | "reused"> {
    const expectedDecisionId = await deriveReviewDecisionId(input);
    if (input.id !== expectedDecisionId) throw new ConversationImportDerivationConflictError("decision_conflict");
    const candidate = await this.db.prepare(`SELECT c.*,d.import_batch_id,d.policy_class,d.conflict_target_memory_id,d.candidate_revision,d.status AS derivation_status,d.extractor_version
      FROM memory_candidates c JOIN conversation_import_candidate_derivations d ON d.candidate_id=c.id
      WHERE c.id=? AND c.namespace=? LIMIT 1`).bind(input.candidateId, input.namespace).first<{
        id: string; namespace: string; type: string; content: string; fact_key: string | null; confidence: number; importance: number;
        tags: string | null; source_message_ids: string | null; target_memory_id: string | null; status: string;
        import_batch_id: string; policy_class: string; conflict_target_memory_id: string | null; candidate_revision: number; derivation_status: string; extractor_version: string;
      }>();
    if (!candidate || candidate.candidate_revision !== input.candidateRevision) throw new ConversationImportDerivationConflictError("decision_conflict");
    if (input.decision === "discard") {
      if (input.targetMemoryId || input.subjectMemoryId) throw new ConversationImportDerivationConflictError("decision_conflict");
    } else if (!input.targetMemoryId) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    const expectedNewMemoryId = await deriveReviewMemoryId(input);
    if ((input.decision === "approve" || input.decision === "supersede") && input.targetMemoryId !== expectedNewMemoryId) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    if (input.decision === "approve" && input.subjectMemoryId) throw new ConversationImportDerivationConflictError("decision_conflict");
    if (input.decision === "merge" && (!input.subjectMemoryId || input.subjectMemoryId !== input.targetMemoryId)) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    if (input.decision === "supersede" && !input.subjectMemoryId) throw new ConversationImportDerivationConflictError("decision_conflict");
    if (candidate.policy_class === "conflict"
      && (input.decision !== "supersede" || candidate.conflict_target_memory_id !== input.subjectMemoryId)) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    const existing = await this.db.prepare(`SELECT candidate_id,decision_key_hash,candidate_revision,decision,target_memory_id,subject_memory_id,
      reviewer_hash,before_content_hash,after_content_hash,status FROM conversation_import_review_decisions
      WHERE namespace=? AND (decision_key_hash=? OR (candidate_id=? AND candidate_revision=?)) LIMIT 1`)
      .bind(input.namespace, input.decisionKeyHash, input.candidateId, input.candidateRevision).first<{ candidate_id: string;
        decision_key_hash: string; candidate_revision: number; decision: string; target_memory_id: string | null; subject_memory_id: string | null;
        reviewer_hash: string; before_content_hash: string | null; after_content_hash: string | null; status: string }>();
    if (existing && (existing.decision_key_hash !== input.decisionKeyHash || existing.candidate_id !== input.candidateId
      || existing.candidate_revision !== input.candidateRevision || existing.decision !== input.decision
      || existing.target_memory_id !== input.targetMemoryId || existing.subject_memory_id !== input.subjectMemoryId
      || existing.reviewer_hash !== input.reviewerHash)) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    if (existing?.status === "completed") return "reused";
    await this.assertBatchDerivable(input.namespace, candidate.import_batch_id);
    const graph = await this.graphState(input.namespace, candidate.import_batch_id);
    if (graph.state !== "open") throw new ConversationImportDerivationConflictError("decision_conflict");
    const fence = this.graphMutation(input.namespace, candidate.import_batch_id, graph.revision, input.now);
    const subject = input.subjectMemoryId
      ? await this.db.prepare("SELECT id,namespace,content,status FROM memories WHERE id=? AND namespace=?")
        .bind(input.subjectMemoryId, input.namespace).first<{ id: string; namespace: string; content: string; status: string }>()
      : null;
    if (input.subjectMemoryId && (!subject || (subject.status !== "active"
      && !(existing?.status === "reserved" && input.decision === "supersede" && subject.status === "superseded")))) {
      throw new ConversationImportDerivationConflictError("decision_conflict");
    }
    const beforeContentHash = existing?.before_content_hash ?? (subject ? await sha256Hex(subject.content) : null);
    const afterContentHash = input.decision === "discard" ? null : await sha256Hex(candidate.content);
    if (existing) {
      if (existing.before_content_hash !== beforeContentHash || existing.after_content_hash !== afterContentHash) {
        throw new ConversationImportDerivationConflictError("decision_conflict");
      }
    }
    const status = input.decision === "approve" ? "approved"
      : input.decision === "discard" ? "discarded"
      : input.decision === "supersede" ? "superseded"
      : "merged";
    const statements: D1PreparedStatement[] = [...fence.statements];
    if (!existing) statements.push(this.db.prepare(`INSERT INTO conversation_import_review_decisions
        (id,namespace,candidate_id,decision_key_hash,candidate_revision,decision,target_memory_id,reviewer_hash,before_content_hash,
         after_content_hash,subject_memory_id,status,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?, ?,? WHERE EXISTS (
          SELECT 1 FROM conversation_import_candidate_derivations d JOIN memory_candidates c ON c.id=d.candidate_id
          WHERE d.candidate_id=? AND d.candidate_revision=? AND d.status='pending' AND c.namespace=? AND c.status='pending'
        )`).bind(input.id, input.namespace, input.candidateId, input.decisionKeyHash, input.candidateRevision, input.decision,
          input.targetMemoryId, input.reviewerHash, beforeContentHash, afterContentHash, input.subjectMemoryId, "reserved",
          input.now, input.now, input.candidateId, input.candidateRevision, input.namespace));
    const decisionPredicate = `EXISTS (SELECT 1 FROM conversation_import_review_decisions r
      WHERE r.id=? AND r.namespace=? AND r.candidate_id=? AND r.status='reserved')`;
    if (input.decision === "approve") {
      statements.push(this.db.prepare(`INSERT INTO memories
        (id,namespace,type,content,importance,confidence,status,pinned,tags,source,source_message_ids,recall_count,created_at,updated_at)
        SELECT ?,?,?,?,?,?,'active',0,?,'conversation_import_review',?,0,?,? WHERE ${decisionPredicate}
          AND NOT EXISTS (SELECT 1 FROM memories WHERE id=? OR (namespace=? AND id=?))`)
        .bind(input.targetMemoryId, input.namespace, candidate.type, candidate.content, candidate.importance, candidate.confidence,
          candidate.tags, candidate.source_message_ids, input.now, input.now, input.id, input.namespace, input.candidateId,
          input.targetMemoryId, input.namespace, input.targetMemoryId));
    } else if (input.decision === "merge") {
      statements.push(this.db.prepare(`UPDATE memories SET content=?,type=?,importance=MAX(importance,?),confidence=MAX(confidence,?),
        tags=?,source='conversation_import_review',source_message_ids=?,updated_at=?
        WHERE id=? AND namespace=? AND status='active' AND content=? AND ${decisionPredicate}`)
        .bind(candidate.content, candidate.type, candidate.importance, candidate.confidence, candidate.tags, candidate.source_message_ids,
          input.now, input.targetMemoryId, input.namespace, subject?.content, input.id, input.namespace, input.candidateId));
    } else if (input.decision === "supersede") {
      statements.push(this.db.prepare(`UPDATE memories SET status='superseded',updated_at=?
        WHERE id=? AND namespace=? AND status='active' AND content=? AND ${decisionPredicate}`)
        .bind(input.now, input.subjectMemoryId, input.namespace, subject?.content, input.id, input.namespace, input.candidateId));
      statements.push(this.db.prepare(`INSERT INTO memories
        (id,namespace,type,content,importance,confidence,status,pinned,tags,source,source_message_ids,recall_count,created_at,updated_at)
        SELECT ?,?,?,?,?,?,'active',0,?,'conversation_import_review',?,0,?,? WHERE ${decisionPredicate}
          AND EXISTS (SELECT 1 FROM memories WHERE id=? AND namespace=? AND status='superseded')
          AND NOT EXISTS (SELECT 1 FROM memories WHERE id=?)`)
        .bind(input.targetMemoryId, input.namespace, candidate.type, candidate.content, candidate.importance, candidate.confidence,
          candidate.tags, candidate.source_message_ids, input.now, input.now, input.id, input.namespace, input.candidateId,
          input.subjectMemoryId, input.namespace, input.targetMemoryId));
    }
    statements.push(this.db.prepare(`UPDATE conversation_import_review_decisions SET status='completed',error_code=NULL,updated_at=?
      WHERE id=? AND namespace=? AND status='reserved' AND (
        (decision='discard' AND target_memory_id IS NULL AND subject_memory_id IS NULL) OR
        (decision='merge' AND EXISTS (SELECT 1 FROM memories m
          WHERE m.id=conversation_import_review_decisions.target_memory_id
            AND m.namespace=conversation_import_review_decisions.namespace AND m.status='active'
            AND m.content=(SELECT content FROM memory_candidates WHERE id=conversation_import_review_decisions.candidate_id))) OR
        (decision IN ('approve','supersede') AND EXISTS (SELECT 1 FROM memories m
          WHERE m.id=conversation_import_review_decisions.target_memory_id
            AND m.namespace=conversation_import_review_decisions.namespace AND m.status='active'
            AND m.content=(SELECT content FROM memory_candidates WHERE id=conversation_import_review_decisions.candidate_id)))
      )`).bind(input.now, input.id, input.namespace));
    statements.push(this.db.prepare(`UPDATE conversation_import_candidate_derivations SET status=?,updated_at=?
      WHERE candidate_id=? AND candidate_revision=? AND status='pending' AND EXISTS (
        SELECT 1 FROM conversation_import_review_decisions WHERE id=? AND status='completed')`)
      .bind(status, input.now, input.candidateId, input.candidateRevision, input.id));
    statements.push(this.db.prepare(`UPDATE memory_candidates SET status=?,target_memory_id=?,decision_note='conversation_import_reviewed',updated_at=?
      WHERE namespace=? AND id=? AND status='pending' AND EXISTS (
        SELECT 1 FROM conversation_import_review_decisions WHERE id=? AND status='completed')`)
      .bind(status, input.targetMemoryId, input.now, input.namespace, input.candidateId, input.id));
    if (input.decision !== "discard") statements.push(this.db.prepare(`INSERT INTO memory_provenance
        (memory_id,provenance_kind,import_batch_id,import_conversation_id,import_message_id,candidate_id,
         content_hash_at_promotion,extractor_version,reviewer_version,created_at)
        SELECT r.target_memory_id,?,d.import_batch_id,s.conversation_id,p.import_message_id,d.candidate_id,r.after_content_hash,d.extractor_version,r.reviewer_hash,?
        FROM conversation_import_review_decisions r
        JOIN conversation_import_candidate_derivations d ON d.candidate_id=r.candidate_id
        JOIN conversation_import_summaries s ON s.id=d.summary_id
        JOIN conversation_import_summary_provenance p ON p.summary_id=s.id
        WHERE r.id=? AND r.status='completed' AND p.import_batch_id=d.import_batch_id
        ORDER BY p.source_order LIMIT 1`)
        .bind(`conversation_import_${input.decision}`, input.now, input.id));
    const decisionResults = await this.executeGraphBatch(statements);
    this.assertGraphMutation(decisionResults);
    const completed = await this.db.prepare("SELECT status FROM conversation_import_review_decisions WHERE id=? AND namespace=?")
      .bind(input.id, input.namespace).first<{ status: string }>();
    if (completed?.status !== "completed") throw new ConversationImportDerivationConflictError("decision_conflict");
    return existing ? "reused" : "inserted";
  }

  async previewDelete(namespace: string, batchId: string, policyVersion: string): Promise<DerivationDeletePreview> {
    await this.assertBatchDerivable(namespace, batchId);
    const batch = await this.db.prepare("SELECT revision FROM conversation_import_batches WHERE namespace=? AND id=?")
      .bind(namespace, batchId).first<{ revision: number }>();
    if (!batch) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const graph = await this.graphState(namespace, batchId);
    if (graph.state !== "open") throw new ConversationImportDerivationConflictError("derivation_conflict");
    const impacts: DerivationImpactInput[] = [{
      refKind: "batch_link", refId: batchId, activeBatchProvenanceCount: 1, deletingBatchProvenanceCount: 1,
    }];
    const conversations = await this.db.prepare(`SELECT c.id,COUNT(DISTINCT bc2.batch_id) AS provenance_count
      FROM conversation_import_batch_conversations bc
      JOIN conversation_import_conversations c ON c.id=bc.conversation_id AND c.namespace=?
      JOIN conversation_import_batch_conversations bc2 ON bc2.conversation_id=c.id
      JOIN conversation_import_batches b2 ON b2.id=bc2.batch_id AND b2.status!='deleted'
      WHERE bc.batch_id=? GROUP BY c.id ORDER BY c.id`).bind(namespace, batchId).all<{ id: string; provenance_count: number }>();
    for (const row of conversations.results || []) impacts.push({ refKind: "conversation", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1 });
    const messages = await this.db.prepare(`SELECT m.id,COUNT(DISTINCT bm2.batch_id) AS provenance_count
      FROM conversation_import_batch_messages bm
      JOIN conversation_import_messages m ON m.id=bm.message_id AND m.namespace=?
      JOIN conversation_import_batch_messages bm2 ON bm2.message_id=m.id
      JOIN conversation_import_batches b2 ON b2.id=bm2.batch_id AND b2.status!='deleted'
      WHERE bm.batch_id=? GROUP BY m.id ORDER BY m.id`).bind(namespace, batchId).all<{ id: string; provenance_count: number }>();
    for (const row of messages.results || []) impacts.push({ refKind: "message", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1 });
    const summaries = await this.db.prepare(`SELECT s.id,COUNT(DISTINCT sb2.import_batch_id) AS provenance_count
      FROM conversation_import_summary_batches sb
      JOIN conversation_import_summaries s ON s.id=sb.summary_id AND s.namespace=?
      JOIN conversation_import_summary_batches sb2 ON sb2.summary_id=s.id AND sb2.status='active'
      JOIN conversation_import_batches b2 ON b2.id=sb2.import_batch_id AND b2.status!='deleted'
      WHERE sb.import_batch_id=? AND sb.status='active' GROUP BY s.id ORDER BY s.id`).bind(namespace, batchId).all<{ id: string; provenance_count: number }>();
    for (const row of summaries.results || []) impacts.push({ refKind: "summary", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1 });
    const candidates = await this.db.prepare(`SELECT d.candidate_id AS id,1 AS provenance_count
      FROM conversation_import_candidate_derivations d JOIN memory_candidates c ON c.id=d.candidate_id AND c.namespace=?
      WHERE d.import_batch_id=? ORDER BY d.candidate_id`).bind(namespace, batchId).all<{ id: string; provenance_count: number }>();
    for (const row of candidates.results || []) impacts.push({ refKind: "candidate", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1 });
    const memories = await this.db.prepare(`SELECT m.id,m.content,
      COUNT(DISTINCT CASE WHEN b2.status!='deleted' THEN p2.import_batch_id END) AS provenance_count,
      MIN(CASE WHEN b2.status!='deleted' THEN p2.content_hash_at_promotion END) AS promotion_hash,
      COUNT(DISTINCT CASE WHEN b2.status!='deleted' THEN p2.content_hash_at_promotion END) AS promotion_hash_count
      FROM memory_provenance p
      JOIN memories m ON m.id=p.memory_id AND m.namespace=?
      JOIN memory_provenance p2 ON p2.memory_id=m.id
      LEFT JOIN conversation_import_batches b2 ON b2.id=p2.import_batch_id
      WHERE p.import_batch_id=? GROUP BY m.id,m.content ORDER BY m.id`)
      .bind(namespace, batchId).all<{ id: string; content: string; provenance_count: number;
        promotion_hash: string | null; promotion_hash_count: number }>();
    for (const row of memories.results || []) impacts.push({ refKind: "memory", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1,
      currentContentHash: row.content ? await sha256Hex(row.content) : null,
      promotionContentHash: Number(row.promotion_hash_count) === 1 ? row.promotion_hash : null });
    const vectors = await this.db.prepare(`SELECT e.vector_id AS id,COUNT(DISTINCT eb2.import_batch_id) AS provenance_count
      FROM conversation_import_embedding_batches eb
      JOIN conversation_import_embedding_ledger e ON e.id=eb.embedding_id AND e.namespace=? AND e.operation='write' AND e.status='ready'
      JOIN conversation_import_embedding_batches eb2 ON eb2.embedding_id=e.id
      JOIN conversation_import_batches b2 ON b2.id=eb2.import_batch_id AND b2.status!='deleted'
      WHERE eb.import_batch_id=? GROUP BY e.vector_id ORDER BY e.vector_id`)
      .bind(namespace, batchId).all<{ id: string; provenance_count: number }>();
    for (const row of vectors.results || []) impacts.push({ refKind: "vector", refId: row.id,
      activeBatchProvenanceCount: Number(row.provenance_count), deletingBatchProvenanceCount: 1 });
    return previewDerivationDelete({ namespace, batchId, batchRevision: batch.revision,
      graphRevision: graph.revision, policyVersion, impacts });
  }

  async beginRun(input: { id: string; preview: DerivationDeletePreview; kind: "delete" | "recompute"; now: string }): Promise<"inserted" | "reused"> {
    await this.assertBatchDerivable(input.preview.namespace, input.preview.batchId);
    const replay = await this.db.prepare(`SELECT id,import_batch_id,input_hash,preview_digest,graph_revision,status
      FROM conversation_import_derivation_runs WHERE id=? OR (namespace=? AND kind=? AND preview_digest=?) LIMIT 1`)
      .bind(input.id, input.preview.namespace, input.kind, input.preview.previewDigest)
      .first<{ id: string; import_batch_id: string; input_hash: string; preview_digest: string; graph_revision: number; status: string }>();
    const proposedInputHash = await domainSeparatedHash("operia/conversation-import/derivation-run/v1", [input.kind, input.preview.previewDigest]);
    if (replay) {
      if (replay.id !== input.id || replay.import_batch_id !== input.preview.batchId
        || replay.input_hash !== proposedInputHash || replay.preview_digest !== input.preview.previewDigest) {
        throw new ConversationImportDerivationConflictError("derivation_conflict");
      }
      const frozen = await this.graphState(input.preview.namespace, input.preview.batchId);
      const activeReplay = ["pending", "running", "retry", "partial"].includes(replay.status);
      if ((activeReplay && (frozen.frozenRunId !== input.id || frozen.revision !== replay.graph_revision))
        || (!activeReplay && frozen.state !== "open")) {
        throw new ConversationImportDerivationConflictError("derivation_conflict");
      }
      return "reused";
    }
    const authoritative = await this.previewDelete(input.preview.namespace, input.preview.batchId, input.preview.policyVersion);
    if (canonicalJson(authoritative) !== canonicalJson(input.preview)) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    const unsettledEmbedding = await this.db.prepare(`SELECT e.id FROM conversation_import_embedding_batches eb
      JOIN conversation_import_embedding_ledger e ON e.id=eb.embedding_id
      WHERE eb.import_batch_id=? AND e.status IN ('pending','retry','started','attention') LIMIT 1`)
      .bind(input.preview.batchId).first<{ id: string }>();
    if (unsettledEmbedding) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const inputHash = proposedInputHash;
    const frozenState = input.kind === "delete" ? "delete_frozen" : "recompute_frozen";
    const frozenRevision = authoritative.graphRevision + 1;
    const freezeGuard = `EXISTS (SELECT 1 FROM conversation_import_derivation_graphs g WHERE
      g.import_batch_id=? AND g.namespace=? AND g.graph_revision=? AND g.state=? AND g.frozen_run_id=?)`;
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT OR IGNORE INTO conversation_import_derivation_graphs
        (import_batch_id,namespace,graph_revision,state,frozen_run_id,updated_at)
        SELECT id,namespace,0,'open',NULL,? FROM conversation_import_batches
        WHERE id=? AND namespace=? AND status IN ('archived','deriving','ready')`)
        .bind(input.now, input.preview.batchId, input.preview.namespace),
      this.db.prepare(`UPDATE conversation_import_derivation_graphs
        SET graph_revision=?,state=?,frozen_run_id=?,updated_at=?
        WHERE import_batch_id=? AND namespace=? AND graph_revision=? AND state='open' AND frozen_run_id IS NULL`)
        .bind(frozenRevision, frozenState, input.id, input.now, input.preview.batchId,
          input.preview.namespace, authoritative.graphRevision),
      this.db.prepare(`SELECT CASE WHEN ${freezeGuard} THEN 1 ELSE abs(-9223372036854775808) END AS fence_ok`)
        .bind(input.preview.batchId, input.preview.namespace, frozenRevision, frozenState, input.id),
      this.db.prepare(`SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversation_import_embedding_batches eb
        JOIN conversation_import_embedding_ledger e ON e.id=eb.embedding_id
        WHERE eb.import_batch_id=? AND e.status IN ('pending','retry','started','attention')
      ) THEN 1 ELSE abs(-9223372036854775808) END AS embedding_fence_ok`)
        .bind(input.preview.batchId),
      this.db.prepare(`INSERT INTO conversation_import_derivation_runs
        (id,namespace,import_batch_id,kind,preview_digest,input_hash,policy_version,graph_revision,status,cursor,item_count,generation,error_count,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${freezeGuard}`)
        .bind(input.id, input.preview.namespace, input.preview.batchId, input.kind,
          input.preview.previewDigest, inputHash, input.preview.policyVersion, frozenRevision, "running", 0,
          input.preview.items.length, 1, 0, input.now, input.now,
          input.preview.batchId, input.preview.namespace, frozenRevision, frozenState, input.id),
    ];
    input.preview.items.forEach((item, sourceOrder) => statements.push(this.db.prepare(`INSERT INTO conversation_import_derivation_impact_items
      (run_id,source_order,ref_kind,ref_id,classification,action,input_hash,status,generation,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${freezeGuard}`).bind(input.id, sourceOrder, item.refKind, item.refId, item.classification, item.action,
      item.inputHash, "pending", 1, input.now,
      input.preview.batchId, input.preview.namespace, frozenRevision, frozenState, input.id)));
    const results = await this.executeGraphBatch(statements);
    if (changes(results[1]) !== 1 || changes(results[4]) !== 1) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    return "inserted";
  }

  async claimImpactExecution(input: { runId: string; expectedCursor: number; expectedGeneration: number;
    actionKey: string; executionLeaseId: string; now: string; leaseExpiresAt: string;
  }): Promise<"acquired" | "resumed" | "busy" | "attention"> {
    const acquired = await this.db.prepare(`UPDATE conversation_import_derivation_impact_items
      SET status='started',action_key=?,execution_lease_id=?,lease_expires_at=?,error_code=NULL,updated_at=?
      WHERE run_id=? AND source_order=? AND generation=? AND status IN ('pending','retry') AND EXISTS (
        SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_graphs g
          ON g.frozen_run_id=r.id AND g.import_batch_id=r.import_batch_id
        WHERE r.id=? AND r.cursor=? AND r.status IN ('running','retry','partial')
          AND g.state IN ('delete_frozen','recompute_frozen'))`)
      .bind(input.actionKey, input.executionLeaseId, input.leaseExpiresAt, input.now,
        input.runId, input.expectedCursor, input.expectedGeneration, input.runId, input.expectedCursor).run();
    if (changes(acquired) === 1) return "acquired";
    const row = await this.db.prepare(`SELECT status,generation,action_key,execution_lease_id,lease_expires_at
      FROM conversation_import_derivation_impact_items WHERE run_id=? AND source_order=?`)
      .bind(input.runId, input.expectedCursor).first<{ status: string; generation: number; action_key: string | null;
        execution_lease_id: string | null; lease_expires_at: string | null }>();
    if (row?.status === "attention") return "attention";
    if (!row || row.status !== "started" || row.generation !== input.expectedGeneration
      || row.action_key !== input.actionKey || row.execution_lease_id !== input.executionLeaseId) return "busy";
    if (!row.lease_expires_at || row.lease_expires_at > input.now) return "busy";
    const resumed = await this.db.prepare(`UPDATE conversation_import_derivation_impact_items SET lease_expires_at=?,updated_at=?
      WHERE run_id=? AND source_order=? AND generation=? AND status='started' AND action_key=?
        AND execution_lease_id=? AND lease_expires_at=? AND EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_graphs g
            ON g.frozen_run_id=r.id AND g.import_batch_id=r.import_batch_id
          WHERE r.id=? AND r.cursor=? AND r.status IN ('running','retry','partial')
            AND g.state IN ('delete_frozen','recompute_frozen'))`)
      .bind(input.leaseExpiresAt, input.now, input.runId, input.expectedCursor, input.expectedGeneration,
        input.actionKey, input.executionLeaseId, row.lease_expires_at, input.runId, input.expectedCursor).run();
    return changes(resumed) === 1 ? "resumed" : "busy";
  }

  async cancelRunBeforeEffects(input: { runId: string; now: string }): Promise<boolean> {
    try {
      const results = await this.db.batch([
        this.db.prepare(`UPDATE conversation_import_derivation_runs SET status='cancelled',updated_at=?
          WHERE id=? AND cursor=0 AND status IN ('running','retry','partial') AND NOT EXISTS (
            SELECT 1 FROM conversation_import_derivation_impact_items WHERE run_id=? AND status NOT IN ('pending','retry'))
          AND EXISTS (SELECT 1 FROM conversation_import_derivation_graphs
            WHERE frozen_run_id=? AND state IN ('delete_frozen','recompute_frozen'))`)
          .bind(input.now, input.runId, input.runId, input.runId),
        this.db.prepare(`UPDATE conversation_import_derivation_graphs SET state='open',frozen_run_id=NULL,
          graph_revision=graph_revision+1,updated_at=? WHERE frozen_run_id=?
          AND state IN ('delete_frozen','recompute_frozen') AND EXISTS (
            SELECT 1 FROM conversation_import_derivation_runs WHERE id=? AND status='cancelled' AND cursor=0)`)
          .bind(input.now, input.runId, input.runId),
        this.db.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_graphs g
            ON g.import_batch_id=r.import_batch_id
          WHERE r.id=? AND r.status='cancelled' AND r.cursor=0 AND g.state='open' AND g.frozen_run_id IS NULL
        ) THEN 1 ELSE abs(-9223372036854775808) END AS cancel_fence_ok`).bind(input.runId),
      ]);
      return changes(results[0]) === 1 && changes(results[1]) === 1;
    } catch {
      return false;
    }
  }

  async completeImpactItem(input: { runId: string; expectedCursor: number; expectedGeneration: number;
    actionKey: string; executionLeaseId: string; now: string }): Promise<number> {
    const nextCursor = input.expectedCursor + 1;
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`UPDATE conversation_import_derivation_impact_items
          SET status='ready',generation=generation+1,execution_lease_id=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
          WHERE run_id=? AND source_order=? AND status='started' AND generation=? AND action_key=? AND execution_lease_id=?
            AND EXISTS (SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_graphs g
              ON g.frozen_run_id=r.id AND g.import_batch_id=r.import_batch_id
              WHERE r.id=? AND r.cursor=? AND r.status IN ('running','retry','partial')
                AND g.state IN ('delete_frozen','recompute_frozen'))`)
          .bind(input.now, input.runId, input.expectedCursor, input.expectedGeneration, input.actionKey,
            input.executionLeaseId, input.runId, input.expectedCursor),
        this.db.prepare(`UPDATE conversation_import_derivation_runs SET cursor=?,updated_at=?
          WHERE id=? AND cursor=? AND status IN ('running','retry','partial') AND EXISTS (
            SELECT 1 FROM conversation_import_derivation_impact_items WHERE run_id=? AND source_order=?
              AND status='ready' AND action_key=?)`)
          .bind(nextCursor, input.now, input.runId, input.expectedCursor, input.runId, input.expectedCursor, input.actionKey),
        this.db.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_impact_items i
            ON i.run_id=r.id AND i.source_order=?
          WHERE r.id=? AND r.cursor=? AND r.status IN ('running','retry','partial')
            AND i.status='ready' AND i.action_key=?
        ) THEN 1 ELSE abs(-9223372036854775808) END AS completion_fence_ok`)
          .bind(input.expectedCursor, input.runId, nextCursor, input.actionKey),
      ]);
    } catch {
      throw new ConversationImportDerivationConflictError("cursor_conflict");
    }
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) throw new ConversationImportDerivationConflictError("cursor_conflict");
    return nextCursor;
  }

  async inspectImpactProgress(runId: string, sourceOrder: number): Promise<{
    cursor: number; runStatus: string; itemStatus: string; generation: number;
    actionKey: string | null; executionLeaseId: string | null; leaseExpiresAt: string | null;
  }> {
    const row = await this.db.prepare(`SELECT r.cursor,r.status AS run_status,i.status AS item_status,i.generation,
      i.action_key,i.execution_lease_id,i.lease_expires_at
      FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_impact_items i
        ON i.run_id=r.id AND i.source_order=? WHERE r.id=?`)
      .bind(sourceOrder, runId).first<{ cursor: number; run_status: string; item_status: string; generation: number;
        action_key: string | null; execution_lease_id: string | null; lease_expires_at: string | null }>();
    if (!row) throw new ConversationImportDerivationConflictError("derivation_conflict");
    return { cursor: row.cursor, runStatus: row.run_status, itemStatus: row.item_status, generation: row.generation,
      actionKey: row.action_key, executionLeaseId: row.execution_lease_id, leaseExpiresAt: row.lease_expires_at };
  }

  async getNextImpactItem(runId: string): Promise<DurableDerivationImpactItem | null> {
    const row = await this.db.prepare(`SELECT r.id AS run_id,r.kind AS run_kind,r.cursor,r.item_count,r.status AS run_status,
      i.source_order,i.ref_kind,i.ref_id,i.classification,i.action,i.input_hash,i.status,i.generation,
      i.action_key,i.execution_lease_id,i.lease_expires_at
      FROM conversation_import_derivation_runs r
      LEFT JOIN conversation_import_derivation_impact_items i ON i.run_id=r.id AND i.source_order=r.cursor
      WHERE r.id=? LIMIT 1`).bind(runId).first<{
        run_id: string; run_kind: "delete" | "recompute"; cursor: number; item_count: number; run_status: string;
        source_order: number | null; ref_kind: DurableDerivationImpactItem["refKind"] | null; ref_id: string | null;
        classification: DurableDerivationImpactItem["classification"] | null; action: DurableDerivationImpactItem["action"] | null;
        input_hash: string | null; status: "pending" | "started" | "retry" | "attention" | null; generation: number | null;
        action_key: string | null; execution_lease_id: string | null; lease_expires_at: string | null;
      }>();
    if (!row) throw new ConversationImportDerivationConflictError("derivation_conflict");
    if (row.run_status === "ready" || row.cursor === row.item_count) return null;
    if (!["running", "retry", "partial"].includes(row.run_status) || row.source_order === null || !row.ref_kind
      || !row.ref_id || !row.classification || !row.action || !row.input_hash || !row.status || row.generation === null) {
      throw new ConversationImportDerivationConflictError("terminal_state_conflict");
    }
    const actionKey = await domainSeparatedHash("operia/conversation-import/impact-action/v1", [row.run_id, row.source_order, row.input_hash]);
    if (row.action_key && row.action_key !== actionKey) throw new ConversationImportDerivationConflictError("terminal_state_conflict");
    return {
      runId: row.run_id,
      runKind: row.run_kind,
      sourceOrder: row.source_order,
      refKind: row.ref_kind,
      refId: row.ref_id,
      classification: row.classification,
      action: row.action,
      inputHash: row.input_hash,
      status: row.status,
      generation: row.generation,
      actionKey,
      executionLeaseId: row.execution_lease_id,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  private async markImpactOutcome(input: { runId: string; expectedCursor: number; expectedGeneration: number;
    actionKey: string; executionLeaseId: string; errorCode: string; now: string; outcome: "retry" | "attention";
  }): Promise<boolean> {
    try {
      const results = await this.db.batch([
        this.db.prepare(`UPDATE conversation_import_derivation_impact_items
          SET status=?,generation=generation+1,execution_lease_id=NULL,lease_expires_at=NULL,error_code=?,updated_at=?
          WHERE run_id=? AND source_order=? AND generation=? AND status='started' AND action_key=? AND execution_lease_id=?
            AND EXISTS (SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_graphs g
              ON g.frozen_run_id=r.id AND g.import_batch_id=r.import_batch_id WHERE r.id=? AND r.cursor=?
              AND r.status IN ('running','retry','partial') AND g.state IN ('delete_frozen','recompute_frozen'))`)
          .bind(input.outcome, input.errorCode, input.now, input.runId, input.expectedCursor, input.expectedGeneration,
            input.actionKey, input.executionLeaseId, input.runId, input.expectedCursor),
        this.db.prepare(`UPDATE conversation_import_derivation_runs
          SET status='partial',error_count=error_count+1,error_code=?,updated_at=?
          WHERE id=? AND cursor=? AND status IN ('running','retry','partial') AND EXISTS (
            SELECT 1 FROM conversation_import_derivation_impact_items WHERE run_id=? AND source_order=?
              AND status=? AND action_key=?)`)
          .bind(input.errorCode, input.now, input.runId, input.expectedCursor, input.runId,
            input.expectedCursor, input.outcome, input.actionKey),
        this.db.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs r JOIN conversation_import_derivation_impact_items i
            ON i.run_id=r.id AND i.source_order=? WHERE r.id=? AND r.cursor=? AND r.status='partial'
            AND i.status=? AND i.action_key=?
        ) THEN 1 ELSE abs(-9223372036854775808) END AS outcome_fence_ok`)
          .bind(input.expectedCursor, input.runId, input.expectedCursor, input.outcome, input.actionKey),
      ]);
      return changes(results[0]) === 1 && changes(results[1]) === 1;
    } catch {
      return false;
    }
  }

  async markImpactRetry(input: { runId: string; expectedCursor: number; expectedGeneration: number;
    actionKey: string; executionLeaseId: string; errorCode: string; now: string }): Promise<boolean> {
    return this.markImpactOutcome({ ...input, outcome: "retry" });
  }

  async markImpactAttention(input: { runId: string; expectedCursor: number; expectedGeneration: number;
    actionKey: string; executionLeaseId: string; errorCode: string; now: string }): Promise<boolean> {
    return this.markImpactOutcome({ ...input, outcome: "attention" });
  }

  async markRunPartial(input: { runId: string; expectedCursor: number; errorCode: string; now: string }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE conversation_import_derivation_runs
      SET status='partial',error_count=error_count+1,error_code=?,updated_at=? WHERE id=? AND cursor=? AND status IN ('running','retry','partial')`)
      .bind(input.errorCode, input.now, input.runId, input.expectedCursor).run();
    return changes(result) === 1;
  }

  async markRunReady(input: { runId: string; expectedCursor: number; now: string }): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE conversation_import_derivation_runs
        SET status='ready',error_code=NULL,completed_at=?,updated_at=? WHERE id=? AND cursor=? AND item_count=? AND status IN ('running','retry','partial')`)
        .bind(input.now, input.now, input.runId, input.expectedCursor, input.expectedCursor),
      this.db.prepare(`UPDATE conversation_import_derivation_graphs SET state='open',frozen_run_id=NULL,
        graph_revision=graph_revision+1,updated_at=? WHERE frozen_run_id=? AND EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs WHERE id=? AND status='ready')`)
        .bind(input.now, input.runId, input.runId),
    ]);
    return changes(results[0]) === 1 && changes(results[1]) === 1;
  }

  async finalizeRunIfComplete(runId: string, now: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE conversation_import_derivation_runs
        SET status='ready',error_code=NULL,completed_at=?,updated_at=?
        WHERE id=? AND cursor=item_count AND status IN ('running','retry','partial')`).bind(now, now, runId),
      this.db.prepare(`UPDATE conversation_import_derivation_graphs SET state='open',frozen_run_id=NULL,
        graph_revision=graph_revision+1,updated_at=? WHERE frozen_run_id=? AND EXISTS (
          SELECT 1 FROM conversation_import_derivation_runs WHERE id=? AND status='ready')`).bind(now, runId, runId),
    ]);
    if (changes(results[0]) === 1 && changes(results[1]) === 1) return true;
    const row = await this.db.prepare("SELECT status,cursor,item_count FROM conversation_import_derivation_runs WHERE id=?")
      .bind(runId).first<{ status: string; cursor: number; item_count: number }>();
    return row?.status === "ready" && row.cursor === row.item_count;
  }

  async recordEmbeddingIntent(input: {
    namespace: string; batchId: string; refKind: "summary" | "memory"; refId: string;
    operation: "write" | "delete"; model: string; dimensions: number; now: string; writeIntentId?: string;
  }): Promise<{ status: "inserted" | "reused"; id: string; vectorId: string; inputHash: string }> {
    if (input.dimensions !== 768) throw new Error("embedding_dimensions_invalid");
    await this.assertBatchDerivable(input.namespace, input.batchId);
    const storedWrite = input.operation === "delete" ? await this.db.prepare(`SELECT e.id,e.ref_kind,e.ref_id,e.vector_id,e.input_hash,
      e.embedding_model,e.embedding_dimensions,(SELECT COUNT(DISTINCT eb2.import_batch_id)
        FROM conversation_import_embedding_batches eb2 JOIN conversation_import_batches b2 ON b2.id=eb2.import_batch_id
        WHERE eb2.embedding_id=e.id AND b2.status!='deleted') AS support_count
      FROM conversation_import_embedding_ledger e
      JOIN conversation_import_embedding_batches eb ON eb.embedding_id=e.id
      WHERE e.id=? AND e.namespace=? AND eb.import_batch_id=? AND e.operation='write' AND e.status='ready'`)
      .bind(input.writeIntentId || "", input.namespace, input.batchId).first<{ id: string; ref_kind: "summary" | "memory";
        ref_id: string; vector_id: string; input_hash: string; embedding_model: string; embedding_dimensions: number; support_count: number }>() : null;
    if (input.operation === "delete" && (!storedWrite || storedWrite.ref_kind !== input.refKind || storedWrite.ref_id !== input.refId
      || storedWrite.embedding_model !== input.model || storedWrite.embedding_dimensions !== input.dimensions
      || Number(storedWrite.support_count) !== 1)) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    const ref = input.operation === "delete" ? null : input.refKind === "summary"
      ? await this.db.prepare(`SELECT l.output_hash AS content_hash FROM conversation_import_summaries s
          JOIN conversation_import_summary_lineage l ON l.summary_id=s.id
          JOIN conversation_import_summary_batches sb ON sb.summary_id=s.id
          WHERE s.id=? AND s.namespace=? AND sb.import_batch_id=? AND s.status='ready' LIMIT 1`)
          .bind(input.refId, input.namespace, input.batchId).first<{ content_hash: string }>()
      : await this.db.prepare(`SELECT m.content FROM memories m JOIN memory_provenance p ON p.memory_id=m.id
          WHERE m.id=? AND m.namespace=? AND p.import_batch_id=? LIMIT 1`)
          .bind(input.refId, input.namespace, input.batchId).first<{ content: string }>();
    if (input.operation === "write" && !ref) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const contentHash = ref && ("content_hash" in ref ? ref.content_hash : await sha256Hex(ref.content));
    const inputHash = storedWrite?.input_hash || await domainSeparatedHash("operia/conversation-import/embedding-input/v1", [
      input.namespace, input.refKind, input.refId, contentHash, input.model, input.dimensions,
    ]);
    const vectorId = storedWrite?.vector_id || `ci_vec_${(await domainSeparatedHash("operia/conversation-import/vector-id/v1", [
      input.namespace, input.refKind, input.refId, input.model, input.dimensions,
    ])).slice(0, 40)}`;
    const id = `ciemb_${input.operation}_${inputHash.slice(0, 32)}`;
    const existing = await this.db.prepare(`SELECT id,ref_kind,ref_id,source_write_id,embedding_dimensions FROM conversation_import_embedding_ledger
      WHERE namespace=? AND vector_id=? AND operation=? AND input_hash=? AND embedding_model=? LIMIT 1`)
      .bind(input.namespace, vectorId, input.operation, inputHash, input.model).first<{ id: string; ref_kind: string;
        ref_id: string; source_write_id: string | null; embedding_dimensions: number }>();
    if (existing && (existing.id !== id || existing.ref_kind !== input.refKind || existing.ref_id !== input.refId
      || existing.embedding_dimensions !== input.dimensions || existing.source_write_id !== (storedWrite?.id || null))) {
      throw new ConversationImportDerivationConflictError("derivation_conflict");
    }
    const existingLink = existing ? await this.db.prepare(`SELECT 1 AS linked FROM conversation_import_embedding_batches
      WHERE embedding_id=? AND import_batch_id=?`).bind(id, input.batchId).first<{ linked: number }>() : null;
    if (existingLink) return { status: "reused", id, vectorId, inputHash };
    const graph = await this.graphState(input.namespace, input.batchId);
    if (graph.state !== "open") throw new ConversationImportDerivationConflictError("derivation_conflict");
    const fence = this.graphMutation(input.namespace, input.batchId, graph.revision, input.now);
    const statements = [...fence.statements];
    if (!existing) statements.push(this.db.prepare(`INSERT INTO conversation_import_embedding_ledger
      (id,namespace,import_batch_id,ref_kind,ref_id,vector_id,operation,source_write_id,input_hash,embedding_model,
       embedding_dimensions,status,generation,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence.guard}`)
      .bind(id, input.namespace, input.batchId, input.refKind, input.refId, vectorId, input.operation,
        storedWrite?.id || null, inputHash, input.model, input.dimensions, "pending", 1, input.now, input.now,
        input.batchId, input.namespace, fence.nextRevision));
    statements.push(this.db.prepare(`INSERT INTO conversation_import_embedding_batches (embedding_id,import_batch_id,created_at)
      SELECT ?,?,? WHERE ${fence.guard}`).bind(id, input.batchId, input.now,
      input.batchId, input.namespace, fence.nextRevision));
    const results = await this.executeGraphBatch(statements);
    this.assertGraphMutation(results);
    if (changes(results[results.length - 1]) !== 1) throw new ConversationImportDerivationConflictError("derivation_conflict");
    return { status: existing ? "reused" : "inserted", id, vectorId, inputHash };
  }

  private async embeddingSupports(namespace: string, id: string): Promise<string[]> {
    const supports = await this.db.prepare(`SELECT eb.import_batch_id FROM conversation_import_embedding_batches eb
      JOIN conversation_import_batches b ON b.id=eb.import_batch_id AND b.namespace=? AND b.status IN ('archived','deriving','ready')
      WHERE eb.embedding_id=? ORDER BY eb.import_batch_id`).bind(namespace, id).all<{ import_batch_id: string }>();
    return (supports.results || []).map((support) => support.import_batch_id);
  }

  async claimEmbeddingExecution(input: { id: string; expectedGeneration: number; executionLeaseId: string;
    now: string; leaseExpiresAt: string }): Promise<"acquired" | "resumed" | "busy" | "attention" | "terminal"> {
    const identity = await this.db.prepare(`SELECT namespace,status,generation,execution_lease_id,lease_expires_at
      FROM conversation_import_embedding_ledger WHERE id=?`).bind(input.id).first<{
        namespace: string; status: string; generation: number; execution_lease_id: string | null; lease_expires_at: string | null;
      }>();
    if (!identity) throw new ConversationImportDerivationConflictError("derivation_conflict");
    if (["ready", "deleted", "failed"].includes(identity.status)) return "terminal";
    if (identity.status === "attention") return "attention";
    const resumed = identity.status === "started";
    if (resumed && (identity.generation !== input.expectedGeneration
      || identity.execution_lease_id !== input.executionLeaseId)) return "busy";
    if (resumed && identity.lease_expires_at && identity.lease_expires_at > input.now) return "busy";
    if (!resumed && (!['pending', 'retry'].includes(identity.status) || identity.generation !== input.expectedGeneration)) return "busy";
    const supportIds = await this.embeddingSupports(identity.namespace, input.id);
    if (!supportIds.length) throw new ConversationImportDerivationConflictError("derivation_conflict");
    const graphFences: Array<ReturnType<D1ConversationImportDerivationLedger["graphMutation"]>> = [];
    for (const batchId of supportIds) {
      const graph = await this.graphState(identity.namespace, batchId);
      if (graph.state !== "open") return "busy";
      graphFences.push(this.graphMutation(identity.namespace, batchId, graph.revision, input.now));
    }
    const oldExpiry = identity.lease_expires_at;
    const update = resumed
      ? this.db.prepare(`UPDATE conversation_import_embedding_ledger SET lease_expires_at=?,updated_at=?
          WHERE id=? AND status='started' AND generation=? AND execution_lease_id=? AND lease_expires_at=?`)
        .bind(input.leaseExpiresAt, input.now, input.id, input.expectedGeneration, input.executionLeaseId, oldExpiry)
      : this.db.prepare(`UPDATE conversation_import_embedding_ledger
          SET status='started',execution_lease_id=?,lease_expires_at=?,error_code=NULL,updated_at=?
          WHERE id=? AND generation=? AND status IN ('pending','retry')`)
        .bind(input.executionLeaseId, input.leaseExpiresAt, input.now, input.id, input.expectedGeneration);
    let results: D1Result[];
    try {
      results = await this.executeGraphBatch([...graphFences.flatMap((fence) => fence.statements), update,
        this.db.prepare(`SELECT CASE WHEN EXISTS (
          SELECT 1 FROM conversation_import_embedding_ledger WHERE id=? AND status='started' AND generation=?
            AND execution_lease_id=? AND lease_expires_at=?
        ) THEN 1 ELSE abs(-9223372036854775808) END AS embedding_lease_fence_ok`)
          .bind(input.id, input.expectedGeneration, input.executionLeaseId, input.leaseExpiresAt)]);
    } catch {
      return "busy";
    }
    graphFences.forEach((_fence, index) => this.assertGraphMutation(results, index * 3 + 1));
    if (changes(results[results.length - 2]) !== 1) return "busy";
    return resumed ? "resumed" : "acquired";
  }

  async markEmbeddingReady(input: { id: string; expectedGeneration: number; executionLeaseId: string;
    status: "ready" | "deleted"; now: string }): Promise<boolean> {
    const identity = await this.db.prepare(`SELECT namespace,import_batch_id,operation,status,generation,execution_lease_id
      FROM conversation_import_embedding_ledger WHERE id=?`)
      .bind(input.id).first<{ namespace: string; import_batch_id: string; operation: "write" | "delete";
        status: string; generation: number; execution_lease_id: string | null }>();
    if (!identity || identity.status !== "started" || identity.generation !== input.expectedGeneration
      || identity.execution_lease_id !== input.executionLeaseId
      || (identity.operation === "write" ? input.status !== "ready" : input.status !== "deleted")) return false;
    const supports = await this.embeddingSupports(identity.namespace, input.id);
    if (!supports.length) return false;
    const graphFences: Array<ReturnType<D1ConversationImportDerivationLedger["graphMutation"]>> = [];
    for (const batchId of supports) {
      const graph = await this.graphState(identity.namespace, batchId);
      if (graph.state !== "open") return false;
      graphFences.push(this.graphMutation(identity.namespace, batchId, graph.revision, input.now));
    }
    const fenceStatements = graphFences.flatMap((fence) => fence.statements);
    const results = await this.executeGraphBatch([...fenceStatements, this.db.prepare(`UPDATE conversation_import_embedding_ledger
      SET status=?,generation=generation+1,execution_lease_id=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND generation=? AND status='started' AND execution_lease_id=?
        AND ((operation='write' AND ?='ready') OR (operation='delete' AND ?='deleted'))`)
      .bind(input.status, input.now, input.id, input.expectedGeneration, input.executionLeaseId, input.status, input.status)]);
    graphFences.forEach((_fence, index) => this.assertGraphMutation(results, index * 3 + 1));
    return changes(results[results.length - 1]) === 1;
  }

  async getEmbeddingIntent(id: string): Promise<{
    operation: "write" | "delete";
    status: "pending" | "started" | "retry" | "ready" | "deleted" | "attention";
    generation: number;
    batchId: string;
    executionLeaseId: string | null;
    leaseExpiresAt: string | null;
    manifest: ImportVectorManifest;
  }> {
    const row = await this.db.prepare(`SELECT namespace,import_batch_id,ref_kind,ref_id,vector_id,operation,input_hash,
      embedding_model,embedding_dimensions,status,generation,execution_lease_id,lease_expires_at
      FROM conversation_import_embedding_ledger WHERE id=?`)
      .bind(id).first<{ namespace: string; import_batch_id: string; ref_kind: "summary" | "memory"; ref_id: string;
        vector_id: string; operation: "write" | "delete"; input_hash: string; embedding_model: string;
        embedding_dimensions: 768; status: "pending" | "started" | "retry" | "ready" | "deleted" | "attention";
        generation: number; execution_lease_id: string | null; lease_expires_at: string | null }>();
    if (!row) throw new ConversationImportDerivationConflictError("derivation_conflict");
    return {
      operation: row.operation,
      status: row.status,
      generation: row.generation,
      batchId: row.import_batch_id,
      executionLeaseId: row.execution_lease_id,
      leaseExpiresAt: row.lease_expires_at,
      manifest: {
        namespace: row.namespace,
        vectorId: row.vector_id,
        refKind: row.ref_kind,
        refId: row.ref_id,
        inputHash: row.input_hash,
        model: row.embedding_model,
        dimensions: row.embedding_dimensions,
      },
    };
  }

  async markEmbeddingAttention(input: { id: string; expectedGeneration: number; executionLeaseId: string;
    errorCode: string; now: string }): Promise<boolean> {
    const identity = await this.db.prepare(`SELECT namespace,status,generation,execution_lease_id
      FROM conversation_import_embedding_ledger WHERE id=?`).bind(input.id).first<{
        namespace: string; status: string; generation: number; execution_lease_id: string | null;
      }>();
    if (!identity || identity.status !== "started" || identity.generation !== input.expectedGeneration
      || identity.execution_lease_id !== input.executionLeaseId) return false;
    const supports = await this.embeddingSupports(identity.namespace, input.id);
    if (!supports.length) return false;
    const holder = `embedding:${input.id}`;
    const statements: D1PreparedStatement[] = [];
    for (const batchId of supports) {
      const graph = await this.graphState(identity.namespace, batchId);
      if (graph.state !== "open") return false;
      const nextRevision = graph.revision + 1;
      statements.push(
        this.db.prepare(`UPDATE conversation_import_derivation_graphs
          SET graph_revision=?,state='embedding_attention_frozen',frozen_run_id=?,updated_at=?
          WHERE import_batch_id=? AND namespace=? AND graph_revision=? AND state='open' AND frozen_run_id IS NULL`)
          .bind(nextRevision, holder, input.now, batchId, identity.namespace, graph.revision),
        this.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM conversation_import_derivation_graphs
          WHERE import_batch_id=? AND namespace=? AND graph_revision=? AND state='embedding_attention_frozen'
            AND frozen_run_id=?) THEN 1 ELSE abs(-9223372036854775808) END AS attention_graph_fence_ok`)
          .bind(batchId, identity.namespace, nextRevision, holder),
      );
    }
    statements.push(this.db.prepare(`UPDATE conversation_import_embedding_ledger
      SET status='attention',generation=generation+1,execution_lease_id=NULL,lease_expires_at=NULL,error_code=?,updated_at=?
      WHERE id=? AND generation=? AND status='started' AND execution_lease_id=?`)
      .bind(input.errorCode, input.now, input.id, input.expectedGeneration, input.executionLeaseId));
    statements.push(this.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM conversation_import_embedding_ledger
      WHERE id=? AND status='attention' AND generation=? AND execution_lease_id IS NULL)
      THEN 1 ELSE abs(-9223372036854775808) END AS embedding_attention_fence_ok`)
      .bind(input.id, input.expectedGeneration + 1));
    try {
      const results = await this.db.batch(statements);
      return supports.every((_batchId, index) => changes(results[index * 2]) === 1)
        && changes(results[results.length - 2]) === 1;
    } catch {
      return false;
    }
  }

  async markEmbeddingRetry(input: { id: string; expectedGeneration: number; executionLeaseId: string;
    errorCode: string; now: string }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE conversation_import_embedding_ledger
      SET status='retry',generation=generation+1,execution_lease_id=NULL,lease_expires_at=NULL,error_code=?,updated_at=?
      WHERE id=? AND generation=? AND status='started' AND execution_lease_id=?`)
      .bind(input.errorCode, input.now, input.id, input.expectedGeneration, input.executionLeaseId).run();
    return changes(result) === 1;
  }

  async recordAttention(input: { batchId: string; action: string; counts: Record<string, number | string>; now: string }): Promise<void> {
    await this.db.prepare(`INSERT INTO conversation_import_events
      (id,actor_kind,actor_hash,action,batch_id,status,count_metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(`cie_${crypto.randomUUID()}`, "system", "conversation-import-derivation", input.action, input.batchId,
        "attention", canonicalJson(input.counts), input.now).run();
  }
}
