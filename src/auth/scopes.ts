import type { KeyProfile, Scope } from "../types";
import { openAiError } from "../utils/json";

export function requireScope(profile: KeyProfile, scope: Scope): Response | null {
  return profile.scopes.includes(scope) ? null : openAiError(`Missing required scope: ${scope}`, 403);
}
