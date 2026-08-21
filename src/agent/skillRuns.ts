import {
  parseSkillsRegistry,
  planDeterministicWorkflowStep,
  resolveSkillRegistryEntry,
  type SkillRegistryEntry,
  type WorkflowPlanDecision,
} from "./skillsRegistry";
import { normalizeToolAllowlist } from "./toolCatalog";
import type { JsonValue } from "./types";

export type SkillRunStatus = "planned" | "blocked" | "cancelled" | "completed";

export type SkillRunPin = {
  skillKey: string;
  skillVersion: string;
  contentHash: string;
  schemaHash: string;
  installationRevision: number;
  permissionSnapshot: string[];
};

export type PlannedSkillCall = {
  stepId: string;
  toolKey: string;
  args: JsonValue;
};

export type SkillRunBlockCode =
  | "skill_missing"
  | "skill_disabled"
  | "wrong_skill_kind"
  | "skill_schema_drift"
  | "skill_content_drift"
  | "skill_version_drift"
  | "installation_revision_drift"
  | "permission_expanded"
  | "invalid_arguments"
  | "invalid_checkpoint"
  | "tool_not_allowlisted";

type SkillRunBase = {
  requestHash: string;
  lastTransitionRequestHash: string;
  stateRevision: number;
  pin: SkillRunPin;
  input: JsonValue;
  completedStepIds: string[];
};

export type PlannedSkillRun = SkillRunBase & {
  status: "planned";
  plannedCall: PlannedSkillCall;
};

export type BlockedSkillRun = SkillRunBase & {
  status: "blocked";
  blockedCode: SkillRunBlockCode;
};

export type CancelledSkillRun = SkillRunBase & {
  status: "cancelled";
  cancellationReason: string;
};

export type CompletedSkillRun = SkillRunBase & {
  status: "completed";
};

export type SkillRunState = PlannedSkillRun | BlockedSkillRun | CancelledSkillRun | CompletedSkillRun;

export type CreateSkillRunInput = {
  existingRun?: SkillRunState;
  registry: ReadonlyArray<unknown>;
  skillKey: string;
  input: JsonValue;
  requestHash: string;
  installationRevision: number;
  installationEnabled?: boolean;
  grantedToolKeys: ReadonlyArray<string>;
};

export type AdvanceSkillRunInput = {
  run: SkillRunState;
  registry: ReadonlyArray<unknown>;
  requestHash: string;
  installationRevision: number;
  installationEnabled?: boolean;
  grantedToolKeys: ReadonlyArray<string>;
  completedStepIds: ReadonlyArray<string>;
};

export async function createSkillRun(input: CreateSkillRunInput): Promise<SkillRunState> {
  assertRequestHash(input.requestHash);
  if (input.existingRun?.requestHash === input.requestHash) return input.existingRun;
  assertInstallationRevision(input.installationRevision);

  const skill = findSkill(input.registry, input.skillKey);
  if (!skill) throw new Error("skill_missing");

  const permissions = skill.kind === "deterministicWorkflow"
    ? intersectPermissions(skill.allowedToolKeys, input.grantedToolKeys)
    : [];
  const base: SkillRunBase = {
    requestHash: input.requestHash,
    lastTransitionRequestHash: input.requestHash,
    stateRevision: 0,
    pin: {
      skillKey: skill.key,
      skillVersion: skill.version,
      contentHash: skill.sourceHash,
      schemaHash: skill.schemaHash,
      installationRevision: input.installationRevision,
      permissionSnapshot: permissions,
    },
    input: cloneJson(input.input),
    completedStepIds: [],
  };

  if (input.installationEnabled === false || !skill.enabled) return block(base, "skill_disabled");
  const integrity = await verifySkillIntegrity(input.registry, skill.key);
  if (integrity) return block(base, integrity);
  if (skill.kind !== "deterministicWorkflow") return block(base, "wrong_skill_kind");

  return planCheckpoint(base, input.registry, permissions);
}

export async function advanceSkillRun(input: AdvanceSkillRunInput): Promise<SkillRunState> {
  assertRequestHash(input.requestHash);
  if (input.requestHash === input.run.lastTransitionRequestHash) return input.run;
  assertInstallationRevision(input.installationRevision);
  if (input.run.status !== "planned") return input.run;

  const transitionBase: SkillRunBase = {
    requestHash: input.run.requestHash,
    lastTransitionRequestHash: input.requestHash,
    stateRevision: input.run.stateRevision + 1,
    pin: clonePin(input.run.pin),
    input: cloneJson(input.run.input),
    completedStepIds: [...input.run.completedStepIds],
  };
  const current = await checkCurrentPin(input);
  if (current.code) return block(transitionBase, current.code);

  const expectedCheckpoint = [...input.run.completedStepIds, input.run.plannedCall.stepId];
  if (!sameStrings(input.completedStepIds, expectedCheckpoint)) return block(transitionBase, "invalid_checkpoint");
  const nextBase = { ...transitionBase, completedStepIds: [...input.completedStepIds] };
  return planCheckpoint(nextBase, input.registry, current.effectivePermissions);
}

