export type VoiceProviderId = "elevenlabs" | "minimax";
export type VoiceProfileKind = "system" | "designed" | "cloned";
export type VoiceLifecycleStatus =
  | "staged"
  | "remote_created"
  | "preview_ready"
  | "owner_selected"
  | "activated_by_t2a"
  | "expired"
  | "deleted"
  | "attention_required";

export type VoiceProfile = {
  profileId: string;
  providerId: VoiceProviderId;
  providerVoiceId: string;
  kind: VoiceProfileKind;
  displayName: string;
  lifecycleStatus: VoiceLifecycleStatus;
  synthesisDefaults: {
    model: string;
    speed?: number;
    volume?: number;
    pitch?: number;
    emotion?: string;
    languageBoost?: string;
    audioFormat: "opus" | "mp3";
    sampleRate: 32000 | 44100;
  };
  provenanceRef?: string;
  providerCreatedAt?: string;
  activationDeadline?: string;
  selectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type VoiceJobStatus =
  | "draft"
  | "validated_offline"
  | "blocked_by_provenance"
  | "awaiting_owner_approval"
  | "blocked_by_budget"
  | "budget_reserved"
  | "uploading_source"
  | "source_uploaded"
  | "creating_remote_voice"
  | "remote_created"
  | "awaiting_paid_preview_approval"
  | "preview_synthesizing"
  | "preview_ready"
  | "owner_selected"
  | "production_enablement_pending"
  | "activated_by_t2a"
  | "attention_required"
  | "cancelled"
  | "expired"
  | "cleaned";

export type VoiceCloneProvenance = {
  schemaVersion: 1;
  sourceType: "owner_upload";
  rightsBasis: "self_voice" | "documented_permission" | "licensed_sample";
  attestationText: string;
  attestedByOwnerId: string;
  attestedAt: string;
  consentVersion: "voice-clone-consent-v1";
  evidenceRef?: string;
  sourceSha256: string;
  sourceMediaType: "audio/mpeg" | "audio/mp4" | "audio/wav";
  sourceBytes: number;
  sourceDurationMs: number;
  sampleTranscript: string;
  sampleTranscriptSha256: string;
  retention: "delete_after_provider_upload";
};

export type PrivateVoiceSampleLocator = {
  ref: `voice-sample:${string}`;
  objectKey: string;
  private: true;
  cacheControl: "private, no-store";
  sha256: string;
  mediaType: VoiceCloneProvenance["sourceMediaType"];
  bytes: number;
  durationMs: number;
  createdAt: string;
  expiresAt: string;
};

export type VoiceOperationApproval = {
  approved: boolean;
  operation: "voice_clone" | "voice_design" | "voice_preview_t2a";
  argumentsHash: string;
  expectedArgumentsHash: string;
  pricingSource: "minimax_official_paygo";
  pricingVersion: string;
  estimatedMaxMicroUsd: number;
  dailyRemainingMicroUsd: number;
  idempotencyKey: string;
  expiresAt: string;
};

export type VoiceBudget = {
  dailyLimitMicroUsd: number;
  usedMicroUsd: number;
  reservedMicroUsd: number;
};

export type VoiceCloneGateDecision = {
  status: Extract<VoiceJobStatus, "blocked_by_provenance" | "awaiting_owner_approval" | "blocked_by_budget" | "budget_reserved">;
  fetchAllowed: boolean;
  reason?: string;
  reservedMicroUsd: number;
};

export class VoiceContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VoiceContractError";
  }
}

