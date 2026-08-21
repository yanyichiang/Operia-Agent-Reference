import { ControlPlaneCoreError } from "./errors";
import { assertAllowedScope, controlScopeKey, parseControlScopeRef, scopeAppliesTo } from "./scope";
import type { ControlOverride, ControlParameterDefinition, ControlScopeRef, ControlValue } from "./types";

export type EffectiveControlValue = {
  key: string;
  effectiveValue: unknown;
  effectiveSource: string;
  ownerDomain: string;
  ownerVersion: string;
  revision: number;
  appliedOverrideIds: string[];
};

export type ResolveControlValueInput = {
  definition: ControlParameterDefinition;
  globalValue?: ControlValue;
  overrides?: readonly ControlOverride[];
  targetScope?: ControlScopeRef;
  now?: Date;
};

export type ControlResolutionCandidate = { value: unknown; source: string; overrideId?: string; isOverride?: boolean };

export function resolveControlValue(input: ResolveControlValueInput): EffectiveControlValue {
  validateDefinition(input.definition);
  validateControlDefinition(input.definition);
  const { definition } = input;
  const targetScope = input.targetScope ? parseControlScopeRef(input.targetScope) : undefined;
  if (targetScope) assertAllowedScope(targetScope, definition.allowedScopes);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ControlPlaneCoreError("invalid_candidate", "invalid_clock");

  const baseValue = input.globalValue?.value ?? definition.defaultValue;
  if (baseValue === undefined) throw new ControlPlaneCoreError("invalid_candidate", "missing_global_or_default");
  const candidates: ControlResolutionCandidate[] = [{ value: baseValue, source: input.globalValue ? "global" : "default" }];

  const matchingOverrides = (input.overrides ?? [])
    .map((override) => ({ override, scope: parseControlScopeRef(override.scopeRef) }))
    .filter(({ override, scope }) => {
      if (override.key !== definition.key) return false;
      assertAllowedScope(scope, definition.allowedScopes);
      if (isExpired(override.expiresAt, now)) return false;
      return targetScope ? scopeAppliesTo(scope, targetScope) : false;
    })
    .sort((left, right) => scopeRank(left.scope.type) - scopeRank(right.scope.type) || left.override.id.localeCompare(right.override.id));
  const matchingScopeKeys = matchingOverrides.map(({ scope }) => controlScopeKey(scope));
  if (new Set(matchingScopeKeys).size !== matchingScopeKeys.length) {
    throw new ControlPlaneCoreError("invalid_candidate", "duplicate_override_scope");
  }

  for (const { override, scope } of matchingOverrides) {
    candidates.push({ value: override.value, source: scopeSource(scope), overrideId: override.id, isOverride: true });
  }

  const resolved = resolveCandidates(definition, candidates);
  return {
    key: definition.key,
    effectiveValue: resolved.value,
    effectiveSource: resolved.source,
    ownerDomain: definition.ownerDomain,
    ownerVersion: input.globalValue?.ownerVersion ?? "definition",
    revision: Math.max(input.globalValue?.revision ?? 0, ...matchingOverrides.map(({ override }) => override.revision)),
    appliedOverrideIds: matchingOverrides.map(({ override }) => override.id),
  };
}

export function resolveCandidates(
  definition: ControlParameterDefinition,
  candidates: readonly ControlResolutionCandidate[],
): ControlResolutionCandidate {
  if (candidates.length === 0) throw new ControlPlaneCoreError("invalid_candidate", "empty_candidates");
  for (const candidate of candidates) {
    if (!matchesSchema(candidate.value, definition.valueSchema)) {
      throw new ControlPlaneCoreError("invalid_candidate", candidate.source);
    }
    if (candidate.isOverride && definition.policyEnvelope !== undefined && !matchesSchema(candidate.value, definition.policyEnvelope)) {
      throw new ControlPlaneCoreError("invalid_candidate", `${candidate.source}_outside_envelope`);
    }
  }

  if (definition.implementation.resolution?.kind === "custom") {
    throw new ControlPlaneCoreError("custom_resolution_required", definition.implementation.resolution.adapter);
  }

  let result: ControlResolutionCandidate;
  switch (definition.resolutionStrategy) {
    case "replace_within_envelope":
      result = candidates[candidates.length - 1];
      break;
    case "numeric_min":
      result = numericExtreme(candidates, Math.min);
      break;
    case "numeric_max":
      result = numericExtreme(candidates, Math.max);
      break;
    case "set_intersection":
      result = intersectCandidates(candidates);
      break;
    case "deny_only":
      result = denyOnly(candidates);
      break;
  }
  return applyHardLimit(result, definition);
}

