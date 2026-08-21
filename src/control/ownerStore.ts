import type { Env } from "../types";
import { CONTROL_REGISTRY_VERSION, controlDefinitionsFor, memoryOwnerStoreKeys } from "../controlRegistry";
import { resolveCandidates, resolveControlValue, type EffectiveControlValue } from "./resolver";
import { assertRevisionCas } from "./revision";
import { assertAllowedScope, controlScopeKey, parseControlScopeRef } from "./scope";
import type { ControlActor, ControlOverride, ControlParameterDefinition, ControlScopeRef, ControlValue, NextTurnClaim, NextTurnScopeRef } from "./types";

export const MEMORY_REASONING_KEYS = [
  "memory.inference.reasoning.enabled",
  "memory.inference.reasoning.effort",
  "memory.inference.sampling.temperature",
  "memory.inference.reasoning.legacy_budget_tokens",
] as const;

export type MemoryReasoningKey = (typeof MEMORY_REASONING_KEYS)[number];
export const MEMORY_OWNER_STORE_KEYS = ["memory.inference.chat_model", ...MEMORY_REASONING_KEYS] as const;
export type MemoryControlKey = (typeof MEMORY_OWNER_STORE_KEYS)[number];
export const MEMORY_CONTROL_KEYS: readonly string[] = memoryOwnerStoreKeys();

type ValueRow = {
  key: string;
  value_json: string;
  revision: number;
  owner_version: number;
  actor_type: ControlActor["type"];
  actor_id: string;
  updated_at: string;
};

type OverrideRow = {
  id: string;
  key: string;
  scope_type: string;
  channel: string;
  recipient_type: string;
  recipient_id: string;
  value_json: string;
  revision: number;
  owner_version: number;
  expires_at: string | null;
  actor_type: "user" | "service";
  actor_id: string;
  source_domain: string;
  created_at: string;
  updated_at: string;
};

export type ControlMutationActor = { type: "user" | "service" | "migration"; id: string; sourceDomain: string };

export type MemoryControlSnapshot = {
  registryVersion: string;
  ownerDomain: "memory.example.com";
  ownerVersion: string;
  scope: ControlScopeRef | null;
  values: Array<EffectiveControlValue & {
    globalValue: unknown;
    globalRevision: number;
    overrideValue?: unknown;
    overrideRevision: number;
    canOverride: boolean;
    canReset: boolean;
    updatedAt: string;
    deepLink: string;
    runtimeStatus?: "active" | "inactive_due_to_adaptive_thinking" | "legacy_compatibility_only";
  }>;
  request: {
    model: string;
    thinking: { type: "adaptive"; display: "summarized" } | null;
    effort: "low" | "medium" | "high" | "max";
    temperature: number | null;
  };
  observedAt: string;
};

const OWNER = "memory.example.com" as const;

function definition(key: string): ControlParameterDefinition {
  const found = controlDefinitionsFor(OWNER).find((item) => item.key === key);
  if (!found) throw new Error(`unknown_memory_control_key:${key}`);
  if (found.implementation.kind === "env_projection" || found.implementation.kind === "runtime_projection") {
    throw new Error(`control_read_only:${key}`);
  }
  if (found.implementation.kind !== "owner_store") {
    throw new Error(`control_has_dedicated_owner:${key}`);
  }
  return found;
}

