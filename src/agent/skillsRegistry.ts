import { Validator, type Schema } from "@cfworker/json-schema";
import { hashToolSchema, normalizeToolAllowlist, sha256Hex } from "./toolCatalog";
import { assertJsonValue, canonicalJson } from "../utils/json";
import type { JsonValue, ToolSchema } from "./types";

export const SKILLS_REGISTRY_VERSION = 1 as const;
export const FORBIDDEN_SKILL_KINDS = ["shell", "script", "network"] as const;
export const MAX_SKILL_WORKFLOW_STEPS = 20;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TOOL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_KIND_SET = new Set<string>(FORBIDDEN_SKILL_KINDS);
const FORBIDDEN_TOOL_KEY_SEGMENTS = new Set([
  "shell", "script", "exec", "eval", "code", "network", "fetch", "http", "https", "request", "curl", "wget",
]);
const BASE_ENTRY_KEYS = ["registryVersion", "schemaHash", "sourceHash", "key", "version", "description", "kind", "inputSchema", "enabled"];

export type SkillKind = "prompt" | "deterministicWorkflow" | "reference";
export type SkillInputBinding = { $input: string };
export type SkillArgumentTemplate = JsonValue | SkillInputBinding;

type SkillBaseInput = {
  key: string;
  version: string;
  description: string;
  inputSchema: ToolSchema;
  enabled: boolean;
};

export type PromptSkillInput = SkillBaseInput & {
  kind: "prompt";
  target: "opus" | "glm";
  prompt: string;
};

export type ReferenceSkillInput = SkillBaseInput & {
  kind: "reference";
  mediaType: "application/json" | "application/schema+json" | "text/plain";
  reference: JsonValue;
};

export type DeterministicWorkflowStep = {
  id: string;
  toolKey: string;
  args: SkillArgumentTemplate;
};

export type DeterministicWorkflowSkillInput = SkillBaseInput & {
  kind: "deterministicWorkflow";
  allowedToolKeys: ReadonlyArray<string>;
  steps: ReadonlyArray<DeterministicWorkflowStep>;
};

export type SkillRegistryEntryInput = PromptSkillInput | ReferenceSkillInput | DeterministicWorkflowSkillInput;

type MaterializedSkillBase = SkillBaseInput & {
  registryVersion: typeof SKILLS_REGISTRY_VERSION;
  schemaHash: string;
  sourceHash: string;
};

export type PromptSkill = MaterializedSkillBase & PromptSkillInput;
export type ReferenceSkill = MaterializedSkillBase & ReferenceSkillInput;
export type DeterministicWorkflowSkill = MaterializedSkillBase & DeterministicWorkflowSkillInput & {
  allowedToolKeys: string[];
  steps: DeterministicWorkflowStep[];
};
export type SkillRegistryEntry = PromptSkill | ReferenceSkill | DeterministicWorkflowSkill;

export type SkillResolutionDecision =
  | { ok: true; skill: SkillRegistryEntry }
  | { ok: false; code: "unknown_skill" | "schema_drift" | "source_drift" };

export type WorkflowPlanDecision =
  | {
      ok: true;
      status: "step_pending";
      skillKey: string;
      completedStepIds: string[];
      step: { id: string; toolKey: string; args: JsonValue };
    }
  | { ok: true; status: "completed"; skillKey: string; completedStepIds: string[] }
  | {
      ok: false;
      code:
        | "unknown_skill"
        | "wrong_skill_kind"
        | "schema_drift"
        | "source_drift"
        | "invalid_arguments"
        | "invalid_checkpoint"
        | "tool_not_allowlisted";
    };

