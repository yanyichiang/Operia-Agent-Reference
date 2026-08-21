export const DEFAULT_TG_DEBOUNCE_SECONDS = 1.5;
export const DEFAULT_TG_DEBOUNCE_MAX_SECONDS = 5;
export const MAX_TG_DEBOUNCE_SECONDS = 10;
export const MAX_TG_DEBOUNCE_WINDOW_SECONDS = 30;

type TgDebounceConfig = {
  TG_DEBOUNCE_SECONDS?: string;
  TG_DEBOUNCE_MAX_SECONDS?: string;
};

function boundedSeconds(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed,max) : fallback;
}

export function readTgDebounceWindow(config: TgDebounceConfig): { quietMs:number; maxWindowMs:number } {
  const quietMs = Math.round(boundedSeconds(
    config.TG_DEBOUNCE_SECONDS,
    DEFAULT_TG_DEBOUNCE_SECONDS,
    MAX_TG_DEBOUNCE_SECONDS,
  ) * 1000);
  const configuredMaxMs = Math.round(boundedSeconds(
    config.TG_DEBOUNCE_MAX_SECONDS,
    DEFAULT_TG_DEBOUNCE_MAX_SECONDS,
    MAX_TG_DEBOUNCE_WINDOW_SECONDS,
  ) * 1000);
  return { quietMs,maxWindowMs:Math.max(quietMs,configuredMaxMs) };
}

export function initialTgQueueDelaySeconds(_config: TgDebounceConfig): number {
  // Wake the consumer immediately. Cloudflare Queue delivery delay is not a
  // precise timer and re-enqueuing the same chat for the sub-second remainder
  // can turn a 1.5s quiet window into many seconds of queue lag. The consumer
  // owns the bounded quiet wait and still respects the hard aggregation cap.
  return 0;
}

export function adaptiveQuietDelayMsForTimestamps(
  oldestCreatedAt: string,
  latestCreatedAt: string,
  quietMs: number,
  maxWindowMs: number,
  nowMs = Date.now(),
): number {
  const oldestMs = Date.parse(oldestCreatedAt);
  const latestMs = Date.parse(latestCreatedAt);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(latestMs)) return Math.max(1,Math.ceil(quietMs));
  const quietDeadline = latestMs + Math.max(0,quietMs);
  const hardDeadline = oldestMs + Math.max(quietMs,maxWindowMs);
  return Math.max(0,Math.ceil(Math.min(quietDeadline,hardDeadline) - nowMs));
}