function legacyValue(env: Env, key: MemoryControlKey): unknown {
  if (key === "memory.inference.chat_model") return env.CHAT_MODEL?.trim() || env.DEFAULT_UPSTREAM_MODEL?.trim() || "anthropic/claude-opus-4.6";
  if (key === "memory.inference.reasoning.enabled") return env.ANTHROPIC_THINKING_ENABLED?.trim().toLowerCase() === "true";
  if (key === "memory.inference.reasoning.effort") return "medium";
  if (key === "memory.inference.sampling.temperature") return 1;
  return Math.max(1024, Number(env.ANTHROPIC_THINKING_BUDGET) || 1024);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function ownerVersion(value: number): string {
  return `memory-control-${Math.max(0, value)}`;
}

function toControlValue(row: ValueRow): ControlValue {
  return {
    key: row.key,
    value: parseJson(row.value_json),
    revision: row.revision,
    ownerVersion: ownerVersion(row.owner_version),
    updatedAt: row.updated_at,
    actor: { type: row.actor_type, id: row.actor_id },
  };
}

function rowScope(row: OverrideRow): ControlScopeRef {
  if (row.scope_type === "channel") return { type: "channel", channel: row.channel };
  if (row.scope_type === "chat") return { type: "chat", channel: row.channel, chatId: row.recipient_id };
  if (row.scope_type === "device") return { type: "device", channel: row.channel, deviceId: row.recipient_id };
  if (row.scope_type === "next_turn" && (row.recipient_type === "chat" || row.recipient_type === "device")) {
    return { type: "next_turn", channel: row.channel, recipientType: row.recipient_type, recipientId: row.recipient_id };
  }
  throw new Error("invalid_stored_control_scope");
}

function toOverride(row: OverrideRow): ControlOverride {
  return {
    id: row.id,
    key: row.key,
    scopeRef: rowScope(row),
    value: parseJson(row.value_json),
    revision: row.revision,
    ownerVersion: ownerVersion(row.owner_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    idempotencyKey: `stored:${row.id}`,
    actor: { type: row.actor_type, id: row.actor_id, sourceDomain: row.source_domain },
  };
}

async function currentOwnerVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT owner_version FROM control_owner_meta WHERE owner_domain=?")
    .bind(OWNER).first<{ owner_version: number }>();
  return Number(row?.owner_version || 0);
}

async function bumpOwnerVersion(db: D1Database): Promise<number> {
  const now = new Date().toISOString();
  await db.prepare("INSERT OR IGNORE INTO control_owner_meta(owner_domain,owner_version,updated_at) VALUES(?,0,?)").bind(OWNER, now).run();
  const row = await db.prepare("UPDATE control_owner_meta SET owner_version=owner_version+1,updated_at=? WHERE owner_domain=? RETURNING owner_version")
    .bind(now, OWNER).first<{ owner_version: number }>();
  if (!row) throw new Error("control_owner_version_update_failed");
  return row.owner_version;
}

async function hashValue(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeEvent(db: D1Database, input: {
  key: string;
  action: string;
  scopeKey: string;
  actor: ControlMutationActor;
  oldValue?: unknown;
  newValue?: unknown;
  revision: number;
  ownerVersion: number;
  requestId?: string;
}): Promise<void> {
  await db.prepare(`INSERT INTO control_events
    (id,key,action,scope_key,actor_type,actor_id,source_domain,old_value_hash,new_value_hash,revision,owner_version,request_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(), input.key, input.action, input.scopeKey, input.actor.type, input.actor.id,
      input.actor.sourceDomain, input.oldValue === undefined ? null : await hashValue(input.oldValue),
      input.newValue === undefined ? null : await hashValue(input.newValue), input.revision, input.ownerVersion,
      input.requestId ?? null, new Date().toISOString(),
    ).run();
}

function validateValue(key: string, value: unknown): void {
  resolveCandidates(definition(key), [{ value, source: "mutation" }]);
}

function assertMutationSource(def: ControlParameterDefinition, actor: ControlMutationActor, scope: "global" | ControlScopeRef): void {
  if (!def.mutableFrom.includes(actor.sourceDomain)) throw new Error("mutation_source_not_allowed");
  if (actor.type === "service" && scope === "global") throw new Error("service_global_mutation_not_allowed");
  if (actor.sourceDomain === "tgbot.example.com" && scope !== "global" && scope.channel !== "telegram") {
    throw new Error("service_scope_not_allowed");
  }
}

async function globalRows(db: D1Database): Promise<Map<string, ValueRow>> {
  const rows = await db.prepare(`SELECT key,value_json,revision,owner_version,actor_type,actor_id,updated_at
    FROM control_values WHERE key IN (${MEMORY_CONTROL_KEYS.map(() => "?").join(",")})`)
    .bind(...MEMORY_CONTROL_KEYS).all<ValueRow>();
  return new Map((rows.results || []).map((row) => [row.key, row]));
}

async function overrideRows(db: D1Database): Promise<OverrideRow[]> {
  const rows = await db.prepare(`SELECT id,key,scope_type,channel,recipient_type,recipient_id,value_json,revision,owner_version,
    expires_at,actor_type,actor_id,source_domain,created_at,updated_at FROM control_overrides
    WHERE key IN (${MEMORY_CONTROL_KEYS.map(() => "?").join(",")})`)
    .bind(...MEMORY_CONTROL_KEYS).all<OverrideRow>();
  return rows.results || [];
}

export async function getMemoryControlSnapshot(env: Env, targetScope?: ControlScopeRef): Promise<MemoryControlSnapshot> {
  const parsedScope = targetScope ? parseControlScopeRef(targetScope) : undefined;
  const [globals, storedOverrides, version] = await Promise.all([globalRows(env.DB), overrideRows(env.DB), currentOwnerVersion(env.DB)]);
  const values: MemoryControlSnapshot["values"] = MEMORY_CONTROL_KEYS.map((key) => {
    const def = definition(key);
    const storedGlobal = globals.get(key);
    const globalValue = storedGlobal ? toControlValue(storedGlobal) : {
      key, value: legacyValue(env, key as MemoryControlKey), revision: 0, ownerVersion: ownerVersion(version),
      updatedAt: "1970-01-01T00:00:00.000Z", actor: { type: "migration" as const, id: "legacy-default" },
    };
    const overrides = storedOverrides.filter((row) => row.key === key).map(toOverride);
    const effectiveScope = parsedScope && def.allowedScopes.includes(parsedScope.type) ? parsedScope : undefined;
    const effective = resolveControlValue({ definition: def, globalValue, overrides, targetScope: effectiveScope });
    const applied = overrides.find((override) => effective.appliedOverrideIds.includes(override.id));
    return {
      ...effective,
      ownerVersion: ownerVersion(version),
      globalValue: globalValue.value,
      globalRevision: globalValue.revision,
      overrideValue: applied?.value,
      overrideRevision: applied?.revision ?? 0,
      canOverride: Boolean(parsedScope && def.allowedScopes.includes(parsedScope.type)),
      canReset: Boolean(applied),
      updatedAt: applied?.updatedAt ?? globalValue.updatedAt,
      deepLink: `https://memory.example.com/admin/inference?config_key=${encodeURIComponent(key)}`,
    };
  });
  const enabled = Boolean(values.find((item) => item.key === "memory.inference.reasoning.enabled")?.effectiveValue);
  const model = String(values.find((item) => item.key === "memory.inference.chat_model")?.effectiveValue || legacyValue(env, "memory.inference.chat_model"));
  const effort = String(values.find((item) => item.key === "memory.inference.reasoning.effort")?.effectiveValue || "medium") as MemoryControlSnapshot["request"]["effort"];
  const temperatureEntry = values.find((item) => item.key === "memory.inference.sampling.temperature")!;
  const legacy = values.find((item) => item.key === "memory.inference.reasoning.legacy_budget_tokens")!;
  temperatureEntry.runtimeStatus = enabled ? "inactive_due_to_adaptive_thinking" : "active";
  legacy.runtimeStatus = "legacy_compatibility_only";
  return {
    registryVersion: CONTROL_REGISTRY_VERSION,
    ownerDomain: OWNER,
    ownerVersion: ownerVersion(version),
    scope: parsedScope ?? null,
    values,
    request: {
      model,
      thinking: enabled ? { type: "adaptive", display: "summarized" } : null,
      effort,
      temperature: enabled ? null : Number(temperatureEntry.effectiveValue),
    },
    observedAt: new Date().toISOString(),
  };
}

