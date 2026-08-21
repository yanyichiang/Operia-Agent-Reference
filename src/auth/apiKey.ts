import { KEY_PROFILES } from "../config/keyProfiles";
import type { AuthResult, Env } from "../types";
import { secretEqual } from "../security/credentials";
import { authenticateDomainSession } from "./domainSession";

function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return request.headers.get("x-api-key");
}

/**
 * Bearer-key profiles, checked in declaration order. Each entry maps an Env
 * credential name to the key profile it grants. Comparison goes through
 * `secretEqual` (constant-time when the runtime provides it) so that token
 * contents are never compared with a short-circuiting `===`.
 */
const BEARER_KEY_PROFILES: Array<{
  key: string;
  profile: (typeof KEY_PROFILES)[keyof typeof KEY_PROFILES];
  keyName: string;
}> = [
  { key: "CHATBOX_API_KEY", profile: KEY_PROFILES.chatbox, keyName: "CHATBOX_API_KEY" },
  { key: "IM_API_KEY", profile: KEY_PROFILES.im, keyName: "IM_API_KEY" },
  { key: "TG_CHAT_API_KEY", profile: KEY_PROFILES.telegram, keyName: "TG_CHAT_API_KEY" },
  { key: "DEBUG_API_KEY", profile: KEY_PROFILES.debug, keyName: "DEBUG_API_KEY" },
  { key: "CACHE_TEST_API_KEY", profile: KEY_PROFILES.debug, keyName: "CACHE_TEST_API_KEY" },
  { key: "OPERIA_CHAT_API_KEY", profile: KEY_PROFILES.operia, keyName: "OPERIA_CHAT_API_KEY" },
  { key: "RIDDLE_CHAT_API_KEY", profile: KEY_PROFILES.riddle, keyName: "RIDDLE_CHAT_API_KEY" },
  { key: "MEMORY_MCP_API_KEY", profile: KEY_PROFILES.mcp, keyName: "MEMORY_MCP_API_KEY" },
  { key: "AGENT_MEMORY_MCP_API_KEY", profile: KEY_PROFILES.mcp, keyName: "AGENT_MEMORY_MCP_API_KEY" },
  { key: "GUIDE_DOG_API_KEY", profile: KEY_PROFILES.guideDog, keyName: "GUIDE_DOG_API_KEY" },
];

export async function authenticate(request: Request, env: Env): Promise<AuthResult | { ok: false }> {
  const token = getBearerToken(request);
  if (!token) return authenticateDomainSession(request, env);

  const credentials = env as unknown as Record<string, string | undefined>;
  for (const entry of BEARER_KEY_PROFILES) {
    const expected = credentials[entry.key];
    if (expected && (await secretEqual(token, expected))) {
      return { ok: true, profile: entry.profile, keyName: entry.keyName };
    }
  }

  return { ok: false };
}