export function createPrivateVoiceSampleLocator(input: {
  id: string;
  sha256: string;
  mediaType: VoiceCloneProvenance["sourceMediaType"];
  bytes: number;
  durationMs: number;
  now?: Date;
  ttlMs?: number;
}): PrivateVoiceSampleLocator {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) throw new VoiceContractError("invalid_sample_id");
  const sha256 = normalizedSha256(input.sha256, "invalid_source_sha256");
  validateSampleMetadata(input);
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) throw new VoiceContractError("invalid_sample_ttl");
  const ref = `voice-sample:${input.id}` as const;
  return {
    ref,
    objectKey: `voice-staging/${input.id}`,
    private: true,
    cacheControl: "private, no-store",
    sha256,
    mediaType: input.mediaType,
    bytes: input.bytes,
    durationMs: input.durationMs,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export async function evaluateVoiceCloneGate(input: {
  provenance: VoiceCloneProvenance | null;
  locator: PrivateVoiceSampleLocator | null;
  sampleBytes: Uint8Array;
  approval: VoiceOperationApproval | null;
  budget: VoiceBudget;
  now?: Date;
}): Promise<VoiceCloneGateDecision> {
  const now = input.now ?? new Date();
  try {
    if (!input.provenance || !input.locator) throw new VoiceContractError("provenance_required");
    await validateVoiceCloneProvenance(input.provenance, input.locator, input.sampleBytes, now);
  } catch (error) {
    return { status: "blocked_by_provenance", fetchAllowed: false, reason: error instanceof VoiceContractError ? error.code : "invalid_provenance", reservedMicroUsd: 0 };
  }
  const approval = input.approval;
  if (!approval || !approval.approved || approval.operation !== "voice_clone" || approval.argumentsHash !== approval.expectedArgumentsHash
    || approval.pricingSource !== "minimax_official_paygo" || !/^\d{4}-\d{2}-\d{2}$/.test(approval.pricingVersion)
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(approval.idempotencyKey) || Date.parse(approval.expiresAt) <= now.getTime()) {
    return { status: "awaiting_owner_approval", fetchAllowed: false, reason: "valid_approval_required", reservedMicroUsd: 0 };
  }
  const estimate = approval.estimatedMaxMicroUsd;
  const budget = input.budget;
  if (![estimate, approval.dailyRemainingMicroUsd, budget.dailyLimitMicroUsd, budget.usedMicroUsd, budget.reservedMicroUsd].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { status: "blocked_by_budget", fetchAllowed: false, reason: "invalid_budget", reservedMicroUsd: 0 };
  }
  const remaining = budget.dailyLimitMicroUsd - budget.usedMicroUsd - budget.reservedMicroUsd;
  if (budget.dailyLimitMicroUsd === 0 || estimate === 0 || approval.dailyRemainingMicroUsd !== remaining || estimate > remaining) {
    return { status: "blocked_by_budget", fetchAllowed: false, reason: "budget_unavailable", reservedMicroUsd: 0 };
  }
  return { status: "budget_reserved", fetchAllowed: true, reservedMicroUsd: estimate };
}

export async function validateVoiceCloneProvenance(
  provenance: VoiceCloneProvenance,
  locator: PrivateVoiceSampleLocator,
  sampleBytes: Uint8Array,
  now = new Date(),
): Promise<void> {
  if (provenance.schemaVersion !== 1 || provenance.sourceType !== "owner_upload" || provenance.consentVersion !== "voice-clone-consent-v1") {
    throw new VoiceContractError("invalid_consent_version");
  }
  if (!new Set(["self_voice", "documented_permission", "licensed_sample"]).has(provenance.rightsBasis)) throw new VoiceContractError("invalid_rights_basis");
  if (provenance.rightsBasis !== "self_voice" && !validPrivateEvidenceRef(provenance.evidenceRef)) throw new VoiceContractError("evidence_required");
  if (provenance.attestationText.trim().length < 20 || provenance.attestationText.length > 2_000) throw new VoiceContractError("invalid_attestation");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(provenance.attestedByOwnerId)) throw new VoiceContractError("invalid_attested_owner");
  if (!Number.isFinite(Date.parse(provenance.attestedAt)) || Date.parse(provenance.attestedAt) > now.getTime() + 60_000) throw new VoiceContractError("invalid_attested_at");
  if (provenance.retention !== "delete_after_provider_upload") throw new VoiceContractError("invalid_retention");
  validateSampleMetadata({ mediaType: provenance.sourceMediaType, bytes: provenance.sourceBytes, durationMs: provenance.sourceDurationMs });
  if (sampleBytes.byteLength !== provenance.sourceBytes || locator.bytes !== provenance.sourceBytes) throw new VoiceContractError("source_size_mismatch");
  if (locator.mediaType !== provenance.sourceMediaType || locator.durationMs !== provenance.sourceDurationMs) throw new VoiceContractError("source_metadata_mismatch");
  if (Date.parse(locator.expiresAt) <= now.getTime() || !locator.private || locator.cacheControl !== "private, no-store" || !locator.objectKey.startsWith("voice-staging/")) throw new VoiceContractError("sample_locator_expired_or_public");
  const sourceHash = await sha256Hex(sampleBytes);
  if (sourceHash !== normalizedSha256(provenance.sourceSha256, "invalid_source_sha256") || sourceHash !== locator.sha256) throw new VoiceContractError("source_hash_mismatch");
  const transcript = provenance.sampleTranscript.trim();
  if (transcript.length < 1 || transcript.length > 200) throw new VoiceContractError("invalid_sample_transcript");
  const transcriptHash = await sha256Hex(new TextEncoder().encode(transcript));
  if (transcriptHash !== normalizedSha256(provenance.sampleTranscriptSha256, "invalid_transcript_sha256")) throw new VoiceContractError("transcript_hash_mismatch");
}