export function cancelSkillRun(
  run: SkillRunState,
  requestHash: string,
  reason = "cancelled_by_request",
): SkillRunState {
  assertRequestHash(requestHash);
  if (requestHash === run.lastTransitionRequestHash || run.status !== "planned") return run;
  return {
    requestHash: run.requestHash,
    lastTransitionRequestHash: requestHash,
    stateRevision: run.stateRevision + 1,
    pin: clonePin(run.pin),
    input: cloneJson(run.input),
    completedStepIds: [...run.completedStepIds],
    status: "cancelled",
    cancellationReason: reason.trim() || "cancelled_by_request",
  };
}

async function checkCurrentPin(input: AdvanceSkillRunInput): Promise<{
  code?: SkillRunBlockCode;
  effectivePermissions: string[];
}> {
  const rawMatchingEntry = input.registry.find((entry) => isRecord(entry) && entry.key === input.run.pin.skillKey);
  const skill = findSkill(input.registry, input.run.pin.skillKey);
  if (!skill) {
    return { code: rawMatchingEntry ? "skill_content_drift" : "skill_missing", effectivePermissions: [] };
  }
  if (input.installationEnabled === false || !skill.enabled) {
    return { code: "skill_disabled", effectivePermissions: [] };
  }
  if (skill.version !== input.run.pin.skillVersion) {
    return { code: "skill_version_drift", effectivePermissions: [] };
  }

  const integrity = await verifySkillIntegrity(input.registry, skill.key);
  if (integrity) return { code: integrity, effectivePermissions: [] };
  if (skill.schemaHash !== input.run.pin.schemaHash) {
    return { code: "skill_schema_drift", effectivePermissions: [] };
  }
  if (skill.sourceHash !== input.run.pin.contentHash) {
    return { code: "skill_content_drift", effectivePermissions: [] };
  }
  if (input.installationRevision !== input.run.pin.installationRevision) {
    return { code: "installation_revision_drift", effectivePermissions: [] };
  }
  if (skill.kind !== "deterministicWorkflow") {
    return { code: "wrong_skill_kind", effectivePermissions: [] };
  }

  const effectivePermissions = intersectPermissions(skill.allowedToolKeys, input.grantedToolKeys);
  if (effectivePermissions.some((key) => !input.run.pin.permissionSnapshot.includes(key))) {
    return { code: "permission_expanded", effectivePermissions: [] };
  }
  return { effectivePermissions };
}

async function planCheckpoint(
  base: SkillRunBase,
  registry: ReadonlyArray<unknown>,
  effectivePermissions: ReadonlyArray<string>,
): Promise<SkillRunState> {
  const decision = await planDeterministicWorkflowStep({
    registry,
    skillKey: base.pin.skillKey,
    input: base.input,
    runtimeAllowedToolKeys: effectivePermissions,
    completedStepIds: base.completedStepIds,
  });
  if ("code" in decision) return block(base, mapPlannerBlock(decision));
  if (decision.status === "completed") return { ...base, status: "completed" };
  return {
    ...base,
    status: "planned",
    plannedCall: {
      stepId: decision.step.id,
      toolKey: decision.step.toolKey,
      args: cloneJson(decision.step.args),
    },
  };
}

async function verifySkillIntegrity(
  registry: ReadonlyArray<unknown>,
  skillKey: string,
): Promise<SkillRunBlockCode | undefined> {
  const enabledRegistry = registry.map((entry) => {
    if (!isRecord(entry) || entry.key !== skillKey) return entry;
    return { ...entry, enabled: true };
  });
  const decision = await resolveSkillRegistryEntry(enabledRegistry, skillKey);
  if (!("code" in decision)) return undefined;
  if (decision.code === "schema_drift") return "skill_schema_drift";
  if (decision.code === "source_drift") return "skill_content_drift";
  return "skill_missing";
}

function findSkill(registry: ReadonlyArray<unknown>, skillKey: string): SkillRegistryEntry | undefined {
  return parseSkillsRegistry(registry).find((entry) => entry.key === skillKey);
}

function intersectPermissions(
  skillAllowedToolKeys: ReadonlyArray<string>,
  grantedToolKeys: ReadonlyArray<string>,
): string[] {
  const granted = new Set(normalizeToolAllowlist(grantedToolKeys));
  return normalizeToolAllowlist(skillAllowedToolKeys).filter((key) => granted.has(key));
}

function mapPlannerBlock(decision: Extract<WorkflowPlanDecision, { ok: false }>): SkillRunBlockCode {
  switch (decision.code) {
    case "wrong_skill_kind": return "wrong_skill_kind";
    case "schema_drift": return "skill_schema_drift";
    case "source_drift": return "skill_content_drift";
    case "invalid_arguments": return "invalid_arguments";
    case "invalid_checkpoint": return "invalid_checkpoint";
    case "tool_not_allowlisted": return "tool_not_allowlisted";
    case "unknown_skill": return "skill_missing";
  }
}

function block(base: SkillRunBase, blockedCode: SkillRunBlockCode): BlockedSkillRun {
  return { ...base, status: "blocked", blockedCode };
}

function clonePin(pin: SkillRunPin): SkillRunPin {
  return { ...pin, permissionSnapshot: [...pin.permissionSnapshot] };
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item as JsonValue)]));
  }
  return value;
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRequestHash(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("request_hash_required");
}

function assertInstallationRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("installation_revision_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
