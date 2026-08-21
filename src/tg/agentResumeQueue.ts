import type { Env } from "../types";

export async function enqueueTgAgentResume(env: Env, taskId: string, attempt = 0, delaySeconds = 5): Promise<void> {
  if (!env.MEMORY_QUEUE) return;
  await env.MEMORY_QUEUE.send({ type: "tg_agent_resume", taskId, attempt }, { delaySeconds });
}