function applyHardLimit(candidate: ControlResolutionCandidate, definition: ControlParameterDefinition): ControlResolutionCandidate {
  const hardLimit = definition.hardLimit;
  if (hardLimit === undefined) return candidate;
  if (definition.resolutionStrategy === "numeric_min") {
    return numericExtreme([candidate, { value: hardLimit, source: "owner_hard_limit" }], Math.min);
  }
  if (definition.resolutionStrategy === "numeric_max") {
    return numericExtreme([candidate, { value: hardLimit, source: "owner_hard_limit" }], Math.max);
  }
  if (definition.resolutionStrategy === "set_intersection") {
    return intersectCandidates([candidate, { value: hardLimit, source: "owner_hard_limit" }]);
  }
  if (definition.resolutionStrategy === "deny_only") {
    return denyOnly([candidate, { value: hardLimit, source: "owner_hard_limit" }]);
  }
  if (Array.isArray(hardLimit) && !hardLimit.includes(String(candidate.value))) {
    throw new ControlPlaneCoreError("invalid_candidate", "outside_hard_limit");
  }
  if (typeof hardLimit === "boolean" && hardLimit === false && candidate.value === true) {
    return { value: false, source: "owner_hard_limit" };
  }
  return candidate;
}

function numericExtreme(
  candidates: readonly ControlResolutionCandidate[],
  operation: (...values: number[]) => number,
): ControlResolutionCandidate {
  if (!candidates.every(({ value }) => typeof value === "number" && Number.isFinite(value))) {
    throw new ControlPlaneCoreError("invalid_candidate", "numeric_strategy_requires_numbers");
  }
  const value = operation(...candidates.map((candidate) => candidate.value as number));
  const source = findLastCandidate(candidates, (candidate) => candidate.value === value)?.source ?? candidates[0].source;
  return { value, source };
}

function intersectCandidates(candidates: readonly ControlResolutionCandidate[]): ControlResolutionCandidate {
  if (!candidates.every(({ value }) => Array.isArray(value) && value.every((item) => typeof item === "string"))) {
    throw new ControlPlaneCoreError("invalid_candidate", "set_strategy_requires_string_arrays");
  }
  const [first, ...rest] = candidates;
  const value = [...new Set(first.value as string[])].filter((item) => rest.every((candidate) => (candidate.value as string[]).includes(item)));
  return { value, source: candidates.length === 1 ? first.source : candidates[candidates.length - 1].source };
}

function denyOnly(candidates: readonly ControlResolutionCandidate[]): ControlResolutionCandidate {
  if (!candidates.every(({ value }) => typeof value === "boolean")) {
    throw new ControlPlaneCoreError("invalid_candidate", "deny_only_requires_booleans");
  }
  const denied = findLastCandidate(candidates, (candidate) => candidate.value === false);
  return denied ? { value: false, source: denied.source } : { value: true, source: candidates[0].source };
}

function validateDefinition(definition: ControlParameterDefinition): void {
  if (!definition.key || !definition.ownerDomain || !definition.allowedScopes.includes("global")) {
    throw new ControlPlaneCoreError("invalid_definition", definition.key || "unknown_key");
  }
  if (new Set(definition.allowedScopes).size !== definition.allowedScopes.length) {
    throw new ControlPlaneCoreError("invalid_definition", "duplicate_allowed_scope");
  }
}