export async function putMemoryGlobalControl(env: Env, input: {
  key: string;
  value: unknown;
  ifMatch: string | null;
  actor: ControlMutationActor;
  requestId?: string;
}): Promise<MemoryControlSnapshot> {
  const def = definition(input.key);
  if (!def.allowedScopes.includes("global")) throw new Error("control_global_scope_not_allowed");
  assertMutationSource(def, input.actor, "global");
  validateValue(input.key, input.value);
  const existing = await env.DB.prepare("SELECT key,value_json,revision,owner_version,actor_type,actor_id,updated_at FROM control_values WHERE key=?")
    .bind(input.key).first<ValueRow>();
  const nextRevision = assertRevisionCas(existing?.revision ?? 0, input.ifMatch);
  const nextOwnerVersion = await bumpOwnerVersion(env.DB);
  const now = new Date().toISOString();
  if (existing) {
    const result = await env.DB.prepare(`UPDATE control_values SET value_json=?,revision=?,owner_version=?,actor_type=?,actor_id=?,updated_at=?
      WHERE key=? AND revision=?`).bind(JSON.stringify(input.value), nextRevision, nextOwnerVersion, input.actor.type, input.actor.id, now, input.key, existing.revision).run();
    if (!result.meta.changes) throw new Error("revision_conflict");
  } else {
    await env.DB.prepare(`INSERT INTO control_values(key,value_json,revision,owner_version,actor_type,actor_id,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(input.key, JSON.stringify(input.value), nextRevision, nextOwnerVersion, input.actor.type, input.actor.id, now).run();
  }
  await writeEvent(env.DB, { key: input.key, action: existing ? "global.update" : "global.create", scopeKey: "global", actor: input.actor,
    oldValue: existing ? parseJson(existing.value_json) : undefined, newValue: input.value, revision: nextRevision, ownerVersion: nextOwnerVersion, requestId: input.requestId });
  return getMemoryControlSnapshot(env);
}

function scopeColumns(scope: ControlScopeRef): { scopeType: string; channel: string; recipientType: string; recipientId: string } {
  const parsed = parseControlScopeRef(scope);
  if (parsed.type === "channel") return { scopeType: parsed.type, channel: parsed.channel, recipientType: "", recipientId: "" };
  if (parsed.type === "chat") return { scopeType: parsed.type, channel: parsed.channel, recipientType: "chat", recipientId: parsed.chatId };
  if (parsed.type === "device") return { scopeType: parsed.type, channel: parsed.channel, recipientType: "device", recipientId: parsed.deviceId };
  return { scopeType: parsed.type, channel: parsed.channel, recipientType: parsed.recipientType, recipientId: parsed.recipientId };
}

async function findOverride(db: D1Database, key: string, scope: ControlScopeRef): Promise<OverrideRow | null> {
  const columns = scopeColumns(scope);
  return db.prepare(`SELECT id,key,scope_type,channel,recipient_type,recipient_id,value_json,revision,owner_version,
    expires_at,actor_type,actor_id,source_domain,created_at,updated_at FROM control_overrides
    WHERE key=? AND scope_type=? AND channel=? AND recipient_type=? AND recipient_id=?`)
    .bind(key, columns.scopeType, columns.channel, columns.recipientType, columns.recipientId).first<OverrideRow>();
}

export async function putMemoryControlOverride(env: Env, input: {
  key: string;
  scope: ControlScopeRef;
  value: unknown;
  ifMatch: string | null;
  actor: ControlMutationActor;
  expiresAt?: string;
  requestId?: string;
}): Promise<MemoryControlSnapshot> {
  const def = definition(input.key);
  const scope = parseControlScopeRef(input.scope);
  assertAllowedScope(scope, def.allowedScopes);
  assertMutationSource(def, input.actor, scope);
  validateValue(input.key, input.value);
  const existing = await findOverride(env.DB, input.key, scope);
  const nextRevision = assertRevisionCas(existing?.revision ?? 0, input.ifMatch);
  const nextOwnerVersion = await bumpOwnerVersion(env.DB);
  const now = new Date().toISOString();
  const columns = scopeColumns(scope);
  if (existing) {
    const result = await env.DB.prepare(`UPDATE control_overrides SET value_json=?,revision=?,owner_version=?,expires_at=?,actor_type=?,actor_id=?,source_domain=?,updated_at=?
      WHERE id=? AND revision=?`).bind(JSON.stringify(input.value), nextRevision, nextOwnerVersion, input.expiresAt ?? null,
        input.actor.type, input.actor.id, input.actor.sourceDomain, now, existing.id, existing.revision).run();
    if (!result.meta.changes) throw new Error("revision_conflict");
  } else {
    await env.DB.prepare(`INSERT INTO control_overrides(id,key,scope_type,channel,recipient_type,recipient_id,value_json,revision,owner_version,
      expires_at,actor_type,actor_id,source_domain,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), input.key, columns.scopeType, columns.channel, columns.recipientType, columns.recipientId,
        JSON.stringify(input.value), nextRevision, nextOwnerVersion, input.expiresAt ?? null, input.actor.type, input.actor.id,
        input.actor.sourceDomain, now, now).run();
  }
  await writeEvent(env.DB, { key: input.key, action: existing ? "override.update" : "override.create", scopeKey: controlScopeKey(scope), actor: input.actor,
    oldValue: existing ? parseJson(existing.value_json) : undefined, newValue: input.value, revision: nextRevision, ownerVersion: nextOwnerVersion, requestId: input.requestId });
  return getMemoryControlSnapshot(env, scope);
}

