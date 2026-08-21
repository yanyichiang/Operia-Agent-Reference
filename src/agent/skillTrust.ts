export const COMMUNITY_SKILL_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const COMMUNITY_SKILL_BINARY_ENCODING = "base64url" as const;
export const COMMUNITY_SKILL_HASH_PREFIX = "sha256:" as const;
export const COMMUNITY_SKILL_SIGNING_CONTEXT = "OPERIA-COMMUNITY-SKILL-MANIFEST-V1" as const;

import { assertJsonValue, canonicalJson } from "../utils/json";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalJsonValue>
  | { readonly [key: string]: CanonicalJsonValue };

export type CommunitySkillPublisherKey = {
  keyId: string;
  fingerprint: string;
  algorithm: typeof COMMUNITY_SKILL_SIGNATURE_ALGORITHM;
  publicKeyEncoding: typeof COMMUNITY_SKILL_BINARY_ENCODING;
  publicKeyBase64Url: string;
  status: "active" | "revoked";
};

export type CommunitySkillSignature = {
  keyId: string;
  keyFingerprint: string;
  algorithm: typeof COMMUNITY_SKILL_SIGNATURE_ALGORITHM;
  signatureEncoding: typeof COMMUNITY_SKILL_BINARY_ENCODING;
  signatureBase64Url: string;
};

export type CommunitySkillEnvelope = {
  sourceRegistry: string;
  manifest: { readonly [key: string]: CanonicalJsonValue };
  manifestHash: string;
  signature: CommunitySkillSignature | null;
};

export type CommunitySkillTrustPolicy = {
  allowedSourceRegistries: ReadonlyArray<string>;
  publisherKeys: ReadonlyArray<CommunitySkillPublisherKey>;
  revokedManifestHashes?: ReadonlyArray<string>;
  revokedPublisherKeyIds?: ReadonlyArray<string>;
  revokedPublisherFingerprints?: ReadonlyArray<string>;
};

export type CommunitySkillTrustFailureCode =
  | "invalid_envelope"
  | "invalid_manifest"
  | "invalid_policy"
  | "source_registry_not_allowed"
  | "unsigned"
  | "manifest_hash_mismatch"
  | "manifest_revoked"
  | "publisher_key_unknown"
  | "publisher_key_revoked"
  | "publisher_key_invalid"
  | "publisher_fingerprint_mismatch"
  | "signature_invalid"
  | "crypto_unavailable";

export type CommunitySkillTrustDecision =
  | {
      trusted: true;
      status: "trusted";
      sourceRegistry: string;
      manifestHash: string;
      publisherKeyId: string;
      publisherKeyFingerprint: string;
    }
  | {
      trusted: false;
      status: "rejected";
      code: CommunitySkillTrustFailureCode;
    };

export type CommunitySkillSigningPayload = {
  canonicalManifest: string;
  manifestHash: string;
  signingBytes: Uint8Array;
};

export type VerifyCommunitySkillTrustInput = {
  envelope: unknown;
  policy: CommunitySkillTrustPolicy;
  subtle?: SubtleCrypto;
};

export function canonicalizeSkillManifest(manifest: unknown): string {
  if (!isPlainRecord(manifest)) throw new Error("invalid_manifest");
  return canonicalJson(assertJsonValue(manifest));
}

export async function hashSkillManifest(manifest: unknown, subtle?: SubtleCrypto): Promise<string> {
  const canonicalManifest = canonicalizeSkillManifest(manifest);
  return `${COMMUNITY_SKILL_HASH_PREFIX}${await sha256Hex(new TextEncoder().encode(canonicalManifest), requireSubtle(subtle))}`;
}

export async function buildCommunitySkillSigningPayload(
  manifest: unknown,
  subtle?: SubtleCrypto,
): Promise<CommunitySkillSigningPayload> {
  const crypto = requireSubtle(subtle);
  const canonicalManifest = canonicalizeSkillManifest(manifest);
  const manifestHash = `${COMMUNITY_SKILL_HASH_PREFIX}${await sha256Hex(new TextEncoder().encode(canonicalManifest), crypto)}`;
  const signingBytes = new TextEncoder().encode(
    `${COMMUNITY_SKILL_SIGNING_CONTEXT}\n${manifestHash}\n${canonicalManifest}`,
  );
  return { canonicalManifest, manifestHash, signingBytes };
}

