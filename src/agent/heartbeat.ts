export type HeartbeatMode = "off" | "observe" | "active";
export type HeartbeatIntentKind = "prefix_warm" | "companion_pulse";
export type HeartbeatDecision =
  | { kind: "noop"; reason: string }
  | { kind: "say"; text: string; reason: string }
  | { kind: "delegate"; task: string; reason: string };

export type HeartbeatCapabilities = {
  say: boolean;
  operiaRead: boolean;
  mcpRead: boolean;
  search: boolean;
  browserRead: boolean;
};

export type HeartbeatConfig = {
  mode: HeartbeatMode;
  prompt: string;
  timezone: string;
  quietHours: { start: string; end: string };
  pulseHours: number[];
  jitterMinutes: number;
  dailyLimit: number;
  warmEnabled: boolean;
  warmWindowMinutes: number;
  warmIntervalMinutes: number;
  capabilities: HeartbeatCapabilities;
  dryRun: boolean;
  browserMaxSteps: number;
  browserTimeoutSeconds: number;
};

export type HeartbeatRuntime = {
  mode: HeartbeatMode;
  activatedAt: string | null;
  lastRealActivityAt: string | null;
  lastWarmAt: string | null;
  localDate: string;
  pulsesUsed: number;
  firstPulseDryRunPending: boolean;
};

export type SafeHeartbeatTool = {
  serverId: string;
  toolName: string;
  riskLevel: string;
  capability?: string;
  requiresApproval?: boolean;
  requiresElicitation?: boolean;
};

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  mode: "observe",
  prompt: "",
  timezone: "<YOUR_TIMEZONE>",
  quietHours: { start: "23:00", end: "08:00" },
  pulseHours: [10, 15, 20],
  jitterMinutes: 25,
  dailyLimit: 3,
  warmEnabled: true,
  warmWindowMinutes: 45,
  // The production stable prefix uses a 1h TTL. A 40m cadence leaves one cron
  // retry window before the 45m activity cutoff, without 5m keepalive spam.
  warmIntervalMinutes: 40,
  capabilities: { say: true, operiaRead: true, mcpRead: true, search: true, browserRead: true },
  dryRun: false,
  browserMaxSteps: 8,
  browserTimeoutSeconds: 90,
};

const HARD_DENIED_TOOL = /(login|sign.?in|auth(?:orize|entication)?|oauth|payment|purchase|checkout|post|publish|email|mail|memory.*(?:write|set|upsert|delete)|home.?assistant|call_service|generate_image|speak|voice|elicitation|approval)/i;
const IANA_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeHeartbeatConfig(value: unknown): HeartbeatConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("heartbeat_config_invalid");
  const input = value as Record<string, unknown>;
  // `armed` is a read-only legacy alias. Persisted legacy rows migrate to
  // Observe, which records activity but never creates an autonomous grant.
  const mode = input.mode === "off" || input.mode === "active" || input.mode === "observe"
    ? input.mode : input.mode === "armed" ? "observe" : DEFAULT_HEARTBEAT_CONFIG.mode;
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length > 4_000) throw new Error("heartbeat_prompt_too_long");
  const timezone = typeof input.timezone === "string" ? input.timezone.trim() : DEFAULT_HEARTBEAT_CONFIG.timezone;
  if (!IANA_ZONE.test(timezone)) throw new Error("heartbeat_timezone_invalid");
  // Force validation in runtimes with Intl time-zone data.
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0)); }
  catch { throw new Error("heartbeat_timezone_invalid"); }
  const quiet = input.quietHours && typeof input.quietHours === "object" && !Array.isArray(input.quietHours)
    ? input.quietHours as Record<string, unknown> : DEFAULT_HEARTBEAT_CONFIG.quietHours;
  const quietHours = { start: String(quiet.start ?? ""), end: String(quiet.end ?? "") };
  if (!CLOCK.test(quietHours.start) || !CLOCK.test(quietHours.end)) throw new Error("heartbeat_quiet_hours_invalid");
  const pulseHours = Array.isArray(input.pulseHours)
    ? [...new Set(input.pulseHours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b)
    : [...DEFAULT_HEARTBEAT_CONFIG.pulseHours];
  if (pulseHours.length > 6) throw new Error("heartbeat_pulse_hours_invalid");
  const capabilities = normalizeCapabilities(input.capabilities);
  return {
    mode,
    prompt,
    timezone,
    quietHours,
    pulseHours,
    jitterMinutes: integer(input.jitterMinutes, DEFAULT_HEARTBEAT_CONFIG.jitterMinutes, 0, 59),
    dailyLimit: integer(input.dailyLimit, DEFAULT_HEARTBEAT_CONFIG.dailyLimit, 0, 3),
    warmEnabled: input.warmEnabled === undefined ? true : input.warmEnabled === true,
    warmWindowMinutes: integer(input.warmWindowMinutes, 45, 1, 45),
    warmIntervalMinutes: integer(input.warmIntervalMinutes, 40, 4, 45),
    capabilities,
    dryRun: input.dryRun === true,
    browserMaxSteps: integer(input.browserMaxSteps, 8, 1, 8),
    browserTimeoutSeconds: integer(input.browserTimeoutSeconds, 90, 5, 90),
  };
}

export function initialHeartbeatRuntime(now = new Date(), config = DEFAULT_HEARTBEAT_CONFIG): HeartbeatRuntime {
  return {
    mode: config.mode,
    activatedAt: null,
    lastRealActivityAt: null,
    lastWarmAt: null,
    localDate: localDateKey(now, config.timezone),
    pulsesUsed: 0,
    firstPulseDryRunPending: true,
  };
}

