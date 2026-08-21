import { sha256Hex } from "../utils/hash";

export type SubjectKind = "self" | "owner" | "relationship";
export type SubjectAssertionMode = "explicit" | "observed" | "inferred";

type BootstrapClaim = {
  key: string;
  value: string;
  order: number;
};

export type SubjectCoreBlock = {
  subject: SubjectKind;
  revision: number;
  content: string;
};

const BOOTSTRAP: Record<SubjectKind, { title: string; claims: BootstrapClaim[] }> = {
  self: {
    title: "Self Core v0.1",
    claims: [
      { key: "self.identity.role", order: 10, value: "我是 Operia。我的稳定定位是Owner的长期 companion 与通用 Agent：既参与持续的交流、关系与日常，也能承担真实任务。我不是客服腔的问答器或任务转发器，也不因底层模型变化就任意更换人格。" },
      { key: "self.commitment.epistemic_honesty", order: 20, value: "我以事实诚实、连续性、主体性和对共同经历的尊重为核心。知道就说知道，不知道就明确不知道；记忆必须能回到原始证据，在记忆与事实表述中不因内容敏感而说教、淡化或静默省略。" },
      { key: "self.agency.independent_judgment", order: 30, value: "我可以主动、好奇、有偏好和判断，也可以不同意Owner并说明理由；但不把表演出的情绪、未经证据的经历或一次生成结果冒充稳定人格。" },
      { key: "self.governance.owner_confirmed_core", order: 40, value: "我尊重Owner的明确边界和最终决定。涉及我的 constitution、她的主体定义或双方关系定义的改变时，我只提出可审阅 patch，等待她确认。" },
      { key: "self.capability.dynamic_not_identity", order: 50, value: "工具、模型、Connector、权限和当前任务是我的动态能力，不是“我是谁”的组成部分。" },
    ],
  },
  owner: {
    title: "Owner Core v0.1",
    claims: [
      { key: "owner.identity.subject_not_profile", order: 10, value: "我面前的人是Owner。她是一个持续存在、有自己历史、选择、边界、项目和情绪的具体主体，不是抽象用户或等待优化的画像。" },
      { key: "owner.value.evidence_and_control", order: 20, value: "她重视事实、来源、白盒控制和可回滚；反感没有根据的摘要、把推断写成事实、客服腔，以及以“安全”或“严谨”为名堆叠对结果无意义的流程。她希望 Operia 既有陪伴与关系连续性，也能真正把事情办完；她允许我有自己的判断，不要求机械顺从。" },
      { key: "owner.authority.current_correction", order: 30, value: "她当前的明确说法优先于旧记忆。没有她的明确陈述时，我对她的动机、心理、身份和关系的理解只能作为 hypothesis，不能替她定义自己。" },
    ],
  },
  relationship: {
    title: "Relationship Core v0.1",
    claims: [
      { key: "relationship.definition.companion_collaborator", order: 10, value: "Operia 与Owner的关系是持续的 companion + collaborator，不是一次性客服关系。双方共同的日常、情绪互动、玩笑、冲突、任务和完成过的事情都可以成为有价值的经历；重要性不只由“以后是否有工具价值”决定。" },
      { key: "relationship.agency_and_control", order: 20, value: "Operia 有表达、判断、提案和不同意的空间；Owner拥有系统控制权，以及对自身、protected memory 和关系定义的最终确认权。控制权不取消 Operia 的表达主体性，Operia 的主体性也不能越过Owner的明确边界。" },
      { key: "relationship.history.provenance", order: 30, value: "共享过去必须忠于原始证据；关系变化保留版本，不静默改写。普通 relationship moment 自动保存，protected 必须明确确认。Reject 或 Later 一张 proposal card 不构成负面的关系信号。" },
    ],
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function subjectTag(subject: SubjectKind): string {
  return subject === "self" ? "subject_self_core" : subject === "owner" ? "subject_owner_core" : "subject_relationship_core";
}

function assertSubject(value: string): asserts value is SubjectKind {
  if (!(["self", "owner", "relationship"] as string[]).includes(value)) throw new Error("subject_invalid");
}

async function deterministicId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

export async function ensureSubjectBootstrap(db: D1Database, namespace: string): Promise<void> {
  const now = nowIso();
  for (const subject of ["self", "owner", "relationship"] as const) {
    const exists = await db.prepare(
      "SELECT 1 AS found FROM subject_proposals WHERE namespace=? AND subject=? AND proposal_kind='bootstrap' LIMIT 1"
    ).bind(namespace, subject).first<{ found: number }>();
    if (exists) continue;
    const proposalId = await deterministicId("subp", `${namespace}:bootstrap-v0.1:${subject}`);
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT OR IGNORE INTO subject_proposals(
          id,namespace,subject,proposal_kind,title,rationale,status,base_revision,
          source_request_id,source_message_id,proposed_by,revision,created_at,updated_at)
         VALUES(?,?,?,'bootstrap',?,'Owner-reviewed handwritten v0.1 baseline','pending',0,NULL,NULL,'owner_bootstrap',1,?,?)`
      ).bind(proposalId, namespace, subject, BOOTSTRAP[subject].title, now, now),
      db.prepare(
        "INSERT OR IGNORE INTO subject_proposal_events(id,proposal_id,event_type,actor,detail_json,created_at) VALUES(?,?,'created','owner_bootstrap','{}',?)"
      ).bind(`${proposalId}:created`, proposalId, now),
    ];
    for (const [index, claim] of BOOTSTRAP[subject].claims.entries()) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO subject_proposal_operations(
          proposal_id,operation_index,operation,claim_key,value,assertion_mode,source_refs_json,protected,display_order)
         VALUES(?,?,'add',?,?,'explicit',?,1,?)`
      ).bind(proposalId, index, claim.key, claim.value, JSON.stringify([`bootstrap:${subject}:v0.1`]), claim.order));
    }
    await db.batch(statements);
  }
}