export async function createSkillRegistryEntry(input: unknown): Promise<SkillRegistryEntry> {
  if (!isRecord(input)) throw new Error("skill_shape_invalid");
  if (FORBIDDEN_KIND_SET.has(String(input.kind))) throw new Error("skill_kind_forbidden");
  if (input.kind !== "prompt" && input.kind !== "reference" && input.kind !== "deterministicWorkflow") {
    throw new Error("skill_shape_invalid");
  }

  const key = normalizeRequiredString(input.key, "skill_key_invalid");
  if (!KEY_PATTERN.test(key)) throw new Error("skill_key_invalid");
  const version = normalizeRequiredString(input.version, "skill_version_invalid");
  if (!VERSION_PATTERN.test(version)) throw new Error("skill_version_invalid");
  const description = normalizeRequiredString(input.description, "skill_description_invalid");
  if (!isToolSchema(input.inputSchema) || typeof input.enabled !== "boolean") throw new Error("skill_shape_invalid");
  const schemaHash = await hashToolSchema(input.inputSchema);
  if (!schemaHash) throw new Error("skill_schema_invalid");

  if (input.kind === "prompt") {
    assertOnlyKeys(input, [
      "registryVersion", "schemaHash", "sourceHash", "key", "version", "description", "kind", "inputSchema", "target", "prompt", "enabled",
    ]);
    if (input.target !== "opus" && input.target !== "glm") throw new Error("skill_shape_invalid");
    const prompt = normalizeRequiredString(input.prompt, "skill_shape_invalid");
    if (new TextEncoder().encode(prompt).byteLength > 16 * 1024) throw new Error("skill_shape_invalid");
    const source = { kind: input.kind, target: input.target, prompt } as const;
    return {
      registryVersion: SKILLS_REGISTRY_VERSION,
      key,
      version,
      description,
      kind: input.kind,
      inputSchema: input.inputSchema,
      schemaHash,
      sourceHash: await hashSkillSource(source),
      target: input.target,
      prompt,
      enabled: input.enabled,
    };
  }

  if (input.kind === "reference") {
    assertOnlyKeys(input, [
      "registryVersion", "schemaHash", "sourceHash", "key", "version", "description", "kind", "inputSchema", "mediaType", "reference", "enabled",
    ]);
    if (input.mediaType !== "application/json" && input.mediaType !== "application/schema+json" && input.mediaType !== "text/plain") {
      throw new Error("skill_shape_invalid");
    }
    if (!isJsonValue(input.reference)) throw new Error("skill_shape_invalid");
    if (new TextEncoder().encode(canonicalJson(assertJsonValue(input.reference))).byteLength > 64 * 1024) throw new Error("skill_shape_invalid");
    const source = { kind: input.kind, mediaType: input.mediaType, reference: input.reference } as const;
    return {
      registryVersion: SKILLS_REGISTRY_VERSION,
      key,
      version,
      description,
      kind: input.kind,
      inputSchema: input.inputSchema,
      schemaHash,
      sourceHash: await hashSkillSource(source),
      mediaType: input.mediaType,
      reference: input.reference,
      enabled: input.enabled,
    };
  }

  assertOnlyKeys(input, [
    "registryVersion", "schemaHash", "sourceHash", "key", "version", "description", "kind", "inputSchema", "allowedToolKeys", "steps", "enabled",
  ]);
  const allowedToolKeys = normalizeToolKeys(input.allowedToolKeys);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_SKILL_WORKFLOW_STEPS) {
    throw new Error("skill_workflow_invalid");
  }
  const seenStepIds = new Set<string>();
  const steps = input.steps.map((value) => normalizeWorkflowStep(value, allowedToolKeys, seenStepIds));
  const source = { kind: input.kind, allowedToolKeys, steps } as const;
  return {
    registryVersion: SKILLS_REGISTRY_VERSION,
    key,
    version,
    description,
    kind: input.kind,
    inputSchema: input.inputSchema,
    schemaHash,
    sourceHash: await hashSkillSource(source),
    allowedToolKeys,
    steps,
    enabled: input.enabled,
  };
}

export function parseSkillsRegistry(value: unknown): SkillRegistryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCompleteSkillEntry);
}

export function skillsRegistryNeedsRefresh(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some((entry) => !isCompleteSkillEntry(entry));
}

export async function resolveSkillRegistryEntry(
  registry: ReadonlyArray<unknown>,
  key: string,
): Promise<SkillResolutionDecision> {
  const skill = parseSkillsRegistry(registry).find((entry) => entry.key === key && entry.enabled);
  if (!skill) return { ok: false, code: "unknown_skill" };
  const schemaHash = await hashToolSchema(skill.inputSchema);
  if (!schemaHash || schemaHash !== skill.schemaHash) return { ok: false, code: "schema_drift" };
  const sourceHash = await hashSkillEntrySource(skill);
  if (sourceHash !== skill.sourceHash) return { ok: false, code: "source_drift" };
  return { ok: true, skill };
}

export function validateSkillInput(skill: SkillRegistryEntry, input: JsonValue): boolean {
  return validateAgainstSchema(input, skill.inputSchema);
}

