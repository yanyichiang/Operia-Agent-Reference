import { nowIso } from "../utils/time";

export async function tryStartIdempotentTask(
  db: D1Database,
  input: { key: string; taskType: string }
): Promise<boolean> {
  const now = nowIso();

  try {
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, task_type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(input.key, input.taskType, "processing", now, now)
      .run();
    return true;
  } catch {
    const existing = await db
      .prepare("SELECT status FROM idempotency_keys WHERE key = ?")
      .bind(input.key)
      .first<{ status: string }>();

    if (existing?.status === "failed") {
      await db
        .prepare("UPDATE idempotency_keys SET status = ?, updated_at = ? WHERE key = ?")
        .bind("processing", now, input.key)
        .run();
      return true;
    }

    return false;
  }
}

export async function finishIdempotentTask(
  db: D1Database,
  input: { key: string; status: "done" | "failed" }
): Promise<void> {
  await db
    .prepare("UPDATE idempotency_keys SET status = ?, updated_at = ? WHERE key = ?")
    .bind(input.status, nowIso(), input.key)
    .run();
}