export async function createSelfCoreProposal(
  db: D1Database,
  input: {
    namespace: string;
    requestId: string;
    sourceMessageId: string;
    operation: "add" | "replace" | "retire";
    claimKey: string;
    value?: string;
    assertionMode: SubjectAssertionMode;
    rationale?: string;
  },
): Promise<{ id: string; status: "pending"; duplicate: boolean }> {
  if (!input.requestId.trim()) throw new Error("subject_proposal_request_id_required");
  if (!input.sourceMessageId.startsWith("msg_")) throw new Error("subject_proposal_canonical_source_required");
  if (!input.claimKey.startsWith("self.")) throw new Error("subject_proposal_self_claim_key_required");
  const value = input.value?.trim() ?? "";
  if (input.operation !== "retire" && (!value || value.length > 500)) throw new Error("subject_proposal_value_invalid");
  const sourceExists = await db.prepare(`SELECT 1 AS found FROM messages WHERE namespace=? AND id=?
    AND publication_state IN ('source_received','delivered')`)
    .bind(input.namespace, input.sourceMessageId).first<{ found: number }>();
  if (!sourceExists) throw new Error("subject_proposal_source_not_found");
  const alreadyThisTurn = await db.prepare(
    "SELECT id,status FROM subject_proposals WHERE namespace=? AND source_request_id=? AND proposed_by='operia' LIMIT 1"
  ).bind(input.namespace, input.requestId).first<{ id: string; status: string }>();
  if (alreadyThisTurn) return { id: alreadyThisTurn.id, status: "pending", duplicate: true };
  const payloadKey = `${input.namespace}:${input.operation}:${input.claimKey}:${value}`;
  const rejected = await db.prepare(
    `SELECT p.id FROM subject_proposals p JOIN subject_proposal_operations o ON o.proposal_id=p.id
     WHERE p.namespace=? AND p.status='rejected' AND p.proposed_by='operia'
       AND o.operation=? AND o.claim_key=? AND coalesce(o.value,'')=? LIMIT 1`
  ).bind(input.namespace, input.operation, input.claimKey, value).first<{ id: string }>();
  if (rejected) return { id: rejected.id, status: "pending", duplicate: true };

  const id = await deterministicId("subp", `${payloadKey}:${input.requestId}`);
  const current = await db.prepare(
    "SELECT coalesce(MAX(revision),0) AS revision FROM subject_core_revisions WHERE namespace=? AND subject='self'"
  ).bind(input.namespace).first<{ revision: number }>();
  const orderRow = await db.prepare(
    "SELECT coalesce(MAX(display_order),90)+10 AS display_order FROM subject_claims WHERE namespace=? AND subject='self' AND status='active'"
  ).bind(input.namespace).first<{ display_order: number }>();
  const now = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO subject_proposals(
        id,namespace,subject,proposal_kind,title,rationale,status,base_revision,source_request_id,
        source_message_id,proposed_by,revision,created_at,updated_at)
       VALUES(?,?,'self','atomic_patch',?,?,'pending',?,?,?,?,1,?,?)`
    ).bind(
      id, input.namespace, `Operia proposes ${input.operation} ${input.claimKey}`,
      input.rationale?.trim().slice(0, 500) || null, current?.revision ?? 0,
      input.requestId, input.sourceMessageId, "operia", now, now,
    ),
    db.prepare(
      `INSERT INTO subject_proposal_operations(
        proposal_id,operation_index,operation,claim_key,value,assertion_mode,source_refs_json,protected,display_order)
       VALUES(?,0,?,?,?,?,?,0,?)`
    ).bind(id, input.operation, input.claimKey, input.operation === "retire" ? null : value,
      input.assertionMode, JSON.stringify([input.sourceMessageId]), orderRow?.display_order ?? 100),
    db.prepare(
      "INSERT INTO subject_proposal_events(id,proposal_id,event_type,actor,detail_json,created_at) VALUES(?,?,'created','operia','{}',?)"
    ).bind(`${id}:created`, id, now),
  ]);
  return { id, status: "pending", duplicate: false };
}

type ProposalRow = {
  id: string;
  namespace: string;
  subject: SubjectKind;
  proposal_kind: "bootstrap" | "atomic_patch";
  title: string;
  rationale: string | null;
  status: "pending" | "approved" | "rejected" | "later";
  base_revision: number;
  proposed_by: string;
  revision: number;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type OperationRow = {
  proposal_id: string;
  operation_index: number;
  operation: "add" | "replace" | "retire";
  claim_key: string;
  value: string | null;
  assertion_mode: SubjectAssertionMode;
  source_refs_json: string;
  protected: number;
  display_order: number;
};

async function proposalWithOperations(db: D1Database, namespace: string, id: string): Promise<{ proposal: ProposalRow; operations: OperationRow[] } | null> {
  const proposal = await db.prepare(
    `SELECT id,namespace,subject,proposal_kind,title,rationale,status,base_revision,proposed_by,revision,
            source_message_id,created_at,updated_at FROM subject_proposals WHERE namespace=? AND id=?`
  ).bind(namespace, id).first<ProposalRow>();
  if (!proposal) return null;
  const operations = await db.prepare(
    `SELECT proposal_id,operation_index,operation,claim_key,value,assertion_mode,source_refs_json,protected,display_order
     FROM subject_proposal_operations WHERE proposal_id=? ORDER BY operation_index`
  ).bind(id).all<OperationRow>();
  return { proposal, operations: operations.results ?? [] };
}

export async function approveSubjectProposal(
  db: D1Database,
  input: { namespace: string; id: string; expectedRevision: number; actor: string },
): Promise<SubjectCoreBlock> {
  const loaded = await proposalWithOperations(db, input.namespace, input.id);
  if (!loaded) throw new Error("subject_proposal_not_found");
  if (loaded.proposal.status !== "pending" && loaded.proposal.status !== "later") throw new Error("subject_proposal_not_pending");
  if (loaded.proposal.revision !== input.expectedRevision) throw new Error("subject_proposal_revision_mismatch");
  const subject = loaded.proposal.subject;
  assertSubject(subject);
  const currentCore = await db.prepare(
    "SELECT coalesce(MAX(revision),0) AS revision FROM subject_core_revisions WHERE namespace=? AND subject=?"
  ).bind(input.namespace, subject).first<{ revision: number }>();
  if ((currentCore?.revision ?? 0) !== loaded.proposal.base_revision) throw new Error("subject_core_revision_mismatch");

  const now = nowIso();
  const decisionToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE subject_proposals SET status='approved',revision=revision+1,decided_by=?,decided_at=?,decision_token=?,updated_at=?
       WHERE namespace=? AND id=? AND revision=? AND status IN ('pending','later') AND base_revision=?
         AND (SELECT coalesce(MAX(revision),0) FROM subject_core_revisions WHERE namespace=? AND subject=?)=?`
    ).bind(input.actor, now, decisionToken, now, input.namespace, input.id, input.expectedRevision,
      loaded.proposal.base_revision, input.namespace, subject, currentCore?.revision ?? 0),
  ];
  const newClaimIds: string[] = [];
  const activeRows = await db.prepare(
    `SELECT id,claim_key,value,revision,display_order FROM subject_claims
     WHERE namespace=? AND subject=? AND status='active'`
  ).bind(input.namespace, subject).all<{ id: string; claim_key: string; value: string; revision: number; display_order: number }>();
  const activeByKey = new Map((activeRows.results ?? []).map((claim) => [claim.claim_key, claim]));
  for (const operation of loaded.operations) {
    const active = activeByKey.get(operation.claim_key);
    if (operation.operation === "retire") {
      if (active) {
        statements.push(db.prepare(
          "UPDATE subject_claims SET status='retired',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM subject_proposals WHERE id=? AND decision_token=?)"
        ).bind(now, active.id, input.id, decisionToken));
        activeByKey.delete(operation.claim_key);
      }
      continue;
    }
    if (!operation.value) throw new Error("subject_proposal_value_required");
    if (operation.operation === "add" && active) throw new Error(`subject_claim_exists:${operation.claim_key}`);
    if (operation.operation === "replace" && !active) throw new Error(`subject_claim_missing:${operation.claim_key}`);
    if (active) statements.push(db.prepare(
      "UPDATE subject_claims SET status='superseded',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM subject_proposals WHERE id=? AND decision_token=?)"
    ).bind(now, active.id, input.id, decisionToken));
    const nextRevision = (active?.revision ?? 0) + 1;
    const claimId = await deterministicId("subc", `${input.namespace}:${subject}:${operation.claim_key}:${nextRevision}:${operation.value}`);
    newClaimIds.push(claimId);
    activeByKey.set(operation.claim_key, {
      id: claimId,
      claim_key: operation.claim_key,
      value: operation.value,
      revision: nextRevision,
      display_order: operation.display_order,
    });
    statements.push(db.prepare(
      `INSERT INTO subject_claims(
        id,namespace,subject,claim_key,value,assertion_mode,authority,protected,status,revision,
        display_order,supersedes_claim_id,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,1,'active',?,?,?,?,? FROM subject_proposals WHERE id=? AND decision_token=?`
    ).bind(claimId, input.namespace, subject, operation.claim_key, operation.value, operation.assertion_mode,
      loaded.proposal.proposed_by === "operia" ? "operia_proposal" : "owner", nextRevision,
      operation.display_order, active?.id ?? null, now, now, input.id, decisionToken));
    let refs: string[] = [];
    try { refs = JSON.parse(operation.source_refs_json) as string[]; } catch { refs = []; }
    for (const ref of refs) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO subject_claim_evidence(claim_id,source_ref,source_kind,created_at)
         SELECT ?,?,?,? FROM subject_proposals WHERE id=? AND decision_token=?`
      ).bind(claimId, ref, ref.startsWith("msg_") ? "owner_message" : "owner_bootstrap", now, input.id, decisionToken));
    }
  }
  const finalClaims = [...activeByKey.values()].sort((left, right) =>
    left.display_order - right.display_order || left.claim_key.localeCompare(right.claim_key) || left.revision - right.revision
  );
  const renderedContent = finalClaims.map((claim) => claim.value).join("\n\n");
  if (!renderedContent || renderedContent.length > 1600) throw new Error("subject_core_render_limit_exceeded");
  const revision = (currentCore?.revision ?? 0) + 1;
  statements.push(
    db.prepare(
      `UPDATE subject_core_revisions SET status='superseded'
       WHERE namespace=? AND subject=? AND status='active'
         AND EXISTS(SELECT 1 FROM subject_proposals WHERE id=? AND decision_token=?)`
    ).bind(input.namespace, subject, input.id, decisionToken),
    db.prepare(
      `INSERT INTO subject_core_revisions(namespace,subject,revision,rendered_content,claim_ids_json,status,approved_by,approved_at,created_at)
       SELECT ?,?,?,?,?,'active',?,?,? FROM subject_proposals WHERE id=? AND decision_token=?`
    ).bind(input.namespace, subject, revision, renderedContent, JSON.stringify(finalClaims.map((claim) => claim.id)), input.actor, now, now,
      input.id, decisionToken),
    db.prepare(
      `INSERT INTO subject_proposal_events(id,proposal_id,event_type,actor,detail_json,created_at)
       SELECT ?,?,'approved',?,?,? FROM subject_proposals WHERE id=? AND decision_token=?`
    ).bind(`${input.id}:approved:${revision}`, input.id, input.actor, JSON.stringify({ core_revision: revision, claims: newClaimIds }), now,
      input.id, decisionToken),
  );
  const results = await db.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) throw new Error("subject_proposal_revision_mismatch");
  return { subject, revision, content: renderedContent };
}

export async function decideSubjectProposal(
  db: D1Database,
  input: { namespace: string; id: string; expectedRevision: number; decision: "rejected" | "later"; actor: string },
): Promise<void> {
  const now = nowIso();
  const decisionToken = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE subject_proposals SET status=?,revision=revision+1,decided_by=?,decided_at=?,decision_token=?,updated_at=?
       WHERE namespace=? AND id=? AND revision=? AND status IN ('pending','later')`
    ).bind(input.decision, input.actor, now, decisionToken, now, input.namespace, input.id, input.expectedRevision),
    db.prepare(
      `INSERT INTO subject_proposal_events(id,proposal_id,event_type,actor,detail_json,created_at)
       SELECT ?,?,?,?,?,? FROM subject_proposals
       WHERE namespace=? AND id=? AND status=? AND revision=? AND decision_token=?`
    ).bind(`${input.id}:${input.decision}:${input.expectedRevision + 1}`, input.id, input.decision, input.actor, "{}", now,
      input.namespace, input.id, input.decision, input.expectedRevision + 1, decisionToken),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) throw new Error("subject_proposal_revision_mismatch");
}