export async function planDeterministicWorkflowStep(input: {
  registry: ReadonlyArray<unknown>;
  skillKey: string;
  input: JsonValue;
  runtimeAllowedToolKeys: ReadonlyArray<string>;
  completedStepIds: ReadonlyArray<string>;
}): Promise<WorkflowPlanDecision> {
  const resolved = await resolveSkillRegistryEntry(input.registry, input.skillKey);
  if ("code" in resolved) return { ok: false, code: resolved.code };
  if (resolved.skill.kind !== "deterministicWorkflow") return { ok: false, code: "wrong_skill_kind" };
  const skill = resolved.skill;
  if (!validateAgainstSchema(input.input, skill.inputSchema)) return { ok: false, code: "invalid_arguments" };
  if (!isValidCheckpoint(skill.steps, input.completedStepIds)) return { ok: false, code: "invalid_checkpoint" };

  const completedStepIds = [...input.completedStepIds];
  if (completedStepIds.length === skill.steps.length) {
    return { ok: true, status: "completed", skillKey: skill.key, completedStepIds };
  }

  const next = skill.steps[completedStepIds.length];
  const runtimeAllowlist = normalizeToolAllowlist(input.runtimeAllowedToolKeys);
  if (!skill.allowedToolKeys.includes(next.toolKey) || !runtimeAllowlist.includes(next.toolKey)) {
    return { ok: false, code: "tool_not_allowlisted" };
  }

  let args: JsonValue;
  try {
    args = resolveArgumentTemplate(next.args, input.input);
  } catch {
    return { ok: false, code: "invalid_arguments" };
  }
  return {
    ok: true,
    status: "step_pending",
    skillKey: skill.key,
    completedStepIds,
    step: { id: next.id, toolKey: next.toolKey, args },
  };
}

export async function hashSkillSource(source: unknown): Promise<string> {
  return sha256Hex(canonicalJson(assertJsonValue(source)));
}

function normalizeToolKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("skill_tool_allowlist_invalid");
  const keys = normalizeToolAllowlist(value.filter((item): item is string => typeof item === "string"));
  if (keys.length === 0 || !keys.every((key) => TOOL_KEY_PATTERN.test(key))) throw new Error("skill_tool_allowlist_invalid");
  if (!keys.every(isRestrictedSkillToolKey)) throw new Error("skill_tool_forbidden");
  return keys;
}

export function isRestrictedSkillToolKey(key: string): boolean {
  if (!TOOL_KEY_PATTERN.test(key)) return false;
  return !key.toLowerCase().split(/[\/._-]+/).some((segment) => FORBIDDEN_TOOL_KEY_SEGMENTS.has(segment));
}

function normalizeWorkflowStep(value: unknown, allowedToolKeys: ReadonlyArray<string>, seenStepIds: Set<string>): DeterministicWorkflowStep {
  if (!isRecord(value)) throw new Error("skill_workflow_invalid");
  assertOnlyKeys(value, ["id", "toolKey", "args"]);
  const id = normalizeRequiredString(value.id, "skill_workflow_invalid");
  const toolKey = normalizeRequiredString(value.toolKey, "skill_workflow_invalid");
  if (!TOOL_KEY_PATTERN.test(toolKey)) throw new Error("skill_workflow_invalid");
  if (!isRestrictedSkillToolKey(toolKey)) throw new Error("skill_tool_forbidden");
  if (!allowedToolKeys.includes(toolKey)) throw new Error("skill_tool_not_allowlisted");
  if (seenStepIds.has(id)) throw new Error("skill_workflow_invalid");
  seenStepIds.add(id);
  if (!isArgumentTemplate(value.args)) throw new Error("skill_workflow_invalid");
  return { id, toolKey, args: value.args };
}

async function hashSkillEntrySource(skill: SkillRegistryEntry): Promise<string> {
  if (skill.kind === "prompt") return hashSkillSource({ kind: skill.kind, target: skill.target, prompt: skill.prompt });
  if (skill.kind === "reference") {
    return hashSkillSource({ kind: skill.kind, mediaType: skill.mediaType, reference: skill.reference });
  }
  return hashSkillSource({ kind: skill.kind, allowedToolKeys: skill.allowedToolKeys, steps: skill.steps });
}

