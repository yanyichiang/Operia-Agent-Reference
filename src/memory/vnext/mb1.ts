import type { DynamicMemoryCarriers } from "../../assembler/types";
import { sha256Hex } from "../../utils/hash";
import { canonicalJson } from "../import/hashes";
import type { DynamicRecallNeed } from "./contracts";
import type { EvidenceBundle,EvidenceBundleFragment } from "./evidenceBundleBuilder";
import type { QueryStateProjection } from "./gateDStateAlignment";
import { memoryArtifactHash,utf8ByteLength } from "./integrity";
import type { VNextReadPathResult } from "./vnext2ReadPath";

export const MEMORY_MB1_VERSION = "MB1";
export const MEMORY_MB1_RENDERER_VERSION = "memory-mb1-renderer-v1";

type Mb1Wire = unknown[];

export type Mb1Group = {
  groupHash: string;
  visibleToken: string;
  kind: "P" | "T" | "D" | "X" | "C";
  candidateRefs: string[];
  claimRevisions: string[];
  wire: Mb1Wire;
  estimatedTokens: number;
};

export type Mb1Packet = {
  need: "O" | "R";
  view: "C" | "H" | "D" | "U";
  status: "OK" | "MISS";
  missDomain: string | null;
  groups: Mb1Group[];
  omittedGroupHashes: string[];
  payload: string;
  rendered: string;
  packetHash: string;
  totalBytes: number;
  estimatedTokens: number;
};

export type OwnerModelHint = {
  content: string;
  snapshotId: string;
  dimensionRevisionIds: string[];
};

export type PointContext = {
  content: string;
  pointRevisionIds: string[];
};

export function unsupportedSelectedMb1Lanes(
  result: VNextReadPathResult,
): VNextReadPathResult["candidates"][number]["sourceLane"][] {
  return [...new Set(result.candidates
    .filter((item) => item.selected && item.sourceLane !== "fact_revision")
    .map((item) => item.sourceLane))].sort();
}

function requireSelectedMb1LaneCoverage(result: VNextReadPathResult): void {
  const unsupported = unsupportedSelectedMb1Lanes(result);
  if (unsupported.length > 0) {
    throw new Error(`memory_mb1_selected_lane_unsupported:${unsupported.join(",")}`);
  }
}

export async function loadOwnerModelHint(
  db: D1Database,
  input: { maxBytes: number },
): Promise<OwnerModelHint | null> {
  const row = await db.prepare(`SELECT r.snapshot_id,r.content
    FROM memory_owner_portrait_renders r
    JOIN memory_owner_model_snapshots s ON s.snapshot_id=r.snapshot_id
    WHERE r.source_type='interpretation_only' AND r.evidence_eligible=0
    ORDER BY s.snapshot_ordinal DESC,r.created_at DESC LIMIT 1`)
    .first<{ snapshot_id: string; content: string }>();
  if (!row?.content.trim() || utf8ByteLength(row.content.trim()) > input.maxBytes) return null;
  const members = await db.prepare(`SELECT dimension_revision_id FROM memory_owner_model_snapshot_members
    WHERE snapshot_id=? AND member_role='active' ORDER BY ordinal`).bind(row.snapshot_id)
    .all<{ dimension_revision_id: string }>();
  return {
    content: row.content.trim(),snapshotId: row.snapshot_id,
    dimensionRevisionIds: (members.results ?? []).map((item) => item.dimension_revision_id),
  };
}

function needCode(need: DynamicRecallNeed): "O" | "R" {
  return need === "REQUIRED" ? "R" : "O";
}

function viewCode(view: VNextReadPathResult["requestedStateView"]): "C" | "H" | "D" | "U" {
  return view === "current" ? "C" : view === "historical" ? "H" : view === "change" ? "D" : "U";
}

function sourceCode(fragment: EvidenceBundleFragment): "O" | "T" | "X" | "Q" {
  if (fragment.relation === "CONTRADICTS") return "X";
  if (fragment.relation === "QUALIFIES") return "Q";
  return fragment.actorClass === "trusted_tool" ? "T" : "O";
}

function compactEvidence(bundle: EvidenceBundle): Mb1Wire[] {
  return bundle.fragments.map((fragment) => [sourceCode(fragment),fragment.content]);
}

function compactTime(input: {
  validFromUtc: string | null;
  validToUtc: string | null;
}): string | null {
  const from = input.validFromUtc?.slice(0,10) ?? "";
  const to = input.validToUtc?.slice(0,10) ?? "";
  if (!from && !to) return null;
  return `${from}/${to}`;
}

function stateWire(input: {
  result: VNextReadPathResult;
  candidateRef: string;
  projection: QueryStateProjection;
  bundle: EvidenceBundle;
}): Mb1Wire {
  const member = input.result.snapshot.members.find((item) => item.factRevisionId === input.candidateRef);
  if (!member) throw new Error("memory_mb1_snapshot_member_missing");
  const state = member.lifecycleStatus === "historical" ? "H" : "C";
  const time = compactTime(member);
  return [state,...(time ? [time] : []),member.claimAtom.predicate,member.claimAtom.valueJson,...compactEvidence(input.bundle)];
}

