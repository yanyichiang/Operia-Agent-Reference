import { compileResultCapsule } from "./compile";
import { normalizeMcpToolResult } from "./normalize";
import type { AgentEnv } from "../types";

export const AGENT_PRESENTATION_REGISTRY = Object.freeze({
  schema: "operia.presentation/v1",
  capsuleSchemaVersion: "v1",
  recipeRegistryRevision: "result-capsule-p0-r1",
  recipes: Object.freeze([
    "place.search",
    "place.details",
    "route.summary",
    "music.search",
    "music.playlist",
    "music.lyric",
    "execution.receipt",
  ]),
  implementation: Object.freeze({
    normalize: normalizeMcpToolResult,
    compile: compileResultCapsule,
  }),
});

export function agentResultCapsuleEnabled(env: Pick<AgentEnv, "AGENT_RESULT_CAPSULE_ENABLED">): boolean {
  return env.AGENT_RESULT_CAPSULE_ENABLED?.trim().toLowerCase() === "true";
}

export function handleAgentPresentationCapabilities(request: Request, env: AgentEnv): Response {
  if (request.method !== "GET" || !agentResultCapsuleEnabled(env)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({
    schema: AGENT_PRESENTATION_REGISTRY.schema,
    capsuleSchemaVersion: AGENT_PRESENTATION_REGISTRY.capsuleSchemaVersion,
    recipeRegistryRevision: AGENT_PRESENTATION_REGISTRY.recipeRegistryRevision,
    recipes: AGENT_PRESENTATION_REGISTRY.recipes,
    implementation: {
      normalize: AGENT_PRESENTATION_REGISTRY.implementation.normalize.name,
      compile: AGENT_PRESENTATION_REGISTRY.implementation.compile.name,
    },
  }, { headers: { "cache-control": "no-store" } });
}
