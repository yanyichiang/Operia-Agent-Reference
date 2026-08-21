import type { Env, KeyProfile } from "../types";
import { resolvePublicModelAlias } from "../config/modelCatalog";

export function resolveTargetModel(requestModel: string, profile: KeyProfile, env: Env): string {
  const publicModel = env.PUBLIC_MODEL_NAME || "companion";
  const defaultModel = env.CHAT_MODEL || env.DEFAULT_UPSTREAM_MODEL;
  const globalPassthrough = env.ALLOW_MODEL_PASSTHROUGH === "true";

  if (!defaultModel) {
    throw new Error("Missing CHAT_MODEL");
  }

  if (!requestModel || requestModel === publicModel) {
    return defaultModel;
  }

  const publicAlias = resolvePublicModelAlias(requestModel);
  if (publicAlias) {
    return publicAlias;
  }

  if (profile.allowModelPassthrough || globalPassthrough) {
    return requestModel;
  }

  return defaultModel;
}

export function resolveVisionTargetModel(requestModel: string, profile: KeyProfile, env: Env): string {
  const defaultVisionModel = env.VISION_MODEL;
  const publicModel = env.PUBLIC_MODEL_NAME || "companion";
  const requested = (requestModel || "").trim();

  if (!defaultVisionModel) {
    throw new Error("Missing VISION_MODEL");
  }

  if (!requested || requested === publicModel || requested === "default-vision") {
    return defaultVisionModel;
  }

  const publicAlias = resolvePublicModelAlias(requested);
  if (publicAlias) {
    return publicAlias;
  }

  if (profile.allowModelPassthrough || env.ALLOW_MODEL_PASSTHROUGH === "true") {
    return requested;
  }

  return defaultVisionModel;
}

export function classifyProvider(model: string): "anthropic" | "openai-compatible" {
  const value = model.toLowerCase();
  return value.includes("anthropic") || value.includes("claude") ? "anthropic" : "openai-compatible";
}
