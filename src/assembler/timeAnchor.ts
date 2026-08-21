import type { ExactTurnClock } from "./types";

export const DEFAULT_OWNER_TIMEZONE = "<YOUR_TIMEZONE>";

function formatLocalSecond(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

/**
 * Build an explicit, deterministic per-turn clock input for the assembler.
 * The assembler itself remains free of wall-clock reads.
 */
export function buildExactTurnClock(
  now: Date | number,
  timezone = DEFAULT_OWNER_TIMEZONE
): ExactTurnClock {
  const instantMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(instantMs)) throw new Error("invalid_clock_instant");

  // Intl validates the IANA zone and formats the owner-local wall clock.
  const instant = new Date(instantMs);

  return {
    instantUtc: instant.toISOString(),
    localTime: formatLocalSecond(instant, timezone),
    timezone,
  };
}