async function materializeGroup(input: {
  kind: Mb1Group["kind"];
  candidateRefs: string[];
  claimRevisions: string[];
  wireWithoutToken: Mb1Wire;
}): Promise<Mb1Group> {
  const body = {
    kind: input.kind,candidateRefs: [...input.candidateRefs].sort(),claimRevisions: [...input.claimRevisions].sort(),
    wire: input.wireWithoutToken,
  };
  const groupHash = await memoryArtifactHash("memory-mb1-group-v1",body);
  const visibleToken = groupHash.slice(0,16);
  const wire = [input.kind,visibleToken,...input.wireWithoutToken];
  return {
    groupHash,visibleToken,kind: input.kind,candidateRefs: [...input.candidateRefs],
    claimRevisions: [...input.claimRevisions],wire,estimatedTokens: Math.ceil(utf8ByteLength(canonicalJson(wire)) / 4),
  };
}

export async function buildMb1Groups(result: VNextReadPathResult): Promise<Mb1Group[]> {
  requireSelectedMb1LaneCoverage(result);
  const selectedFactRefs = new Set(result.candidates.filter((item) => item.selected && item.sourceLane === "fact_revision")
    .map((item) => item.candidateRef));
  const projectionByRef = new Map(result.projections.map((item) => [item.candidateRef,item]));
  const bundleByRef = new Map(result.evidenceBundles.filter((item) => item.completeness === "complete")
    .map((item) => [item.factRevisionId,item]));
  const grouped = new Set<string>();
  const atomicReserved = new Set<string>();
  const groups: Mb1Group[] = [];

  if (result.requestedStateView === "change") {
    for (const relation of [...result.snapshot.relations].sort((left,right) => left.relationId.localeCompare(right.relationId))) {
      const refs = [relation.fromRevisionId,relation.toRevisionId];
      if (refs.some((ref) => selectedFactRefs.has(ref))) {
        refs.filter((ref) => selectedFactRefs.has(ref)).forEach((ref) => atomicReserved.add(ref));
      }
      if (refs.some((ref) => !selectedFactRefs.has(ref) || !projectionByRef.has(ref) || !bundleByRef.has(ref))) continue;
      const states = refs.map((ref) => stateWire({
        result,candidateRef: ref,projection: projectionByRef.get(ref)!,bundle: bundleByRef.get(ref)!,
      }));
      const relationTime = states[1][1] && typeof states[1][1] === "string" && String(states[1][1]).includes("/")
        ? states[1][1] : null;
      groups.push(await materializeGroup({
        kind: "T",candidateRefs: refs,claimRevisions: refs.map((ref) => `${ref}:${bundleByRef.get(ref)!.sourceRevision}`),
        wireWithoutToken: [states[0],["SC",relation.relation,...(relationTime ? [relationTime] : [])],states[1]],
      }));
      refs.forEach((ref) => grouped.add(ref));
    }
  }

  for (const dispute of [...result.snapshot.unresolvedContradictions]
    .sort((left,right) => left.contradictionId.localeCompare(right.contradictionId))) {
    const refs = [dispute.leftRevisionId,dispute.rightRevisionId];
    if (refs.some((ref) => selectedFactRefs.has(ref))) {
      refs.filter((ref) => selectedFactRefs.has(ref)).forEach((ref) => atomicReserved.add(ref));
    }
    if (refs.some((ref) => !selectedFactRefs.has(ref) || !projectionByRef.has(ref) || !bundleByRef.has(ref))) continue;
    const states = refs.map((ref) => stateWire({
      result,candidateRef: ref,projection: projectionByRef.get(ref)!,bundle: bundleByRef.get(ref)!,
    }));
    groups.push(await materializeGroup({
      kind: "D",candidateRefs: refs,claimRevisions: refs.map((ref) => `${ref}:${bundleByRef.get(ref)!.sourceRevision}`),
      wireWithoutToken: states,
    }));
    refs.forEach((ref) => grouped.add(ref));
  }

  for (const ref of [...selectedFactRefs].sort()) {
    if (grouped.has(ref) || atomicReserved.has(ref)) continue;
    const projection = projectionByRef.get(ref);
    const bundle = bundleByRef.get(ref);
    if (!projection || !bundle || projection.queryRole === "exclude") continue;
    const member = result.snapshot.members.find((item) => item.factRevisionId === ref);
    if (!member) continue;
    const kind: Mb1Group["kind"] = projection.queryRole === "primary" ? "P"
      : projection.queryRole === "contrast" ? "X" : "C";
    const compact = stateWire({ result,candidateRef: ref,projection,bundle });
    groups.push(await materializeGroup({
      kind,candidateRefs: [ref],claimRevisions: [`${ref}:${bundle.sourceRevision}`],
      wireWithoutToken: kind === "P" && compact[0] === "C"
        ? [member.claimAtom.predicate,member.claimAtom.valueJson,...compactEvidence(bundle)]
        : [compact],
    }));
  }
  return groups.sort((left,right) => {
    const priority = { P: 0,T: 1,D: 2,X: 3,C: 4 } as const;
    return priority[left.kind] - priority[right.kind] || left.groupHash.localeCompare(right.groupHash);
  });
}

