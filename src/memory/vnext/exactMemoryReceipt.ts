import type { DynamicMemoryCarriers } from "../../assembler/types";
import { sha256Hex } from "../../utils/hash";
import { canonicalJson } from "../import/hashes";
import { memoryArtifactHash,utf8ByteLength } from "./integrity";
import { MEMORY_MB1_RENDERER_VERSION,type Mb1Group,type Mb1Packet } from "./mb1";
import { recordVerifiedVisibleGroups } from "./visibleContextLedger";

export const MEMORY_EXACT_DISPATCH_VERIFIER_VERSION = "memory-exact-dispatch-receipt-v1";
export const MEMORY_RECALL_RECEIPT_V2_VERSION = "memory-recall-receipt-v2";

export type ExactMemoryVerification = {
  locationPath: string;
  memoryByteStart: number;
  memoryByteEnd: number;
  observedMemoryBlockExactHash: string;
  outboundRequestHash: string;
};

export interface ExactMemoryDispatchGuard {
  verify(outbound: unknown,adapterStage: string): Promise<ExactMemoryVerification>;
}

function collectStrings(value: unknown,path = "$",out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    out.push({ path,value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item,index) => collectStrings(item,`${path}[${index}]`,out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key,item] of Object.entries(value as Record<string,unknown>)) {
      collectStrings(item,`${path}.${key}`,out);
    }
  }
  return out;
}

export async function verifyExactMemoryRange(input: {
  outbound: unknown;
  renderedExact: string;
  memoryBlockExactHash: string;
}): Promise<ExactMemoryVerification> {
  const matches: Array<{ path: string; value: string; index: number }> = [];
  for (const item of collectStrings(input.outbound)) {
    let offset = item.value.indexOf(input.renderedExact);
    while (offset >= 0) {
      matches.push({ ...item,index: offset });
      offset = item.value.indexOf(input.renderedExact,offset + input.renderedExact.length);
    }
  }
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? "memory_exact_range_missing" : "memory_exact_range_ambiguous");
  const match = matches[0];
  const observed = match.value.slice(match.index,match.index + input.renderedExact.length);
  const observedHash = await sha256Hex(observed);
  if (observedHash !== input.memoryBlockExactHash) throw new Error("memory_exact_range_hash_mismatch");
  const memoryByteStart = utf8ByteLength(match.value.slice(0,match.index));
  return {
    locationPath: match.path,memoryByteStart,
    memoryByteEnd: memoryByteStart + utf8ByteLength(observed),
    observedMemoryBlockExactHash: observedHash,
    outboundRequestHash: await sha256Hex(JSON.stringify(input.outbound)),
  };
}