export async function deleteMemoryControlOverride(env: Env, input: {
  key: string;
  scope: ControlScopeRef;
  ifMatch: string | null;
  actor: ControlMutationActor;
  requestId?: string;
}): Promise<MemoryControlSnapshot> {
  const def = definition(input.key);
  const scope = parseControlScopeRef(input.scope);
  assertAllowedScope(scope, def.allowedScopes);
  assertMutationSource(def, input.actor, scope);
  const existing = await findOverride(env.DB, input.key, scope);
  if (!existing) throw new Error("control_override_not_found");
  const nextRevision = assertRevisionCas(existing.revision, input.ifMatch);
  const nextOwnerVersion = await bumpOwnerVersion(env.DB);
  const result = await env.DB.prepare("DELETE FROM control_overrides WHERE id=? AND revision=?").bind(existing.id, existing.revision).run();
  if (!result.meta.changes) throw new Error("revision_conflict");
  await writeEvent(env.DB, { key: input.key, action: "override.delete", scopeKey: controlScopeKey(scope), actor: input.actor,
    oldValue: parseJson(existing.value_json), revision: nextRevision, ownerVersion: nextOwnerVersion, requestId: input.requestId });
  return getMemoryControlSnapshot(env, scope);
}

export async function listMemoryControlEvents(env: Env, limit = 50): Promise<unknown[]> {
  const rows = await env.DB.prepare(`SELECT id,key,action,scope_key,actor_type,actor_id,source_domain,revision,owner_version,request_id,created_at
    FROM control_events ORDER BY created_at DESC LIMIT ?`).bind(Math.min(Math.max(limit, 1), 100)).all();
  return rows.results || [];
}