function resolveArgumentTemplate(template: SkillArgumentTemplate, input: JsonValue): JsonValue {
  if (isInputBinding(template)) return readInputPath(input, template.$input);
  if (Array.isArray(template)) return template.map((item) => resolveArgumentTemplate(item, input));
  if (isRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveArgumentTemplate(value as SkillArgumentTemplate, input)]));
  }
  return template;
}

function readInputPath(input: JsonValue, path: string): JsonValue {
  if (!path || path.split(".").some((part) => !part || part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error("skill_input_binding_invalid");
  }
  let current: JsonValue = input;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) throw new Error("skill_input_binding_missing");
    const next = (current as { [key: string]: JsonValue })[part];
    if (!isJsonValue(next)) throw new Error("skill_input_binding_invalid");
    current = next;
  }
  return current;
}

function isValidCheckpoint(steps: ReadonlyArray<DeterministicWorkflowStep>, completedStepIds: ReadonlyArray<string>): boolean {
  if (!Array.isArray(completedStepIds) || completedStepIds.length > steps.length) return false;
  return completedStepIds.every((id, index) => typeof id === "string" && id === steps[index].id);
}

function validateAgainstSchema(value: JsonValue, schema: ToolSchema): boolean {
  try {
    return new Validator(schema as Schema | boolean, "2020-12").validate(value).valid;
  } catch {
    return false;
  }
}

function isCompleteSkillEntry(value: unknown): value is SkillRegistryEntry {
  if (!isRecord(value)) return false;
  if (
    value.registryVersion !== SKILLS_REGISTRY_VERSION ||
    typeof value.key !== "string" || !KEY_PATTERN.test(value.key) ||
    typeof value.version !== "string" || !VERSION_PATTERN.test(value.version) ||
    typeof value.description !== "string" || !value.description ||
    !isToolSchema(value.inputSchema) ||
    typeof value.schemaHash !== "string" || !HASH_PATTERN.test(value.schemaHash) ||
    typeof value.sourceHash !== "string" || !HASH_PATTERN.test(value.sourceHash) ||
    typeof value.enabled !== "boolean"
  ) return false;
  if (value.kind === "prompt") {
    return hasOnlyKeys(value, [...BASE_ENTRY_KEYS, "target", "prompt"]) &&
      (value.target === "opus" || value.target === "glm") && typeof value.prompt === "string";
  }
  if (value.kind === "reference") {
    return hasOnlyKeys(value, [...BASE_ENTRY_KEYS, "mediaType", "reference"]) &&
      (value.mediaType === "application/json" || value.mediaType === "application/schema+json" || value.mediaType === "text/plain") &&
      isJsonValue(value.reference);
  }
  if (value.kind === "deterministicWorkflow") {
    if (!hasOnlyKeys(value, [...BASE_ENTRY_KEYS, "allowedToolKeys", "steps"])) return false;
    if (!Array.isArray(value.allowedToolKeys) || value.allowedToolKeys.length === 0 ||
      new Set(value.allowedToolKeys).size !== value.allowedToolKeys.length ||
      !value.allowedToolKeys.every((key) => typeof key === "string" && isRestrictedSkillToolKey(key))) return false;
    if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_SKILL_WORKFLOW_STEPS) return false;
    const stepIds = new Set<string>();
    return value.steps.every((step) => {
      if (!isRecord(step) || !hasOnlyKeys(step, ["id", "toolKey", "args"]) || typeof step.id !== "string" || !step.id ||
        stepIds.has(step.id) || typeof step.toolKey !== "string" || !value.allowedToolKeys.includes(step.toolKey) ||
        !isRestrictedSkillToolKey(step.toolKey) || !isArgumentTemplate(step.args)) return false;
      stepIds.add(step.id);
      return true;
    });
  }
  return false;
}

function isArgumentTemplate(value: unknown): value is SkillArgumentTemplate {
  if (isInputBinding(value)) return Boolean(value.$input) && !value.$input.split(".").some((part) => !part);
  if (Array.isArray(value)) return value.every(isArgumentTemplate);
  if (isRecord(value)) return Object.values(value).every(isArgumentTemplate);
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean";
}

function isInputBinding(value: unknown): value is SkillInputBinding {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$input === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): void {
  if (!hasOnlyKeys(value, allowed)) throw new Error("skill_shape_invalid");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeRequiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function isToolSchema(value: unknown): value is ToolSchema {
  return typeof value === "boolean" || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
