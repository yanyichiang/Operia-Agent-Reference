export type ThinkWaitUntil = (promise: Promise<unknown>) => void;

export type KnownThinkResultFinalization<T> = {
  persist: () => Promise<T>;
  observe: () => Promise<void>;
  waitUntil: ThinkWaitUntil;
  onTelemetryDegraded: (code: string) => void;
};

export async function runBestEffortThinkTelemetry(
  operation: () => Promise<void>,
  onTelemetryDegraded: (code: string) => void,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    onTelemetryDegraded(boundedTelemetryError(error));
    return false;
  }
}

/**
 * A known model result is canonical only after persistence succeeds. Telemetry
 * starts after that boundary and can never turn the persisted result into an
 * inference failure, even if the scheduler or the observation write fails.
 */
export async function finalizeKnownThinkResult<T>(input: KnownThinkResultFinalization<T>): Promise<T> {
  const persisted = await input.persist();
  const pending = runBestEffortThinkTelemetry(input.observe, input.onTelemetryDegraded);
  try {
    input.waitUntil(pending);
  } catch (error) {
    input.onTelemetryDegraded(boundedTelemetryError(error));
  }
  return persisted;
}

function boundedTelemetryError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n\t]+/g, " ").slice(0, 160) || "think_telemetry_failed";
}
