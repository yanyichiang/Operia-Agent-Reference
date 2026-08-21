import { memoryArtifactHash, memoryHmacRef, utf16IndexToUtf8Offset } from "./integrity";

export type SecretSensitivity = "normal" | "secret";

export type SecretSpan = {
  byteStart: number;
  byteEnd: number;
  detectorIds: string[];
};

export type SecretScanArtifact = {
  artifactId: string;
  canonicalEventId: string;
  canonicalLocatorRef: string;
  scannerVersion: string;
  spans: Array<SecretSpan & { opaqueTermRef: string }>;
  extractorViewHash: string;
  indexViewHash: string;
  classification: "normal" | "redacted" | "restricted";
};

export type PersistedExactTerm = {
  value: string | null;
  opaqueTermRef: string | null;
  sensitivity: SecretSensitivity;
};

export type ExactTermCandidate = {
  value: string;
  utf16Start: number;
  utf16End: number;
};

type CharacterSpan = {
  start: number;
  end: number;
  detectorIds: string[];
};

type DetectorDefinition = {
  id: string;
  source: string;
  flags: string;
};

export const MEMORY_SECRET_SCANNER_VERSION = "memory-secret-local-v1";

const DETECTORS: readonly DetectorDefinition[] = Object.freeze([
  {
    id: "private_key_block",
    source: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    flags: "g",
  },
  {
    id: "credential_assignment",
    source: "(?:api[_-]?key|access[_-]?token|secret|password|passwd|credential)\\s*[:=]\\s*[\"']?[A-Za-z0-9_./+=:-]{12,}[\"']?",
    flags: "giu",
  },
  {
    id: "bearer_token",
    source: "Bearer\\s+[A-Za-z0-9._~+/-]{16,}={0,2}",
    flags: "giu",
  },
  {
    id: "jwt",
    source: "(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})(?=$|[^A-Za-z0-9_-])",
    flags: "gu",
  },
]);

function characterSpans(content: string): CharacterSpan[] {
  const found: CharacterSpan[] = [];
  for (const detector of DETECTORS) {
    const expression = new RegExp(detector.source, detector.flags);
    for (const match of content.matchAll(expression)) {
      if (match.index === undefined) continue;
      const captured = detector.id === "jwt" && match[1] ? match[1] : match[0];
      const captureOffset = detector.id === "jwt" ? match[0].indexOf(captured) : 0;
      found.push({
        start: match.index + captureOffset,
        end: match.index + captureOffset + captured.length,
        detectorIds: [detector.id],
      });
    }
  }
  found.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CharacterSpan[] = [];
  for (const span of found) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.detectorIds = [...new Set([...previous.detectorIds, ...span.detectorIds])].sort();
    } else {
      merged.push({ ...span, detectorIds: [...span.detectorIds] });
    }
  }
  return merged;
}

export function scanSecretSpans(content: string): SecretSpan[] {
  return characterSpans(content).map((span) => ({
    byteStart: utf16IndexToUtf8Offset(content, span.start),
    byteEnd: utf16IndexToUtf8Offset(content, span.end),
    detectorIds: span.detectorIds,
  }));
}

function renderWithSpans(content: string, spans: CharacterSpan[], mode: "extractor" | "index"): string {
  let cursor = 0;
  const fragments: string[] = [];
  for (const span of spans) {
    fragments.push(content.slice(cursor, span.start));
    if (mode === "extractor") fragments.push(`[SECRET:${span.detectorIds.join("+")}]`);
    cursor = span.end;
  }
  fragments.push(content.slice(cursor));
  return mode === "index" ? fragments.join("").replace(/\s+/g, " ").trim() : fragments.join("");
}

export function buildLocalSecretRedactedViews(content: string): {
  extractorView: string;
  indexEligibleText: string;
  secretSpans: SecretSpan[];
} {
  const chars = characterSpans(content);
  return {
    extractorView: renderWithSpans(content, chars, "extractor"),
    indexEligibleText: renderWithSpans(content, chars, "index"),
    secretSpans: chars.map((span) => ({
      byteStart: utf16IndexToUtf8Offset(content, span.start),
      byteEnd: utf16IndexToUtf8Offset(content, span.end),
      detectorIds: span.detectorIds,
    })),
  };
}

export async function buildSecretAwareMemoryViews(
  input: { canonicalEventId: string; content: string; hmacKey: Uint8Array },
): Promise<{
  artifact: SecretScanArtifact;
  extractorView: string;
  indexEligibleText: string;
}> {
  const chars = characterSpans(input.content);
  const extractorView = renderWithSpans(input.content, chars, "extractor");
  const indexEligibleText = renderWithSpans(input.content, chars, "index");
  const spans = await Promise.all(chars.map(async (span) => {
    const secret = input.content.slice(span.start, span.end);
    return {
      byteStart: utf16IndexToUtf8Offset(input.content, span.start),
      byteEnd: utf16IndexToUtf8Offset(input.content, span.end),
      detectorIds: span.detectorIds,
      opaqueTermRef: await memoryHmacRef(input.hmacKey, "secret-span", secret),
    };
  }));
  const classification = spans.length === 0 ? "normal" : indexEligibleText ? "redacted" : "restricted";
  const canonicalLocatorRef = await memoryHmacRef(input.hmacKey, "canonical-secret-locator", {
    eventId: input.canonicalEventId,
    content: input.content,
  });
  const artifactId = await memoryArtifactHash("secret-scan-artifact", {
    canonicalEventId: input.canonicalEventId,
    scannerVersion: MEMORY_SECRET_SCANNER_VERSION,
    spans,
    extractorViewHash: await memoryArtifactHash("secret-extractor-view", extractorView),
    indexViewHash: await memoryArtifactHash("secret-index-view", indexEligibleText),
  });
  return {
    artifact: {
      artifactId,
      canonicalEventId: input.canonicalEventId,
      canonicalLocatorRef,
      scannerVersion: MEMORY_SECRET_SCANNER_VERSION,
      spans,
      extractorViewHash: await memoryArtifactHash("secret-extractor-view", extractorView),
      indexViewHash: await memoryArtifactHash("secret-index-view", indexEligibleText),
      classification,
    },
    extractorView,
    indexEligibleText,
  };
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export async function partitionExactTerms(
  input: {
    content: string;
    candidates: ExactTermCandidate[];
    secretSpans: SecretSpan[];
    hmacKey: Uint8Array;
  },
): Promise<{ persisted: PersistedExactTerm[]; transientSecretValues: string[] }> {
  const persisted: PersistedExactTerm[] = [];
  const transientSecretValues: string[] = [];
  for (const candidate of input.candidates) {
    if (input.content.slice(candidate.utf16Start, candidate.utf16End) !== candidate.value) {
      throw new Error("memory_exact_term_source_mismatch");
    }
    const byteStart = utf16IndexToUtf8Offset(input.content, candidate.utf16Start);
    const byteEnd = utf16IndexToUtf8Offset(input.content, candidate.utf16End);
    const secret = input.secretSpans.some((span) => overlaps(byteStart, byteEnd, span.byteStart, span.byteEnd));
    if (secret) {
      transientSecretValues.push(candidate.value);
      persisted.push({
        value: null,
        opaqueTermRef: await memoryHmacRef(input.hmacKey, "query-exact-term", candidate.value),
        sensitivity: "secret",
      });
    } else {
      persisted.push({ value: candidate.value, opaqueTermRef: null, sensitivity: "normal" });
    }
  }
  return { persisted, transientSecretValues };
}
