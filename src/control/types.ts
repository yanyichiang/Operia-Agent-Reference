export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = boolean | Record<string, unknown>;

export type ControlScopeType = "global" | "channel" | "chat" | "next_turn" | "device";
export type ControlResolutionStrategy =
  | "replace_within_envelope"
  | "numeric_min"
  | "numeric_max"
  | "set_intersection"
  | "deny_only";

export type ControlResolution =
  | { kind: "generic"; strategy: ControlResolutionStrategy }
  | { kind: "custom"; adapter: string };

export type ControlImplementation =
  | { kind: "owner_store"; adapter: string; resolution?: ControlResolution }
  | { kind: "env_projection"; mutable: false; resolution?: ControlResolution }
  | { kind: "runtime_projection"; mutable: false; resolution?: ControlResolution }
  | { kind: "dedicated_store"; adapter: string; resolution?: ControlResolution }
  | { kind: "custom_resolver"; adapter: string; resolution?: ControlResolution };

export type ControlParameterDefinition = {
  key: string;
  schemaVersion: number;
  ownerDomain: string;
  category: string;
  label: string;
  description: string;
  valueSchema: JsonSchema;
  defaultValue?: unknown;
  allowedScopes: ControlScopeType[];
  resolutionStrategy: ControlResolutionStrategy;
  policyEnvelope?: JsonSchema;
  hardLimit?: number | string[] | boolean;
  sensitivity: "public_status" | "private" | "secret_reference";
  mutableFrom: string[];
  routeTemplateId: string;
  auditClass: "read" | "preference" | "policy" | "credential" | "dangerous";
  legacyLocations?: string[];
  implementation: ControlImplementation;
};

export type ControlActor = { type: "user" | "service" | "migration"; id: string };

export type ControlValue = {
  key: string;
  value: unknown;
  revision: number;
  ownerVersion: string;
  updatedAt: string;
  actor: ControlActor;
};

export type ChannelScopeRef = { type: "channel"; channel: string };
export type ChatScopeRef = { type: "chat"; channel: string; chatId: string };
export type DeviceScopeRef = { type: "device"; channel: string; deviceId: string };
export type NextTurnScopeRef = {
  type: "next_turn";
  channel: string;
  recipientType: "chat" | "device";
  recipientId: string;
};

export type ControlScopeRef = ChannelScopeRef | ChatScopeRef | DeviceScopeRef | NextTurnScopeRef;

export type ControlOverride = {
  id: string;
  key: string;
  scopeRef: ControlScopeRef;
  value: unknown;
  revision: number;
  ownerVersion: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  idempotencyKey: string;
  actor: { type: "user" | "service"; id: string; sourceDomain: string };
};

export type NextTurnClaim = {
  requestId: string;
  ownerDomain: string;
  scopeRef: NextTurnScopeRef;
  overrideIds: string[];
  claimedAt: string;
  effectiveSnapshotHash: string;
  effectiveSnapshot: Record<string, unknown>;
};

export type ControlManifestControlStatus = "ready" | "read_only" | "dedicated" | "unavailable";

export type ControlManifest = {
  manifestVersion: 1;
  registryVersion: string;
  domain: string;
  title: string;
  owns: string[];
  consumes: Array<{ ownerDomain: string; keys: string[] }>;
  sections: Array<{ id: string; title: string; routeTemplateId: string }>;
  capabilities: Array<{ key: string; status: "ready" | "disabled" | "degraded" }>;
  controls: Array<{
    key: string;
    status: ControlManifestControlStatus;
    implementationKind: ControlImplementation["kind"];
    adapter?: string;
    resolution?: ControlResolution;
    mutable: boolean;
  }>;
  schemaVersions: Record<string, number>;
  generatedAt: string;
};

export const CONTROL_ROUTE_LOCATORS = [
  "config_key",
  "run_id",
  "task_id",
  "approval_id",
  "message_id",
  "provider_id",
  "tool_key",
  "tool_name",
  "session_id",
] as const;

export type ControlRouteLocator = (typeof CONTROL_ROUTE_LOCATORS)[number];

export type ControlRouteTemplate = {
  id: string;
  ownerDomain: string;
  template: string;
  allowedLocators: ControlRouteLocator[];
};

export type ControlTopologyDomain = {
  domain: string;
  title: string;
  manifestPath: "/api/control/manifest" | "/service/control/manifest";
  routeTemplateIds: string[];
};

export type ControlTopology = {
  topologyVersion: 1;
  registryVersion: string;
  generatedAt: string;
  domains: ControlTopologyDomain[];
  routeTemplates: ControlRouteTemplate[];
};