export async function fingerprintPublisherKey(
  publicKeyBase64Url: string,
  subtle?: SubtleCrypto,
): Promise<string> {
  const publicKey = decodeCanonicalBase64Url(publicKeyBase64Url, ED25519_PUBLIC_KEY_BYTES);
  return `${COMMUNITY_SKILL_HASH_PREFIX}${await sha256Hex(publicKey, requireSubtle(subtle))}`;
}

export async function verifyCommunitySkillTrust(
  input: VerifyCommunitySkillTrustInput,
): Promise<CommunitySkillTrustDecision> {
  const policyError = validatePolicy(input.policy);
  if (policyError) return reject(policyError);
  if (!isPlainRecord(input.envelope) || !hasOnlyKeys(input.envelope, ["sourceRegistry", "manifest", "manifestHash", "signature"])) {
    return reject("invalid_envelope");
  }

  const sourceRegistry = input.envelope.sourceRegistry;
  if (!isStableIdentifier(sourceRegistry, 512)) return reject("invalid_envelope");
  if (!input.policy.allowedSourceRegistries.includes(sourceRegistry)) return reject("source_registry_not_allowed");
  if (input.envelope.signature === null || input.envelope.signature === undefined) return reject("unsigned");
  if (!HASH_PATTERN.test(String(input.envelope.manifestHash))) return reject("invalid_envelope");

  let payload: CommunitySkillSigningPayload;
  try {
    payload = await buildCommunitySkillSigningPayload(input.envelope.manifest, input.subtle);
  } catch (error) {
    return reject(isCryptoUnavailable(error) ? "crypto_unavailable" : "invalid_manifest");
  }

  if (payload.manifestHash !== input.envelope.manifestHash) return reject("manifest_hash_mismatch");
  if (input.policy.revokedManifestHashes?.includes(payload.manifestHash)) return reject("manifest_revoked");

  const signature = input.envelope.signature;
  if (!isCommunitySkillSignature(signature)) return reject("signature_invalid");
  const keys = input.policy.publisherKeys.filter((key) => key.keyId === signature.keyId);
  if (keys.length === 0) return reject("publisher_key_unknown");
  if (keys.length !== 1) return reject("invalid_policy");
  const publisherKey = keys[0];

  if (
    publisherKey.status === "revoked" ||
    input.policy.revokedPublisherKeyIds?.includes(publisherKey.keyId) ||
    input.policy.revokedPublisherFingerprints?.includes(publisherKey.fingerprint)
  ) {
    return reject("publisher_key_revoked");
  }

  let computedFingerprint: string;
  let rawPublicKey: Uint8Array;
  try {
    rawPublicKey = decodeCanonicalBase64Url(publisherKey.publicKeyBase64Url, ED25519_PUBLIC_KEY_BYTES);
    computedFingerprint = await fingerprintPublisherKey(publisherKey.publicKeyBase64Url, input.subtle);
  } catch (error) {
    if (isCryptoUnavailable(error)) return reject("crypto_unavailable");
    return reject("publisher_key_invalid");
  }

  if (computedFingerprint !== publisherKey.fingerprint || computedFingerprint !== signature.keyFingerprint) {
    return reject("publisher_fingerprint_mismatch");
  }

  let rawSignature: Uint8Array;
  try {
    rawSignature = decodeCanonicalBase64Url(signature.signatureBase64Url, ED25519_SIGNATURE_BYTES);
  } catch {
    return reject("signature_invalid");
  }

  let verified = false;
  try {
    const crypto = requireSubtle(input.subtle);
    const verificationKey = await crypto.importKey(
      "raw",
      toArrayBuffer(rawPublicKey),
      { name: COMMUNITY_SKILL_SIGNATURE_ALGORITHM },
      false,
      ["verify"],
    );
    verified = await crypto.verify(
      COMMUNITY_SKILL_SIGNATURE_ALGORITHM,
      verificationKey,
      toArrayBuffer(rawSignature),
      toArrayBuffer(payload.signingBytes),
    );
  } catch (error) {
    if (isCryptoUnavailable(error)) return reject("crypto_unavailable");
    return reject("signature_invalid");
  }
  if (!verified) return reject("signature_invalid");

  return {
    trusted: true,
    status: "trusted",
    sourceRegistry,
    manifestHash: payload.manifestHash,
    publisherKeyId: publisherKey.keyId,
    publisherKeyFingerprint: computedFingerprint,
  };
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCanonicalBase64Url(value: string, expectedByteLength?: number): Uint8Array {
  if (!value || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) throw new Error("invalid_base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("invalid_base64url");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedByteLength !== undefined && bytes.byteLength !== expectedByteLength) throw new Error("invalid_binary_length");
  if (encodeBase64Url(bytes) !== value) throw new Error("non_canonical_base64url");
  return bytes;
}

function validatePolicy(policy: CommunitySkillTrustPolicy): CommunitySkillTrustFailureCode | null {
  if (!isPlainRecord(policy)) return "invalid_policy";
  if (!hasOnlyKeys(policy, [
    "allowedSourceRegistries", "publisherKeys", "revokedManifestHashes",
    "revokedPublisherKeyIds", "revokedPublisherFingerprints",
  ])) return "invalid_policy";
  if (!Array.isArray(policy.allowedSourceRegistries) || policy.allowedSourceRegistries.length === 0) return "invalid_policy";
  if (!policy.allowedSourceRegistries.every((registry) => isStableIdentifier(registry, 512))) return "invalid_policy";
  if (!Array.isArray(policy.publisherKeys) || policy.publisherKeys.length === 0) return "invalid_policy";
  if (!policy.publisherKeys.every(isCommunitySkillPublisherKey)) return "invalid_policy";
  if (new Set(policy.publisherKeys.map((key) => key.keyId)).size !== policy.publisherKeys.length) return "invalid_policy";
  if (!isOptionalStringArray(policy.revokedManifestHashes, HASH_PATTERN)) return "invalid_policy";
  if (!isOptionalStringArray(policy.revokedPublisherKeyIds, KEY_ID_PATTERN)) return "invalid_policy";
  if (!isOptionalStringArray(policy.revokedPublisherFingerprints, HASH_PATTERN)) return "invalid_policy";
  return null;
}

function isCommunitySkillPublisherKey(value: unknown): value is CommunitySkillPublisherKey {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["keyId", "fingerprint", "algorithm", "publicKeyEncoding", "publicKeyBase64Url", "status"]) &&
    typeof value.keyId === "string" && KEY_ID_PATTERN.test(value.keyId) &&
    typeof value.fingerprint === "string" && HASH_PATTERN.test(value.fingerprint) &&
    value.algorithm === COMMUNITY_SKILL_SIGNATURE_ALGORITHM &&
    value.publicKeyEncoding === COMMUNITY_SKILL_BINARY_ENCODING &&
    typeof value.publicKeyBase64Url === "string" &&
    (value.status === "active" || value.status === "revoked");
}

function isCommunitySkillSignature(value: unknown): value is CommunitySkillSignature {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["keyId", "keyFingerprint", "algorithm", "signatureEncoding", "signatureBase64Url"]) &&
    typeof value.keyId === "string" && KEY_ID_PATTERN.test(value.keyId) &&
    typeof value.keyFingerprint === "string" && HASH_PATTERN.test(value.keyFingerprint) &&
    value.algorithm === COMMUNITY_SKILL_SIGNATURE_ALGORITHM &&
    value.signatureEncoding === COMMUNITY_SKILL_BINARY_ENCODING &&
    typeof value.signatureBase64Url === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  const allowedSet = new Set(allowed);
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !allowedSet.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}

function isStableIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && value === value.trim();
}

function isOptionalStringArray(value: unknown, pattern: RegExp): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string" && pattern.test(item)));
}

function requireSubtle(subtle?: SubtleCrypto): SubtleCrypto {
  const resolved = subtle ?? (typeof crypto === "undefined" ? undefined : crypto.subtle);
  if (!resolved) throw new Error("crypto_unavailable");
  return resolved;
}

async function sha256Hex(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isCryptoUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === "crypto_unavailable";
}

function reject(code: CommunitySkillTrustFailureCode): CommunitySkillTrustDecision {
  return { trusted: false, status: "rejected", code };
}