export function validateControlDefinition(definition: ControlParameterDefinition): void {
  if (!definition.implementation) {
    throw new ControlPlaneCoreError("invalid_definition", `missing_implementation:${definition.key}`);
  }

  const strategy = definition.resolutionStrategy;
  const schema = definition.valueSchema;
  const hardLimit = definition.hardLimit;

  function schemaType(): string | undefined {
    if (typeof schema !== "object" || schema === null) return undefined;
    const type = (schema as Record<string, unknown>).type;
    if (Array.isArray(type) && type.length > 0 && typeof type[0] === "string") return type[0];
    if (typeof type === "string") return type;
    return undefined;
  }

  if (strategy === "numeric_min" || strategy === "numeric_max") {
    const type = schemaType();
    if (type !== "number" && type !== "integer") {
      throw new ControlPlaneCoreError("invalid_definition", `numeric_strategy_requires_number_schema:${definition.key}`);
    }
    if (hardLimit !== undefined && typeof hardLimit !== "number") {
      throw new ControlPlaneCoreError("invalid_definition", `numeric_strategy_requires_number_hard_limit:${definition.key}`);
    }
  }

  if (strategy === "set_intersection") {
    const type = schemaType();
    if (type !== "array") {
      throw new ControlPlaneCoreError("invalid_definition", `set_strategy_requires_array_schema:${definition.key}`);
    }
    const itemSchema = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>).items : undefined;
    if (!(typeof itemSchema === "object" && itemSchema !== null && (itemSchema as Record<string, unknown>).type === "string")) {
      throw new ControlPlaneCoreError("invalid_definition", `set_strategy_requires_string_item_schema:${definition.key}`);
    }
    if (hardLimit !== undefined && !(Array.isArray(hardLimit) && hardLimit.every((item) => typeof item === "string"))) {
      throw new ControlPlaneCoreError("invalid_definition", `set_strategy_requires_string_array_hard_limit:${definition.key}`);
    }
  }

  if (strategy === "replace_within_envelope") {
    if (hardLimit !== undefined && !(Array.isArray(hardLimit) && hardLimit.every((item) => typeof item === "string"))) {
      throw new ControlPlaneCoreError("invalid_definition", `replace_strategy_requires_string_array_or_undefined:${definition.key}`);
    }
  }

  if (strategy === "deny_only") {
    const type = schemaType();
    if (type !== "boolean") {
      throw new ControlPlaneCoreError("invalid_definition", `deny_only_requires_boolean_schema:${definition.key}`);
    }
    if (hardLimit !== undefined && typeof hardLimit !== "boolean") {
      throw new ControlPlaneCoreError("invalid_definition", `deny_only_requires_boolean_hard_limit:${definition.key}`);
    }
  }

  if (definition.mutableFrom.length > 0) {
    if (definition.implementation.kind === "env_projection" || definition.implementation.kind === "runtime_projection") {
      throw new ControlPlaneCoreError("invalid_definition", `read_only_control_cannot_be_mutable:${definition.key}`);
    }
  }
}

function scopeRank(type: ControlScopeRef["type"]): number {
  if (type === "channel") return 1;
  if (type === "chat" || type === "device") return 2;
  return 3;
}

function scopeSource(scope: ControlScopeRef): string {
  if (scope.type === "channel") return `channel:${scope.channel}`;
  if (scope.type === "chat") return `chat:${scope.channel}:${scope.chatId}`;
  if (scope.type === "device") return `device:${scope.channel}:${scope.deviceId}`;
  return `next_turn:${scope.channel}:${scope.recipientType}:${scope.recipientId}`;
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) throw new ControlPlaneCoreError("invalid_candidate", "invalid_expiry");
  return timestamp <= now.getTime();
}

function matchesSchema(value: unknown, schema: boolean | Record<string, unknown>): boolean {
  if (typeof schema === "boolean") return schema;
  assertSupportedSchema(schema);
  if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => isSchema(item) && matchesSchema(value, item))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => isSchema(item) && matchesSchema(value, item))) return false;
  if (Array.isArray(schema.oneOf)
    && schema.oneOf.filter((item) => isSchema(item) && matchesSchema(value, item)).length !== 1) return false;
  if (isSchema(schema.not) && matchesSchema(value, schema.not)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if ("const" in schema && !Object.is(schema.const, value)) return false;
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) return false;
  if (Array.isArray(schema.type) && !schema.type.some((type) => typeof type === "string" && matchesType(value, type))) return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && value / schema.multipleOf % 1 !== 0) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((item) => matchesSchema(item, schema.items as Record<string, unknown>))) return false;
    if (schema.uniqueItems === true && new Set(value.map(stableValueKey)).size !== value.length) return false;
  }
  if (isRecord(value)) {
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return false;
    if (Array.isArray(schema.required)
      && !schema.required.every((key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(value, key))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isSchema(propertySchema)) {
        if (!matchesSchema(item, propertySchema)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (isSchema(schema.additionalProperties) && !matchesSchema(item, schema.additionalProperties)) {
        return false;
      }
    }
  }
  return true;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function findLastCandidate(
  candidates: readonly ControlResolutionCandidate[],
  predicate: (candidate: ControlResolutionCandidate) => boolean,
): ControlResolutionCandidate | undefined {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (predicate(candidates[index])) return candidates[index];
  }
  return undefined;
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$id", "$schema", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "enum", "const", "allOf", "anyOf", "oneOf", "not", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "items", "minProperties", "maxProperties", "required", "properties", "additionalProperties",
]);

function assertSupportedSchema(schema: Record<string, unknown>): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new ControlPlaneCoreError("invalid_definition", `unsupported_schema_keyword:${keyword}`);
    }
  }
}

function isSchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValueKey(value: unknown): string {
  if (!value || typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableValueKey).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${key}:${stableValueKey(item)}`)
    .join(",")}}`;
}
