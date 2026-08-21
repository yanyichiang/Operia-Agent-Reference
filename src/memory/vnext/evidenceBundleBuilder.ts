import { canonicalJson } from "../import/hashes";
import {
  memoryArtifactHash,
  utf8ByteLength,
  utf8Slice,
  utf8SpanHash,
} from "./integrity";

export const MEMORY_VNEXT_EVIDENCE_BUNDLE_VERSION = "memory-evidence-bundle-v2.0.0";

export type EvidenceBundleRelation = "SUPPORTS" | "CONFIRMS" | "CONTRADICTS" | "QUALIFIES";

export type EvidenceBundleFragment = {
  evidenceRefId: string;
  canonicalEventId: string;
  contentRevision: number;
  byteStart: number;
  byteEnd: number;
  spanHash: string;
  relation: EvidenceBundleRelation;
  structuralRole: "evidence" | "question" | "answer" | "tool_result" | "authority_attestation" | "context";
  actorClass: string;
  occurredAtUtc: string;
  content: string;
  fragmentHash: string;
};

export type EvidenceBundle = {
  evidenceBundleId: string;
  claimAtomId: string;
  factRevisionId: string;
  sourceRevision: number;
  supportEdgeIds: string[];
  materialContradictionEdgeIds: string[];
  qualificationEdgeIds: string[];
  revisionRelationIds: string[];
  structuralContextRefs: string[];
  fragments: EvidenceBundleFragment[];
  content: string;
  totalBytes: number;
  estimatedTokens: number;
  completeness: "complete" | "incomplete";
  incompletenessCodes: string[];
  bundleVersion: string;
  bundleHash: string;
};

type EdgeRow = {
  fact_revision_id: string;
  interpretation_id: string;
  lineage_id: string;
  support_group_id: string | null;
  relation: EvidenceBundleRelation;
  material: number;
  edge_txn_from_seq: number;
  edge_txn_to_seq: number | null;
  evidence_ref_id: string;
};

type RefRow = {
  evidence_ref_id: string;
  canonical_event_id: string;
  conversation_id: string;
  actor_class: string;
  occurred_at_utc: string;
  content_revision: number;
  byte_start: number | null;
  byte_end: number | null;
  sensitivity: "normal" | "secret";
  span_hash: string | null;
  content: string | null;
};

type SupportGroupRow = {
  support_group_id: string;
  mode: "ALL_REQUIRED" | "ANY_SUFFICIENT";
  interpretation_id: string;
  ordinal: number;
};

type CompositeRow = {
  evidence_unit_id: string;
  question_evidence_ref_id: string;
  answer_evidence_ref_id: string;
  strong_owner_authority: number;
};

type ToolRow = {
  evidence_unit_id: string;
  tool_result_evidence_ref_id: string;
  authority_attestation_evidence_ref_id: string;
};