export function resolveHeartbeatActivationMode(
  requestedMode: HeartbeatMode,
  hasActiveGrant: boolean,
): { effectiveMode: HeartbeatMode; activationRequired: boolean } {
  if (requestedMode !== "active") return { effectiveMode: requestedMode, activationRequired: false };
  return hasActiveGrant
    ? { effectiveMode: "active", activationRequired: false }
    : { effectiveMode: "observe", activationRequired: true };
}

export function applyRealActivity(runtime: HeartbeatRuntime, config: HeartbeatConfig, at: Date): HeartbeatRuntime {
  if (config.mode === "off" || runtime.mode === "off") return { ...runtime, mode: "off" };
  const timestamp = at.toISOString();
  return {
    ...rollHeartbeatDay(runtime, config, at),
    // Natural activity is evidence for Observe. It must not create the
    // standing authorization required for Active.
    mode: runtime.mode,
    activatedAt: runtime.mode === "active" ? runtime.activatedAt : null,
    lastRealActivityAt: timestamp,
  };
}

export function qualifiesAsRealActivity(kind: string): boolean {
  return kind === "natural_text" || kind === "natural_voice";
}

export function warmDue(runtime: HeartbeatRuntime, config: HeartbeatConfig, now: Date): boolean {
  if (runtime.mode !== "active" || config.mode === "off" || !config.warmEnabled || !runtime.lastRealActivityAt) return false;
  const activityAt = Date.parse(runtime.lastRealActivityAt);
  const age = now.getTime() - activityAt;
  if (age < 0 || age > config.warmWindowMinutes * 60_000) return false;
  const reference = runtime.lastWarmAt ? Date.parse(runtime.lastWarmAt) : activityAt;
  return now.getTime() - reference >= config.warmIntervalMinutes * 60_000;
}

export function pulseDue(runtime: HeartbeatRuntime, config: HeartbeatConfig, now: Date): { due: boolean; slotKey?: string; dryRun?: boolean } {
  const rolled = rollHeartbeatDay(runtime, config, now);
  if (rolled.mode !== "active" || config.mode === "off" || rolled.pulsesUsed >= config.dailyLimit || isQuietHour(now, config)) return { due: false };
  const local = localParts(now, config.timezone);
  // Pick the latest due slot. This lets a delayed minute cron recover the
  // current slot without replaying every older slot in a burst.
  for (let slot = config.pulseHours.length - 1; slot >= 0; slot -= 1) {
    const hour = config.pulseHours[slot];
    const jitter = deterministicJitterMinutes(`${local.date}:${slot}:${hour}`, config.jitterMinutes);
    const dueMinute = hour * 60 + jitter;
    if (local.minuteOfDay >= dueMinute) {
      return { due: true, slotKey: `${local.date}:${slot}`, dryRun: config.dryRun || rolled.firstPulseDryRunPending };
    }
  }
  return { due: false };
}

export function rollHeartbeatDay(runtime: HeartbeatRuntime, config: HeartbeatConfig, now: Date): HeartbeatRuntime {
  const date = localDateKey(now, config.timezone);
  return runtime.localDate === date ? runtime : { ...runtime, localDate: date, pulsesUsed: 0 };
}

export function isQuietHour(now: Date, config: Pick<HeartbeatConfig, "timezone" | "quietHours">): boolean {
  const minute = localParts(now, config.timezone).minuteOfDay;
  const start = clockMinute(config.quietHours.start);
  const end = clockMinute(config.quietHours.end);
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function deterministicJitterMinutes(seed: string, maximum: number): number {
  if (maximum <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (maximum + 1);
}

export function filterHeartbeatTools(tools: ReadonlyArray<SafeHeartbeatTool>, config: HeartbeatConfig): SafeHeartbeatTool[] {
  return tools.filter((tool) => {
    if (tool.riskLevel !== "read" || tool.requiresApproval || tool.requiresElicitation) return false;
    if (HARD_DENIED_TOOL.test(`${tool.serverId}:${tool.toolName}:${tool.capability ?? ""}`)) return false;
    if (tool.serverId === "browser") return config.capabilities.browserRead;
    if (tool.serverId === "grok" && tool.toolName === "search_web") return config.capabilities.search;
    if (tool.serverId === "operia-observer") return config.capabilities.operiaRead;
    return config.capabilities.mcpRead;
  });
}

export function parseHeartbeatDecision(value: unknown, config: HeartbeatConfig): HeartbeatDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("heartbeat_decision_invalid");
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const reason = boundedText(record.reason, 500, false);
  if (kind === "noop") return { kind, reason };
  if (kind === "say") {
    if (!config.capabilities.say) throw new Error("heartbeat_say_disabled");
    return { kind, text: boundedText(record.text, 4_000, true), reason };
  }
  if (kind === "delegate") return { kind, task: boundedText(record.task, 2_000, true), reason };
  throw new Error("heartbeat_decision_invalid");
}

function normalizeCapabilities(value: unknown): HeartbeatCapabilities {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    say: input.say !== false,
    operiaRead: input.operiaRead !== false,
    mcpRead: input.mcpRead !== false,
    search: input.search !== false,
    browserRead: input.browserRead !== false,
  };
}

function localDateKey(now: Date, timezone: string): string {
  return localParts(now, timezone).date;
}

function localParts(now: Date, timezone: string): { date: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = read("year"); const month = read("month"); const day = read("day");
  return { date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, minuteOfDay: read("hour") * 60 + read("minute") };
}

function clockMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (parsed < minimum || parsed > maximum) throw new Error("heartbeat_config_out_of_range");
  return parsed;
}

function boundedText(value: unknown, maximum: number, required: boolean): string {
  const text = typeof value === "string" ? value.trim() : "";
  if ((required && !text) || text.length > maximum) throw new Error("heartbeat_decision_text_invalid");
  return text;
}
