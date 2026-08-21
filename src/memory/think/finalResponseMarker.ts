export const FINAL_RESPONSE_STREAM_MARKER = "<operia_final_response>";

export type FinalResponseMarkerScan =
  | { found: false; pending: string; finalText: "" }
  | { found: true; pending: ""; finalText: string };

export type FinalResponseMarkerStrip = {
  found: boolean;
  pending: string;
  text: string;
};

/**
 * Removes the legacy in-band final marker without withholding the provider
 * stream. Only the short suffix that could still become a split marker is
 * retained between chunks.
 */
export function stripFinalResponseMarkerChunk(pending: string, chunk: string): FinalResponseMarkerStrip {
  const combined = `${pending}${chunk}`;
  const found = combined.includes(FINAL_RESPONSE_STREAM_MARKER);
  const withoutMarker = combined.split(FINAL_RESPONSE_STREAM_MARKER).join("");
  let pendingLength = 0;
  const maxPending = Math.min(FINAL_RESPONSE_STREAM_MARKER.length-1,withoutMarker.length);
  for (let length = maxPending; length > 0; length -= 1) {
    if (FINAL_RESPONSE_STREAM_MARKER.startsWith(withoutMarker.slice(-length))) {
      pendingLength = length;
      break;
    }
  }
  return {
    found,
    pending:pendingLength > 0 ? withoutMarker.slice(-pendingLength) : "",
    text:pendingLength > 0 ? withoutMarker.slice(0,-pendingLength) : withoutMarker,
  };
}

export function scanFinalResponseMarker(pending: string, chunk: string): FinalResponseMarkerScan {
  const combined = `${pending}${chunk}`;
  const markerIndex = combined.indexOf(FINAL_RESPONSE_STREAM_MARKER);
  if (markerIndex >= 0) {
    return {
      found: true,
      pending: "",
      finalText: combined.slice(markerIndex + FINAL_RESPONSE_STREAM_MARKER.length),
    };
  }
  return {
    found: false,
    pending: combined.slice(-(FINAL_RESPONSE_STREAM_MARKER.length - 1)),
    finalText: "",
  };
}

export function extractFinalResponseText(text: string): string {
  const markerIndex = text.indexOf(FINAL_RESPONSE_STREAM_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(markerIndex + FINAL_RESPONSE_STREAM_MARKER.length).replace(/^[ \t]*\r?\n/, "");
}