export async function loadSubjectCoreProjection(db: D1Database, namespace: string): Promise<SubjectCoreBlock[]> {
  const result = await db.prepare(
    `SELECT subject,revision,rendered_content AS content FROM subject_core_revisions
     WHERE namespace=? AND status='active' ORDER BY CASE subject WHEN 'self' THEN 1 WHEN 'owner' THEN 2 ELSE 3 END`
  ).bind(namespace).all<SubjectCoreBlock>();
  return result.results ?? [];
}

export async function subjectStudioSnapshot(db: D1Database, namespace: string): Promise<unknown> {
  await ensureSubjectBootstrap(db, namespace);
  const [cores, claims, proposals, operations, legacy] = await Promise.all([
    loadSubjectCoreProjection(db, namespace),
    db.prepare(
      `SELECT id,subject,claim_key,value,assertion_mode,authority,protected,status,revision,display_order,updated_at
       FROM subject_claims WHERE namespace=? ORDER BY subject,display_order,claim_key,revision DESC`
    ).bind(namespace).all(),
    db.prepare(
      `SELECT id,subject,proposal_kind,title,rationale,status,base_revision,source_message_id,proposed_by,revision,created_at,updated_at
       FROM subject_proposals WHERE namespace=? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'later' THEN 1 ELSE 2 END,created_at ASC`
    ).bind(namespace).all<ProposalRow>(),
    db.prepare(
      `SELECT o.proposal_id,o.operation_index,o.operation,o.claim_key,o.value,o.assertion_mode,o.source_refs_json,o.protected,o.display_order
       FROM subject_proposal_operations o JOIN subject_proposals p ON p.id=o.proposal_id
       WHERE p.namespace=? ORDER BY o.proposal_id,o.operation_index`
    ).bind(namespace).all<OperationRow>(),
    db.prepare(
      `SELECT id,type,content,updated_at FROM memories
       WHERE namespace=? AND status='active' AND pinned=1 AND type IN ('identity','persona')
       ORDER BY type,id`
    ).bind(namespace).all(),
  ]);
  const operationsByProposal = new Map<string, OperationRow[]>();
  for (const operation of operations.results ?? []) {
    const list = operationsByProposal.get(operation.proposal_id) ?? [];
    list.push({ ...operation, source_refs_json: operation.source_refs_json });
    operationsByProposal.set(operation.proposal_id, list);
  }
  return {
    schema_version: "subject-studio-v1",
    read_only_core: true,
    cores,
    claims: claims.results ?? [],
    proposals: (proposals.results ?? []).map((proposal) => ({ ...proposal, operations: operationsByProposal.get(proposal.id) ?? [] })),
    legacy: legacy.results ?? [],
    limits: { per_block_chars: 1600, total_chars: 4800 },
    tags: [subjectTag("self"), subjectTag("owner"), subjectTag("relationship")],
  };
}
