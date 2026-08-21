import type { CalendarProjectionEvent } from "../calendar/types";
import type { Env } from "../types";
import { getCalendarProjection } from "./calendarClient";

const MAX_AMBIENT_BYTES = 2_048;
const TIMEZONE = "<YOUR_TIMEZONE>";

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function boundedText(value: unknown, maxChars = 160): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars) : "";
}

function localTimestamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function eventLine(kind: "current" | "next", event: CalendarProjectionEvent | undefined): string | null {
  if (!event) return null;
  return `calendar.${kind}=title:${boundedText(event.title, 120)}|start:${event.start}|end:${event.end}|status:${event.status}|observed_at:${event.observedAt}`;
}

function boundedLines(lines: Array<string | null>): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (!line) continue;
    const next = new TextEncoder().encode(`${kept.length ? "\n" : ""}${line}`).byteLength;
    if (bytes + next > MAX_AMBIENT_BYTES) break;
    kept.push(line);
    bytes += next;
  }
  return kept.join("\n");
}

/**
 * Build a per-turn, non-model ambient snapshot. The `[动态上下文]` header is
 * intentionally recognized by the Memory Prompt Assembler and routed after all
 * prompt-cache breakpoints.
 */
export async function buildTelegramAmbientContext(env: Env, chatId: string, now = new Date()): Promise<string | null> {
  if (!enabled(env.TG_AMBIENT_CONTEXT_ENABLED)) return null;
  const ownerChatId = env.TG_AGENT_OWNER_CHAT_ID?.trim();
  const ownerId = env.TG_AGENT_OWNER_ID?.trim();
  if (!ownerChatId || !ownerId || chatId !== ownerChatId) return null;

  let calendarStatus = enabled(env.CALENDAR_GOOGLE_ENABLED) ? "unavailable" : "disabled";
  let calendarObservedAt: string | null = null;
  let calendarStaleAfter: string | null = null;
  let current: CalendarProjectionEvent | undefined;
  let next: CalendarProjectionEvent | undefined;
  let remainingToday: number | null = null;
  if (enabled(env.CALENDAR_GOOGLE_ENABLED) && env.CALENDAR_SERVICE) {
    try {
      const projection = await getCalendarProjection(env, ownerId);
      calendarStatus = projection.status;
      calendarObservedAt = projection.observedAt;
      calendarStaleAfter = projection.staleAfter;
      current = projection.current;
      next = projection.next;
      remainingToday = projection.remainingToday;
    } catch {
      calendarStatus = "unavailable";
    }
  }

  return boundedLines([
    "[动态上下文]",
    "schema=operia.ambient.v1",
    `local_time=${localTimestamp(now)}|timezone=${TIMEZONE}`,
    `calendar.owner=calendar.example.com|status=${calendarStatus}|observed_at=${calendarObservedAt ?? "missing"}|stale_after=${calendarStaleAfter ?? "missing"}`,
    eventLine("current", current),
    eventLine("next", next),
    remainingToday === null ? null : `calendar.remaining_today=${Math.max(0, Math.floor(remainingToday))}`,
    "unavailable_sources=weather,tasks,home; do not infer their current state",
    "Use this snapshot only when naturally relevant. Do not recite it by default. For exact details, freshness, wider windows, or any action, use the canonical owner tool.",
  ]);
}