export async function persistMb1Packet(input: {
  db: D1Database;
  runId: string;
  packet: Mb1Packet;
  shadowOnly: boolean;
  createdAtUtc: string;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [input.db.prepare(`INSERT OR IGNORE INTO memory_mb1_packets(
    packet_hash,run_id,need,requested_view,status,miss_domain,payload_bytes,total_bytes,estimated_tokens,
    renderer_version,shadow_only,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    input.packet.packetHash,input.runId,input.packet.need,input.packet.view,input.packet.status,input.packet.missDomain,
    utf8ByteLength(input.packet.payload),input.packet.totalBytes,input.packet.estimatedTokens,MEMORY_MB1_RENDERER_VERSION,
    input.shadowOnly ? 1 : 0,input.createdAtUtc,
  )];
  input.packet.groups.forEach((group,ordinal) => statements.push(input.db.prepare(`INSERT OR IGNORE INTO memory_mb1_packet_groups(
    packet_hash,group_hash,ordinal,visible_token,group_kind,candidate_refs_json,claim_revisions_json,
    group_wire_json,estimated_tokens
  ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    input.packet.packetHash,group.groupHash,ordinal,group.visibleToken,group.kind,canonicalJson(group.candidateRefs),
    canonicalJson(group.claimRevisions),canonicalJson(group.wire),group.estimatedTokens,
  )));
  await input.db.batch(statements);
}

export async function persistRecallReceiptV2(input: {
  db: D1Database;
  runId: string;
  requestIdHash: string;
  queryPlanHash: string;
  carriers: DynamicMemoryCarriers;
  assembled: unknown;
  createdAtUtc: string;
}): Promise<{ receiptId: string; assemblerVerification: ExactMemoryVerification }> {
  const assemblerVerification = await verifyExactMemoryRange({
    outbound: input.assembled,renderedExact: input.carriers.renderedExact,
    memoryBlockExactHash: input.carriers.memoryBlockExactHash,
  });
  const messageMatch = /\$\.messages\[(\d+)\]/.exec(assemblerVerification.locationPath);
  if (!messageMatch) throw new Error("memory_exact_range_not_in_assembler_message");
  const body = {
    runId: input.runId,requestIdHash: input.requestIdHash,queryPlanHash: input.queryPlanHash,
    packetHash: input.carriers.packetHash,groupHashes: [...input.carriers.groupHashes].sort(),
    memoryBlockExactHash: input.carriers.memoryBlockExactHash,memoryBlockBytes: utf8ByteLength(input.carriers.renderedExact),
    assemblerBlockId: "dynamic_memory_patch",assemblerMessageIndex: Number(messageMatch[1]),
    receiptVersion: MEMORY_RECALL_RECEIPT_V2_VERSION,
  };
  const receiptHash = await memoryArtifactHash("memory-recall-receipt-v2",body);
  const receiptId = `rr2_${receiptHash.slice(0,32)}`;
  await input.db.prepare(`INSERT OR IGNORE INTO memory_recall_receipts_v2(
    receipt_id,run_id,request_id_hash,query_plan_hash,packet_hash,group_hashes_json,memory_block_exact_hash,
    memory_block_bytes,assembler_block_id,assembler_message_index,receipt_version,receipt_hash,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    receiptId,input.runId,input.requestIdHash,input.queryPlanHash,input.carriers.packetHash,
    canonicalJson([...input.carriers.groupHashes].sort()),input.carriers.memoryBlockExactHash,
    utf8ByteLength(input.carriers.renderedExact),"dynamic_memory_patch",Number(messageMatch[1]),
    MEMORY_RECALL_RECEIPT_V2_VERSION,receiptHash,input.createdAtUtc,
  ).run();
  return { receiptId,assemblerVerification };
}

export function createExactMemoryDispatchGuard(input: {
  db: D1Database;
  receiptId: string;
  provider: string;
  carriers: DynamicMemoryCarriers;
  conversationScopeHash: string;
  requestIdHash: string;
  packet: Mb1Packet | null;
  groups: readonly Mb1Group[];
  createdAtUtc: string;
}): ExactMemoryDispatchGuard {
  let dispatchOrdinal = 0;
  return {
    async verify(outbound: unknown,adapterStage: string): Promise<ExactMemoryVerification> {
      const verification = await verifyExactMemoryRange({
        outbound,renderedExact: input.carriers.renderedExact,
        memoryBlockExactHash: input.carriers.memoryBlockExactHash,
      });
      const body = {
        receiptId: input.receiptId,dispatchOrdinal,provider: input.provider,adapterStage,
        locationPath: verification.locationPath,memoryByteStart: verification.memoryByteStart,
        memoryByteEnd: verification.memoryByteEnd,observedMemoryBlockExactHash: verification.observedMemoryBlockExactHash,
        outboundRequestHash: verification.outboundRequestHash,verifierVersion: MEMORY_EXACT_DISPATCH_VERIFIER_VERSION,
      };
      const hash = await memoryArtifactHash("memory-dispatch-receipt-v2",body);
      await input.db.prepare(`INSERT OR IGNORE INTO memory_dispatch_receipts_v2(
        dispatch_receipt_id,recall_receipt_id,dispatch_ordinal,provider,adapter_stage,outbound_location_path,
        memory_byte_start,memory_byte_end,observed_memory_block_exact_hash,outbound_request_hash,
        verifier_version,verified,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)`).bind(
        `dr2_${hash.slice(0,32)}`,input.receiptId,dispatchOrdinal,input.provider,adapterStage,
        verification.locationPath,verification.memoryByteStart,verification.memoryByteEnd,
        verification.observedMemoryBlockExactHash,verification.outboundRequestHash,
        MEMORY_EXACT_DISPATCH_VERIFIER_VERSION,input.createdAtUtc,
      ).run();
      if (input.packet && input.groups.length > 0) {
        await recordVerifiedVisibleGroups({
          db: input.db,conversationScopeHash: input.conversationScopeHash,requestIdHash: input.requestIdHash,
          packetHash: input.packet.packetHash,groups: input.groups,createdAtUtc: input.createdAtUtc,
        });
      }
      dispatchOrdinal += 1;
      return verification;
    },
  };
}