type StructuralRow = {
  structural_edge_id: string;
  from_evidence_ref_id: string;
  to_evidence_ref_id: string;
  edge_kind: string;
  edge_ordinal: number;
};

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function edgeId(edge: EdgeRow): string {
  return [edge.fact_revision_id,edge.interpretation_id,edge.lineage_id,edge.edge_txn_from_seq].join(":");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

async function readRefs(db: D1Database, ids: readonly string[]): Promise<Map<string,RefRow>> {
  const refs = uniqueSorted(ids);
  if (refs.length === 0) return new Map();
  const result = await db.prepare(`SELECT r.evidence_ref_id,r.canonical_event_id,r.conversation_id,r.actor_class,
      r.occurred_at_utc,r.content_revision,r.byte_start,r.byte_end,r.sensitivity,m.span_hash,msg.content
    FROM memory_evidence_refs r
    LEFT JOIN memory_evidence_ref_v2_metadata m ON m.evidence_ref_id=r.evidence_ref_id
    LEFT JOIN messages msg ON msg.id=r.canonical_event_id
    WHERE r.evidence_ref_id IN (${placeholders(refs.length)})`)
    .bind(...refs).all<RefRow>();
  return new Map((result.results ?? []).map((row) => [row.evidence_ref_id,row]));
}

async function readExcludedTargets(
  db: D1Database,
  txnSnapshotSeq: number,
  factRevisionId: string,
  refs: readonly RefRow[],
): Promise<Set<string>> {
  const targets = uniqueSorted([
    factRevisionId,
    ...refs.map((row) => row.evidence_ref_id),
    ...refs.map((row) => row.canonical_event_id),
  ]);
  if (targets.length === 0) return new Set();
  const result = await db.prepare(`SELECT target_id FROM memory_retrieval_exclusions
    WHERE target_id IN (${placeholders(targets.length)})
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)`)
    .bind(...targets,txnSnapshotSeq,txnSnapshotSeq).all<{ target_id: string }>();
  return new Set((result.results ?? []).map((row) => row.target_id));
}

async function fragmentFromRef(input: {
  ref: RefRow | undefined;
  relation: EvidenceBundleRelation;
  structuralRole: EvidenceBundleFragment["structuralRole"];
  excludedTargets: ReadonlySet<string>;
}): Promise<{ fragment: EvidenceBundleFragment | null; code: string | null }> {
  const ref = input.ref;
  if (!ref) return { fragment: null,code: "EVIDENCE_REF_MISSING" };
  if (input.excludedTargets.has(ref.evidence_ref_id) || input.excludedTargets.has(ref.canonical_event_id)) {
    return { fragment: null,code: "EVIDENCE_RETRIEVAL_EXCLUDED" };
  }
  if (ref.sensitivity !== "normal") return { fragment: null,code: "EVIDENCE_PRIVACY_BOUNDARY" };
  if (ref.content === null) return { fragment: null,code: "CANONICAL_CONTENT_MISSING" };
  if (ref.byte_start === null || ref.byte_end === null || !ref.span_hash) {
    return { fragment: null,code: "PRECISE_SPAN_REQUIRED" };
  }
  let content: string;
  let expectedHash: string;
  try {
    content = utf8Slice(ref.content,Number(ref.byte_start),Number(ref.byte_end));
    expectedHash = await utf8SpanHash({
      canonicalEventId: ref.canonical_event_id,
      contentRevision: Number(ref.content_revision),
      content: ref.content,
      byteStart: Number(ref.byte_start),
      byteEnd: Number(ref.byte_end),
    });
  } catch {
    return { fragment: null,code: "EVIDENCE_SPAN_INVALID" };
  }
  if (expectedHash !== ref.span_hash) return { fragment: null,code: "EVIDENCE_SPAN_HASH_MISMATCH" };
  const body = {
    evidenceRefId: ref.evidence_ref_id,
    canonicalEventId: ref.canonical_event_id,
    contentRevision: Number(ref.content_revision),
    byteStart: Number(ref.byte_start),
    byteEnd: Number(ref.byte_end),
    spanHash: ref.span_hash,
    relation: input.relation,
    structuralRole: input.structuralRole,
    actorClass: ref.actor_class,
    occurredAtUtc: ref.occurred_at_utc,
    content,
  };
  return {
    fragment: {
      ...body,
      fragmentHash: await memoryArtifactHash("memory-evidence-bundle-fragment-v2",body),
    },
    code: null,
  };
}

function renderBundleContent(fragments: readonly EvidenceBundleFragment[]): string {
  return fragments.map((fragment) => {
    const relation = fragment.relation === "SUPPORTS" || fragment.relation === "CONFIRMS"
      ? "O" : fragment.relation === "CONTRADICTS" ? "X" : "Q";
    return `[${relation}][${fragment.structuralRole}] ${fragment.content}`;
  }).join("\n");
}

export async function buildEvidenceBundle(input: {
  db: D1Database;
  factRevisionId: string;
  txnSnapshotSeq: number;
}): Promise<EvidenceBundle> {
  if (!input.factRevisionId.trim()) throw new Error("memory_evidence_bundle_fact_required");
  if (!Number.isSafeInteger(input.txnSnapshotSeq) || input.txnSnapshotSeq < 1) {
    throw new Error("memory_evidence_bundle_txn_invalid");
  }
  const fact = await input.db.prepare(`SELECT f.fact_revision_id,f.revision,m.claim_atom_id
    FROM memory_fact_revisions f
    LEFT JOIN memory_fact_revision_claim_atoms m ON m.fact_revision_id=f.fact_revision_id
    WHERE f.fact_revision_id=? AND f.txn_from_seq<=? AND (f.txn_to_seq IS NULL OR ?<f.txn_to_seq)`)
    .bind(input.factRevisionId,input.txnSnapshotSeq,input.txnSnapshotSeq)
    .first<{ fact_revision_id: string; revision: number; claim_atom_id: string | null }>();
  const incompletenessCodes: string[] = [];
  if (!fact?.claim_atom_id) incompletenessCodes.push("CLAIM_ATOM_MAPPING_MISSING");

  const edgeResult = await input.db.prepare(`SELECT e.fact_revision_id,e.interpretation_id,e.lineage_id,e.support_group_id,
      e.relation,e.material,e.edge_txn_from_seq,e.edge_txn_to_seq,i.evidence_ref_id
    FROM memory_fact_revision_evidence e
    JOIN memory_evidence_interpretations i ON i.interpretation_id=e.interpretation_id
    WHERE e.fact_revision_id=? AND e.edge_txn_from_seq<=?
      AND (e.edge_txn_to_seq IS NULL OR ?<e.edge_txn_to_seq)
    ORDER BY e.relation,e.support_group_id,e.interpretation_id,e.lineage_id`)
    .bind(input.factRevisionId,input.txnSnapshotSeq,input.txnSnapshotSeq).all<EdgeRow>();
  const edges = edgeResult.results ?? [];
  const positiveEdges = edges.filter((edge) => edge.relation === "SUPPORTS" || edge.relation === "CONFIRMS");
  const negativeEdges = edges.filter((edge) => edge.relation === "CONTRADICTS" && Number(edge.material) === 1);
  const qualificationEdges = edges.filter((edge) => edge.relation === "QUALIFIES" && Number(edge.material) === 1);
  if (positiveEdges.length === 0) incompletenessCodes.push("SUFFICIENT_SUPPORT_PATH_MISSING");

  const baseRefIds = uniqueSorted(edges.map((edge) => edge.evidence_ref_id));
  let allRefs = await readRefs(input.db,baseRefIds);
  const compositeResult = baseRefIds.length === 0 ? { results: [] as CompositeRow[] } : await input.db.prepare(
    `SELECT evidence_unit_id,question_evidence_ref_id,answer_evidence_ref_id,strong_owner_authority
     FROM memory_composite_confirmation_units
     WHERE answer_evidence_ref_id IN (${placeholders(baseRefIds.length)})`,
  ).bind(...baseRefIds).all<CompositeRow>();
  const toolResult = baseRefIds.length === 0 ? { results: [] as ToolRow[] } : await input.db.prepare(
    `SELECT evidence_unit_id,tool_result_evidence_ref_id,authority_attestation_evidence_ref_id
     FROM memory_scoped_tool_observation_units
     WHERE tool_result_evidence_ref_id IN (${placeholders(baseRefIds.length)})
        OR authority_attestation_evidence_ref_id IN (${placeholders(baseRefIds.length)})`,
  ).bind(...baseRefIds,...baseRefIds).all<ToolRow>();
  const composites = compositeResult.results ?? [];
  const tools = toolResult.results ?? [];
  const memberRefIds = uniqueSorted([
    ...baseRefIds,
    ...composites.flatMap((row) => [row.question_evidence_ref_id,row.answer_evidence_ref_id]),
    ...tools.flatMap((row) => [row.tool_result_evidence_ref_id,row.authority_attestation_evidence_ref_id]),
  ]);
  allRefs = await readRefs(input.db,memberRefIds);
  const structuralResult = memberRefIds.length === 0 ? { results: [] as StructuralRow[] } : await input.db.prepare(
    `SELECT structural_edge_id,from_evidence_ref_id,to_evidence_ref_id,edge_kind,edge_ordinal
     FROM memory_evidence_structural_edges
     WHERE from_evidence_ref_id IN (${placeholders(memberRefIds.length)})
       AND to_evidence_ref_id IN (${placeholders(memberRefIds.length)})
     ORDER BY edge_ordinal,structural_edge_id`,
  ).bind(...memberRefIds,...memberRefIds).all<StructuralRow>();
  const structuralEdges = structuralResult.results ?? [];
  const excludedTargets = await readExcludedTargets(input.db,input.txnSnapshotSeq,input.factRevisionId,[...allRefs.values()]);
  if (excludedTargets.has(input.factRevisionId)) incompletenessCodes.push("FACT_RETRIEVAL_EXCLUDED");

  const compositeByAnswer = new Map(composites.map((row) => [row.answer_evidence_ref_id,row]));
  const toolByMember = new Map<string,ToolRow>();
  tools.forEach((row) => {
    toolByMember.set(row.tool_result_evidence_ref_id,row);
    toolByMember.set(row.authority_attestation_evidence_ref_id,row);
  });
  const structuralContextRefs = new Set<string>();

  const resolveEdge = async (edge: EdgeRow): Promise<{ fragments: EvidenceBundleFragment[]; codes: string[] }> => {
    const fragments: EvidenceBundleFragment[] = [];
    const codes: string[] = [];
    const composite = compositeByAnswer.get(edge.evidence_ref_id);
    const tool = toolByMember.get(edge.evidence_ref_id);
    const members: Array<{ id: string; role: EvidenceBundleFragment["structuralRole"] }> = composite
      ? [
        { id: composite.question_evidence_ref_id,role: "question" },
        { id: composite.answer_evidence_ref_id,role: "answer" },
      ]
      : tool ? [
        { id: tool.tool_result_evidence_ref_id,role: "tool_result" },
        { id: tool.authority_attestation_evidence_ref_id,role: "authority_attestation" },
      ] : [{ id: edge.evidence_ref_id,role: "evidence" }];
    if (composite && Number(composite.strong_owner_authority) !== 1) codes.push("COMPOSITE_AUTHORITY_INCOMPLETE");
    for (const member of members) {
      const result = await fragmentFromRef({
        ref: allRefs.get(member.id),relation: edge.relation,structuralRole: member.role,excludedTargets,
      });
      if (result.fragment) fragments.push(result.fragment);
      if (result.code) codes.push(result.code);
    }
    if (members.length > 1) {
      const expectedFrom = composite ? members[1].id : members[0].id;
      const expectedTo = composite ? members[0].id : members[1].id;
      const expectedKind = composite ? "QUESTION_ANSWER" : "TOOL_CALL_RESULT";
      const matching = structuralEdges.filter((item) => item.from_evidence_ref_id === expectedFrom
        && item.to_evidence_ref_id === expectedTo && item.edge_kind === expectedKind);
      if (matching.length === 0) codes.push("STRUCTURAL_BINDING_MISSING");
      matching.forEach((item) => structuralContextRefs.add(item.structural_edge_id));
    }
    return { fragments,codes: uniqueSorted(codes) };
  };

  const supportGroupIds = uniqueSorted(positiveEdges.flatMap((edge) => edge.support_group_id ? [edge.support_group_id] : []));
  const groupRows = supportGroupIds.length === 0 ? [] : (await input.db.prepare(
    `SELECT g.support_group_id,g.mode,m.interpretation_id,m.ordinal
     FROM memory_evidence_support_groups g
     JOIN memory_evidence_support_group_members m ON m.support_group_id=g.support_group_id
     WHERE g.support_group_id IN (${placeholders(supportGroupIds.length)})
     ORDER BY g.support_group_id,m.ordinal`,
  ).bind(...supportGroupIds).all<SupportGroupRow>()).results ?? [];
  const groupDefinitions = new Map<string,{ mode: SupportGroupRow["mode"]; members: SupportGroupRow[] }>();
  for (const row of groupRows) {
    const current = groupDefinitions.get(row.support_group_id) ?? { mode: row.mode,members: [] };
    current.members.push(row);
    groupDefinitions.set(row.support_group_id,current);
  }

  type ResolvedPath = { edgeIds: string[]; fragments: EvidenceBundleFragment[]; bytes: number; codes: string[] };
  const completePaths: ResolvedPath[] = [];
  for (const groupId of supportGroupIds) {
    const definition = groupDefinitions.get(groupId);
    if (!definition) continue;
    const activeByInterpretation = new Map(positiveEdges.filter((edge) => edge.support_group_id === groupId)
      .map((edge) => [edge.interpretation_id,edge]));
    const neededSets = definition.mode === "ALL_REQUIRED"
      ? [definition.members.map((member) => member.interpretation_id)]
      : definition.members.map((member) => [member.interpretation_id]);
    for (const needed of neededSets) {
      const pathEdges = needed.map((id) => activeByInterpretation.get(id));
      if (pathEdges.some((edge) => !edge)) continue;
      const resolved = await Promise.all(pathEdges.map((edge) => resolveEdge(edge!)));
      const codes = uniqueSorted(resolved.flatMap((item) => item.codes));
      const fragments = [...new Map(resolved.flatMap((item) => item.fragments)
        .map((fragment) => [fragment.fragmentHash,fragment])).values()];
      if (codes.length === 0 && fragments.length > 0) {
        completePaths.push({
          edgeIds: pathEdges.map((edge) => edgeId(edge!)).sort(),
          fragments,
          bytes: fragments.reduce((sum,fragment) => sum + utf8ByteLength(fragment.content),0),
          codes,
        });
      }
    }
  }
  completePaths.sort((left,right) => left.bytes - right.bytes
    || canonicalJson(left.edgeIds).localeCompare(canonicalJson(right.edgeIds)));
  const supportPath = completePaths[0];
  if (!supportPath && positiveEdges.length > 0) incompletenessCodes.push("SUFFICIENT_SUPPORT_PATH_INCOMPLETE");

  const materialResolved = await Promise.all([...negativeEdges,...qualificationEdges].map(async (edge) => ({
    edge,
    resolved: await resolveEdge(edge),
  })));
  for (const item of materialResolved) {
    if (item.resolved.codes.length > 0 || item.resolved.fragments.length === 0) {
      incompletenessCodes.push(item.edge.relation === "CONTRADICTS"
        ? "MATERIAL_CONTRADICTION_INCOMPLETE" : "MATERIAL_QUALIFICATION_INCOMPLETE");
    }
  }
  const revisionResult = await input.db.prepare(`SELECT relation_id FROM memory_fact_revision_relations
    WHERE (from_revision_id=? OR to_revision_id=?)
      AND txn_from_seq<=? AND (txn_to_seq IS NULL OR ?<txn_to_seq)
    ORDER BY relation_id`).bind(input.factRevisionId,input.factRevisionId,input.txnSnapshotSeq,input.txnSnapshotSeq)
    .all<{ relation_id: string }>();
  const fragments = [...new Map([
    ...(supportPath?.fragments ?? []),
    ...materialResolved.flatMap((item) => item.resolved.fragments),
  ].map((fragment) => [fragment.fragmentHash,fragment])).values()];
  const content = renderBundleContent(fragments);
  const completeness = incompletenessCodes.length === 0 && Boolean(fact?.claim_atom_id) && Boolean(supportPath)
    ? "complete" as const : "incomplete" as const;
  const body = {
    claimAtomId: fact?.claim_atom_id ?? `unmapped:${input.factRevisionId}`,
    factRevisionId: input.factRevisionId,
    sourceRevision: Number(fact?.revision ?? 0),
    supportEdgeIds: supportPath?.edgeIds ?? [],
    materialContradictionEdgeIds: negativeEdges.map(edgeId).sort(),
    qualificationEdgeIds: qualificationEdges.map(edgeId).sort(),
    revisionRelationIds: (revisionResult.results ?? []).map((row) => row.relation_id),
    structuralContextRefs: [...structuralContextRefs].sort(),
    fragments,
    content,
    totalBytes: utf8ByteLength(content),
    estimatedTokens: Math.ceil(utf8ByteLength(content) / 4),
    completeness,
    incompletenessCodes: uniqueSorted(incompletenessCodes),
    bundleVersion: MEMORY_VNEXT_EVIDENCE_BUNDLE_VERSION,
  };
  const bundleHash = await memoryArtifactHash("memory-evidence-bundle-v2",body);
  return { evidenceBundleId: `eb_${bundleHash.slice(0,32)}`,...body,bundleHash };
}

export async function persistEvidenceBundle(input: {
  db: D1Database;
  runId: string;
  bundle: EvidenceBundle;
  createdAtUtc: string;
}): Promise<void> {
  const b = input.bundle;
  const statements: D1PreparedStatement[] = [input.db.prepare(`INSERT OR IGNORE INTO memory_evidence_bundles_v2(
    evidence_bundle_id,run_id,claim_atom_id,fact_revision_id,source_revision,support_edge_ids_json,
    material_contradiction_edge_ids_json,qualification_edge_ids_json,revision_relation_ids_json,
    structural_context_refs_json,total_bytes,estimated_tokens,completeness,incompleteness_codes_json,
    bundle_version,bundle_hash,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    b.evidenceBundleId,input.runId,b.claimAtomId,b.factRevisionId,b.sourceRevision,canonicalJson(b.supportEdgeIds),
    canonicalJson(b.materialContradictionEdgeIds),canonicalJson(b.qualificationEdgeIds),canonicalJson(b.revisionRelationIds),
    canonicalJson(b.structuralContextRefs),b.totalBytes,b.estimatedTokens,b.completeness,canonicalJson(b.incompletenessCodes),
    b.bundleVersion,b.bundleHash,input.createdAtUtc,
  )];
  b.fragments.forEach((fragment,ordinal) => statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_evidence_bundle_fragments_v2(
    evidence_bundle_id,ordinal,evidence_ref_id,canonical_event_id,content_revision,byte_start,byte_end,span_hash,
    relation,structural_role,actor_class,occurred_at_utc,content_bytes,fragment_hash
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    b.evidenceBundleId,ordinal,fragment.evidenceRefId,fragment.canonicalEventId,fragment.contentRevision,
    fragment.byteStart,fragment.byteEnd,fragment.spanHash,fragment.relation,fragment.structuralRole,
    fragment.actorClass,fragment.occurredAtUtc,utf8ByteLength(fragment.content),fragment.fragmentHash,
  )));
  await input.db.batch(statements);
}
