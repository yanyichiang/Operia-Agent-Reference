// 普通长期记忆只允许这 8 个固定类型。抽取器、dream 默认收敛到这个枚举，
// 不允许自由类型。world_fact / precious 走各自独立页面，不进这个枚举。
export const CANONICAL_MEMORY_TYPES = [
  "fact",
  "event",
  "preference",
  "relationship",
  "boundary",
  "habit",
  "decision",
  "note"
] as const;

export type CanonicalMemoryType = (typeof CANONICAL_MEMORY_TYPES)[number];

// 稳定 profile 类型。它们不是自动抽取区，而是人工 / 代理显式写入的
// persona_pinned 来源，用来给 chat proxy 提供长期身份和助手人格锚点。
export const PROFILE_MEMORY_TYPES = ["identity", "persona"] as const;
export type ProfileMemoryType = (typeof PROFILE_MEMORY_TYPES)[number];

export const WRITABLE_MEMORY_TYPES = [
  ...CANONICAL_MEMORY_TYPES,
  ...PROFILE_MEMORY_TYPES
] as const;
export type WritableMemoryType = (typeof WRITABLE_MEMORY_TYPES)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_MEMORY_TYPES);
const WRITABLE_SET = new Set<string>(WRITABLE_MEMORY_TYPES);

/**
 * 把任意 type 收敛到普通固定枚举。自动抽取层使用，保证模型不会把
 * profile 类型或自由类型写入普通记忆区。
 */
export function clampCanonicalMemoryType(
  type: string | null | undefined,
  fallback: CanonicalMemoryType = "fact"
): CanonicalMemoryType {
  const trimmed = (type || "").trim().toLowerCase();
  if (trimmed && CANONICAL_SET.has(trimmed)) return trimmed as CanonicalMemoryType;
  return fallback;
}

/**
 * 把任意 type 收敛到可写枚举。非空但不在枚举里的 → fallback。
 * 大小写无关。显式写入层调用，允许 identity/persona，但不允许自由类型。
 */
export function clampMemoryType(
  type: string | null | undefined,
  fallback: WritableMemoryType = "fact"
): WritableMemoryType {
  const trimmed = (type || "").trim().toLowerCase();
  if (trimmed && WRITABLE_SET.has(trimmed)) return trimmed as WritableMemoryType;
  return fallback;
}
