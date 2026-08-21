// Authorized read/injection boundary for callers outside memory/vnext. The
// facade keeps Dynamic Need, aligned read, MB1, ledger, and exact receipts on
// one reviewable path instead of exposing their implementation modules.
export {
  decideDynamicRecallNeed,
  persistDynamicRecallDecision,
  persistDynamicRecallOutcome,
  type DynamicRecallDecision,
} from "./dynamicRecallNeed";
export { runVNext2ReadPath,type VNextReadPathResult } from "./vnext2ReadPath";
export { persistStateAlignmentShadow } from "./stateAlignmentShadow";
export {
  buildMb1Groups,
  buildMb1Packet,
  loadOwnerModelHint,
  renderDynamicMemoryCarriers,
  unsupportedSelectedMb1Lanes,
  type Mb1Packet,
} from "./mb1";
export { resolveVisibleContextSuppression } from "./visibleContextLedger";
export {
  createExactMemoryDispatchGuard,
  persistMb1Packet,
  persistRecallReceiptV2,
  type ExactMemoryDispatchGuard,
} from "./exactMemoryReceipt";