function packetPayload(input: {
  need: "O" | "R";
  view: "C" | "H" | "D" | "U";
  groups: readonly Mb1Group[];
  missDomain: string | null;
}): string {
  if (input.missDomain) return canonicalJson({ n: input.need,s: "MISS",d: input.missDomain });
  return canonicalJson({
    n: input.need,v: input.view,x: input.groups.map((group) => group.visibleToken),
    g: input.groups.map((group) => group.wire),
  });
}

export async function buildMb1Packet(input: {
  result: VNextReadPathResult | null;
  need: DynamicRecallNeed;
  suppressedGroupHashes?: ReadonlySet<string>;
  maxBytes: number;
  maxEstimatedTokens: number;
  missDomain?: string;
}): Promise<Mb1Packet | null> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("memory_mb1_byte_budget_invalid");
  if (!Number.isSafeInteger(input.maxEstimatedTokens) || input.maxEstimatedTokens < 1) throw new Error("memory_mb1_token_budget_invalid");
  const need = needCode(input.need);
  const view = viewCode(input.result?.requestedStateView ?? "unspecified");
  const allGroups = input.result ? await buildMb1Groups(input.result) : [];
  const available = allGroups.filter((group) => !input.suppressedGroupHashes?.has(group.groupHash));
  const selected: Mb1Group[] = [];
  const omittedGroupHashes: string[] = [];
  for (const group of available) {
    const candidate = [...selected,group];
    const payload = packetPayload({ need,view,groups: candidate,missDomain: null });
    const rendered = `${MEMORY_MB1_VERSION} ${utf8ByteLength(payload)}\n${payload}`;
    if (utf8ByteLength(rendered) > input.maxBytes || Math.ceil(utf8ByteLength(rendered) / 4) > input.maxEstimatedTokens) {
      omittedGroupHashes.push(group.groupHash);
      continue;
    }
    selected.push(group);
  }
  const requiredMiss = input.need === "REQUIRED" && selected.length === 0;
  if (input.need !== "REQUIRED" && selected.length === 0) return null;
  const missDomain = requiredMiss ? input.missDomain ?? "private_history" : null;
  const payload = packetPayload({ need,view,groups: selected,missDomain });
  const rendered = `${MEMORY_MB1_VERSION} ${utf8ByteLength(payload)}\n${payload}`;
  const packetHash = await sha256Hex(rendered);
  return {
    need,view,status: requiredMiss ? "MISS" : "OK",missDomain,groups: selected,omittedGroupHashes,
    payload,rendered,packetHash,totalBytes: utf8ByteLength(rendered),estimatedTokens: Math.ceil(utf8ByteLength(rendered) / 4),
  };
}

function lengthPrefixed(code: "h" | "p",content: string): string {
  return `${code} ${utf8ByteLength(content)}\n${content}`;
}

export async function renderDynamicMemoryCarriers(input: {
  packet: Mb1Packet | null;
  ownerModelHint?: OwnerModelHint | null;
  pointContext?: PointContext | null;
}): Promise<DynamicMemoryCarriers | null> {
  const stateEvidencePacket = input.packet?.rendered ?? null;
  const ownerModelHint = input.ownerModelHint?.content.trim()
    ? lengthPrefixed("h",input.ownerModelHint.content.trim()) : null;
  const pointContext = input.pointContext?.content.trim()
    ? lengthPrefixed("p",input.pointContext.content.trim()) : null;
  const parts = [
    stateEvidencePacket ? `<state_evidence>\n${stateEvidencePacket}\n</state_evidence>` : null,
    ownerModelHint ? `<owner_model_hint>\n${ownerModelHint}\n</owner_model_hint>` : null,
    pointContext ? `<point_context>\n${pointContext}\n</point_context>` : null,
  ].filter((item): item is string => Boolean(item));
  if (parts.length === 0) return null;
  const renderedExact = parts.join("\n");
  return {
    stateEvidencePacket,ownerModelHint,pointContext,renderedExact,
    memoryBlockExactHash: await sha256Hex(renderedExact),packetHash: input.packet?.packetHash ?? null,
    groupHashes: input.packet?.groups.map((group) => group.groupHash) ?? [],
    sourceRefs: input.packet?.groups.flatMap((group) => group.candidateRefs.map((id) => ({
      id,source: "fact_revision",byte_count: Math.ceil(group.estimatedTokens * 4 / Math.max(group.candidateRefs.length,1)),
    }))) ?? [],
  };
}