export async function cleanupPrivateVoiceSample(
  locator: PrivateVoiceSampleLocator,
  storage: { delete(objectKey: string): Promise<boolean>; exists(objectKey: string): Promise<boolean> },
): Promise<"cleaned"> {
  let deleted = false;
  try { deleted = await storage.delete(locator.objectKey); } catch { throw new VoiceContractError("sample_cleanup_failed"); }
  if (!deleted) throw new VoiceContractError("sample_cleanup_failed");
  try {
    if (await storage.exists(locator.objectKey)) throw new VoiceContractError("sample_cleanup_failed");
  } catch (error) {
    if (error instanceof VoiceContractError) throw error;
    throw new VoiceContractError("sample_cleanup_unverified");
  }
  return "cleaned";
}

export function voiceJobFailureStatus(input: {
  remoteMutationStarted: boolean;
  remoteOutcome: "definitive" | "unknown";
}): Extract<VoiceJobStatus, "attention_required" | "cancelled"> {
  return input.remoteMutationStarted && input.remoteOutcome === "unknown" ? "attention_required" : "cancelled";
}

const VOICE_JOB_TRANSITIONS: Readonly<Record<VoiceJobStatus, readonly VoiceJobStatus[]>> = {
  draft: ["validated_offline", "cancelled"],
  validated_offline: ["blocked_by_provenance", "awaiting_owner_approval", "cancelled"],
  blocked_by_provenance: ["validated_offline", "cancelled", "expired"],
  awaiting_owner_approval: ["blocked_by_budget", "budget_reserved", "cancelled", "expired"],
  blocked_by_budget: ["awaiting_owner_approval", "cancelled", "expired"],
  budget_reserved: ["uploading_source", "creating_remote_voice", "cancelled", "expired"],
  uploading_source: ["source_uploaded", "attention_required"],
  source_uploaded: ["creating_remote_voice", "attention_required"],
  creating_remote_voice: ["remote_created", "attention_required"],
  remote_created: ["awaiting_paid_preview_approval", "preview_ready", "attention_required"],
  awaiting_paid_preview_approval: ["preview_synthesizing", "cancelled", "expired"],
  preview_synthesizing: ["preview_ready", "attention_required"],
  preview_ready: ["owner_selected", "cancelled", "expired"],
  owner_selected: ["production_enablement_pending", "cancelled"],
  production_enablement_pending: ["activated_by_t2a", "attention_required", "cancelled"],
  activated_by_t2a: ["cleaned"],
  attention_required: ["cancelled", "cleaned"],
  cancelled: ["cleaned"],
  expired: ["cleaned"],
  cleaned: [],
};

export function assertVoiceJobTransition(from: VoiceJobStatus, to: VoiceJobStatus): void {
  if (!VOICE_JOB_TRANSITIONS[from]?.includes(to)) throw new VoiceContractError("invalid_voice_job_transition");
}

export function voiceCostEstimateMicroUsd(input:
  | { operation: "tts"; characters: number; model: "speech-2.8-turbo" | "speech-2.8-hd" }
  | { operation: "voice_clone_activation" }
  | { operation: "voice_design_activation" }
  | { operation: "voice_design_preview"; characters: number }
): number {
  if (input.operation === "voice_clone_activation") return 1_500_000;
  if (input.operation === "voice_design_activation") return 3_000_000;
  if (!Number.isSafeInteger(input.characters) || input.characters < 0 || input.characters > 10_000) throw new VoiceContractError("invalid_character_count");
  if (input.operation === "voice_design_preview") return input.characters * 30;
  return input.characters * (input.model === "speech-2.8-hd" ? 100 : 60);
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = value.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedSha256(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new VoiceContractError(code);
  return normalized;
}

function validPrivateEvidenceRef(value?: string): boolean {
  return typeof value === "string" && /^voice-consent-evidence:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateSampleMetadata(input: { mediaType: string; bytes: number; durationMs: number }): void {
  if (!new Set(["audio/mpeg", "audio/mp4", "audio/wav"]).has(input.mediaType)) throw new VoiceContractError("invalid_source_media_type");
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 20 * 1024 * 1024) throw new VoiceContractError("invalid_source_bytes");
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 10_000 || input.durationMs > 30_000) throw new VoiceContractError("invalid_source_duration");
}
