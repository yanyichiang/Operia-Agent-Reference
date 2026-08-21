import { listMemories } from "../db/memories";
import type { Env } from "../types";
import { toMemoryApiRecord } from "./search";

export async function buildStableMemoryPack(env: Env, namespace: string): Promise<string> {
  const records = await listMemories(env.DB, {
    namespace,
    status: "active",
    limit: 100
  });

  const pinned = records
    .filter((record) => record.pinned)
    .map((record) => toMemoryApiRecord(record))
    .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));

  if (pinned.length === 0) {
    return "固定长期记忆：暂无。";
  }

  return [
    "固定长期记忆：",
    ...pinned.map((memory) => `- [${memory.type}][importance=${memory.importance.toFixed(2)}] ${memory.content}`)
  ].join("\n");
}
