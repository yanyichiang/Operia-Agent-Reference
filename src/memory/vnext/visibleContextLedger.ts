import { sha256Hex } from "../../utils/hash";
import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash } from "./integrity";
import type { Mb1Group } from "./mb1";

export const MEMORY_VISIBLE_CONTEXT_LEDGER_VERSION = "memory-visible-context-ledger-v1";

type LatestObservationRow = {
  group_hash: string;
  claim_revision_set_hash: string;
  observation: "VISIBLE" | "COMPACTED" | "REVISION_CHANGED";
};

async function claimRevisionSetHash(group: Pick<Mb1Group,"claimRevisions">): Promise<string> {
  return sha256Hex(canonicalJson([...group.claimRevisions].sort()));
}

export async function resolveVisibleContextSuppression(input: {
  db: D1Database;
  conversationScopeHash: string;
  requestIdHash: string;
  visibleHistoryText: string;
  groups: readonly Mb1Group[];
  createdAtUtc: string;
}): Promise<{ suppressedGroupHashes: Set<string>; compactedGroupHashes: string[]; revisionChangedGroupHashes: string[] }> {
  const suppressedGroupHashes = new Set<string>();
  const compactedGroupHashes: string[] = [];
  const revisionChangedGroupHashes: string[] = [];
  if (input.groups.length === 0) return { suppressedGroupHashes,compactedGroupHashes,revisionChangedGroupHashes };
  const hashes = input.groups.map((group) => group.groupHash);
  const marks = hashes.map(() => "?").join(",");
  const result = await input.db.prepare(`SELECT group_hash,claim_revision_set_hash,observation
    FROM memory_visible_context_latest_v
    WHERE conversation_scope_hash=? AND group_hash IN (${marks})`)
    .bind(input.conversationScopeHash,...hashes).all<LatestObservationRow>();
  const latest = new Map((result.results ?? []).map((row) => [row.group_hash,row]));
  const statements: D1PreparedStatement[] = [];
  for (const group of input.groups) {
    const prior = latest.get(group.groupHash);
    if (!prior || prior.observation !== "VISIBLE") continue;
    const currentClaimHash = await claimRevisionSetHash(group);
    let observation: "VISIBLE" | "COMPACTED" | "REVISION_CHANGED";
    let basis: "HISTORY_SCAN" | "REVISION_COMPARE";
    if (prior.claim_revision_set_hash !== currentClaimHash) {
      observation = "REVISION_CHANGED";basis = "REVISION_COMPARE";
      revisionChangedGroupHashes.push(group.groupHash);
    } else if (!input.visibleHistoryText.includes(group.visibleToken)) {
      observation = "COMPACTED";basis = "HISTORY_SCAN";
      compactedGroupHashes.push(group.groupHash);
    } else {
      suppressedGroupHashes.add(group.groupHash);
      continue;
    }
    const observationBody = {
      conversationScopeHash: input.conversationScopeHash,groupHash: group.groupHash,visibleToken: group.visibleToken,
      packetHash: null,claimRevisionSetHash: currentClaimHash,requestIdHash: input.requestIdHash,observation,basis,
    };
    const observationHash = await memoryArtifactHash("memory-visible-context-observation",observationBody);
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_visible_context_observations(
      observation_id,conversation_scope_hash,group_hash,visible_token,packet_hash,claim_revision_set_hash,
      request_id_hash,observation,basis,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      `vco_${observationHash.slice(0,32)}`,input.conversationScopeHash,group.groupHash,group.visibleToken,null,
      currentClaimHash,input.requestIdHash,observation,basis,input.createdAtUtc,
    ));
  }
  if (statements.length > 0) await input.db.batch(statements);
  return { suppressedGroupHashes,compactedGroupHashes,revisionChangedGroupHashes };
}

export async function recordVerifiedVisibleGroups(input: {
  db: D1Database;
  conversationScopeHash: string;
  requestIdHash: string;
  packetHash: string;
  groups: readonly Mb1Group[];
  createdAtUtc: string;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const group of input.groups) {
    const claimHash = await claimRevisionSetHash(group);
    const body = {
      conversationScopeHash: input.conversationScopeHash,groupHash: group.groupHash,visibleToken: group.visibleToken,
      packetHash: input.packetHash,claimRevisionSetHash: claimHash,requestIdHash: input.requestIdHash,
      observation: "VISIBLE",basis: "OUTBOUND_VERIFIED",
    };
    const hash = await memoryArtifactHash("memory-visible-context-observation",body);
    statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_visible_context_observations(
      observation_id,conversation_scope_hash,group_hash,visible_token,packet_hash,claim_revision_set_hash,
      request_id_hash,observation,basis,created_at
    ) VALUES(?,?,?,?,?,? ,?,'VISIBLE','OUTBOUND_VERIFIED',?)`).bind(
      `vco_${hash.slice(0,32)}`,input.conversationScopeHash,group.groupHash,group.visibleToken,input.packetHash,
      claimHash,input.requestIdHash,input.createdAtUtc,
    ));
  }
  if (statements.length > 0) await input.db.batch(statements);
}
