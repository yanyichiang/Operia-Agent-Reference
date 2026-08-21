import type { KeyProfile } from "../types";

export const KEY_PROFILES = {
  chatbox: {
    source: "chatbox",
    namespace: "default",
    scopes: ["chat:proxy", "memory:read", "memory:write", "cache:read", "cache:write"],
    injectionMode: "rag",
    memoryMode: "external",
    allowModelPassthrough: false,
    debug: false
  },
  im: {
    source: "im",
    namespace: "default",
    scopes: ["chat:proxy", "memory:read", "memory:write", "cache:read"],
    injectionMode: "rag",
    memoryMode: "external",
    allowModelPassthrough: false,
    debug: false
  },
  telegram: {
    source: "telegram",
    namespace: "default",
    scopes: ["chat:proxy", "memory:read", "memory:write"],
    injectionMode: "rag",
    memoryMode: "hybrid",
    allowModelPassthrough: true,
    debug: false
  },
  operia: {
    source: "operia",
    namespace: "default",
    scopes: ["chat:proxy"],
    injectionMode: "rag",
    memoryMode: "hybrid",
    allowModelPassthrough: true,
    debug: false
  },
  riddle: {
    source: "riddle",
    namespace: "default",
    scopes: ["chat:proxy"],
    injectionMode: "rag",
    memoryMode: "hybrid",
    allowModelPassthrough: false,
    debug: false
  },
  debug: {
    source: "debug",
    namespace: "default",
    scopes: ["chat:proxy", "memory:read", "memory:write", "cache:read", "cache:write", "debug:read", "export:read"],
    injectionMode: "full",
    memoryMode: "hybrid",
    allowModelPassthrough: true,
    debug: true
  },
  mcp: {
    source: "mcp",
    namespace: "default",
    scopes: ["memory:read", "memory:write", "export:read"],
    injectionMode: "none",
    memoryMode: "builtin",
    allowModelPassthrough: false,
    debug: false
  },
  guideDog: {
    source: "guide-dog",
    namespace: "default",
    scopes: ["chat:proxy"],
    injectionMode: "none",
    memoryMode: "none",
    allowModelPassthrough: false,
    debug: false
  }
} satisfies Record<string, KeyProfile>;