type StoredNextTurnClaim = {
  request_id: string;
  channel: string;
  recipient_type: "chat" | "device";
  recipient_id: string;
  owner_version: number;
  snapshot_hash: string;
  snapshot_json: string;
  override_ids_json: string;
  status: "claimed" | "released";
  claimed_at: string;
  released_at: string | null;
};

type StoredClaimPayload = { snapshot: MemoryControlSnapshot; consumed: OverrideRow[] };

function parseStoredClaim(row: StoredNextTurnClaim): NextTurnClaim {
  const payload = JSON.parse(row.snapshot_json) as StoredClaimPayload;
  return {
    requestId: row.request_id,
    ownerDomain: OWNER,
    scopeRef: { type: "next_turn", channel: row.channel, recipientType: row.recipient_type, recipientId: row.recipient_id },
    overrideIds: JSON.parse(row.override_ids_json) as string[],
    claimedAt: row.claimed_at,
    effectiveSnapshotHash: row.snapshot_hash,
    effectiveSnapshot: payload.snapshot as unknown as Record<string, unknown>,
  };
}

async function findNextTurnClaim(db: D1Database, requestId: string): Promise<StoredNextTurnClaim | null> {
  return db.prepare(`SELECT request_id,channel,recipient_type,recipient_id,owner_version,snapshot_hash,snapshot_json,
    override_ids_json,status,claimed_at,released_at FROM control_next_turn_claims WHERE request_id=?`)
    .bind(requestId).first<StoredNextTurnClaim>();
}

export async function claimMemoryNextTurn(env: Env, input: {
  requestId: string;
  scope: NextTurnScopeRef;
  actor: ControlMutationActor;
}): Promise<NextTurnClaim> {
  const scope = parseControlScopeRef(input.scope);
  if (scope.type !== "next_turn") throw new Error("invalid_next_turn_scope");
  const existing = await findNextTurnClaim(env.DB, input.requestId);
  if (existing) {
    if (existing.channel !== scope.channel || existing.recipient_type !== scope.recipientType || existing.recipient_id !== scope.recipientId) {
      throw new Error("next_turn_request_scope_conflict");
    }
    if (existing.status !== "claimed") throw new Error("next_turn_claim_released");
    return parseStoredClaim(existing);
  }

  const allOverrides = await overrideRows(env.DB);
  const consumed = allOverrides.filter((row) => row.scope_type === "next_turn" && row.channel === scope.channel
    && row.recipient_type === scope.recipientType && row.recipient_id === scope.recipientId);
  const snapshot = await getMemoryControlSnapshot(env, scope);
  const snapshotHash = await hashValue(snapshot);
  const overrideIds = consumed.map((row) => row.id);
  const now = new Date().toISOString();
  const version = await currentOwnerVersion(env.DB);
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO control_next_turn_claims
      (request_id,channel,recipient_type,recipient_id,owner_version,snapshot_hash,snapshot_json,override_ids_json,status,claimed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(input.requestId, scope.channel, scope.recipientType, scope.recipientId, version,
        snapshotHash, JSON.stringify({ snapshot, consumed } satisfies StoredClaimPayload), JSON.stringify(overrideIds), "claimed", now),
    ...overrideIds.map((id) => env.DB.prepare("DELETE FROM control_overrides WHERE id=?").bind(id)),
  ];
  const results = await env.DB.batch(statements);
  const inserted = Number(results[0]?.meta.changes || 0);
  if (!inserted) {
    const raced = await findNextTurnClaim(env.DB, input.requestId);
    if (!raced) throw new Error("next_turn_claim_conflict");
    return parseStoredClaim(raced);
  }
  const deleted = results.slice(1).reduce((sum, result) => sum + Number(result.meta.changes || 0), 0);
  if (deleted !== overrideIds.length) {
    await env.DB.prepare("DELETE FROM control_next_turn_claims WHERE request_id=?").bind(input.requestId).run();
    throw new Error("next_turn_claim_conflict");
  }
  if (overrideIds.length) await bumpOwnerVersion(env.DB);
  for (const row of consumed) {
    await writeEvent(env.DB, { key: row.key, action: "next_turn.claim", scopeKey: controlScopeKey(scope), actor: input.actor,
      oldValue: parseJson(row.value_json), revision: row.revision, ownerVersion: version, requestId: input.requestId });
  }
  return {
    requestId: input.requestId,
    ownerDomain: OWNER,
    scopeRef: scope,
    overrideIds,
    claimedAt: now,
    effectiveSnapshotHash: snapshotHash,
    effectiveSnapshot: snapshot as unknown as Record<string, unknown>,
  };
}

export async function releaseMemoryNextTurn(env: Env, input: {
  requestId: string;
  scope: NextTurnScopeRef;
  actor: ControlMutationActor;
}): Promise<{ released: true; ownerVersion: string }> {
  const scope = parseControlScopeRef(input.scope);
  if (scope.type !== "next_turn") throw new Error("invalid_next_turn_scope");
  const row = await findNextTurnClaim(env.DB, input.requestId);
  if (!row || row.status !== "claimed") throw new Error("next_turn_claim_not_found");
  if (row.channel !== scope.channel || row.recipient_type !== scope.recipientType || row.recipient_id !== scope.recipientId) {
    throw new Error("next_turn_request_scope_conflict");
  }
  const payload = JSON.parse(row.snapshot_json) as StoredClaimPayload;
  const nextOwnerVersion = await bumpOwnerVersion(env.DB);
  const now = new Date().toISOString();
  const restore = payload.consumed.map((override) => env.DB.prepare(`INSERT INTO control_overrides
    (id,key,scope_type,channel,recipient_type,recipient_id,value_json,revision,owner_version,expires_at,actor_type,actor_id,source_domain,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(override.id, override.key, override.scope_type, override.channel,
      override.recipient_type, override.recipient_id, override.value_json, override.revision, nextOwnerVersion, override.expires_at,
      override.actor_type, override.actor_id, override.source_domain, override.created_at, now));
  await env.DB.batch([
    ...restore,
    env.DB.prepare("UPDATE control_next_turn_claims SET status='released',released_at=? WHERE request_id=? AND status='claimed'").bind(now, input.requestId),
  ]);
  for (const override of payload.consumed) {
    await writeEvent(env.DB, { key: override.key, action: "next_turn.release", scopeKey: controlScopeKey(scope), actor: input.actor,
      newValue: parseJson(override.value_json), revision: override.revision, ownerVersion: nextOwnerVersion, requestId: input.requestId });
  }
  return { released: true, ownerVersion: ownerVersion(nextOwnerVersion) };
}
