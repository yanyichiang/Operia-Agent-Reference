import { nowIso } from "../utils/time";

export type TgStickerCatalogEntry = {
  file_unique_id: string;
  file_id: string;
  set_name: string | null;
  emoji: string | null;
  description: string | null;
};

export async function upsertObservedSticker(
  db: D1Database,
  input: { fileUniqueId: string; fileId: string; setName?: string; emoji?: string },
): Promise<void> {
  const now = nowIso();
  await db.prepare(`INSERT INTO tg_sticker_catalog
    (file_unique_id,file_id,set_name,emoji,description,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,NULL,?,?)
    ON CONFLICT(file_unique_id) DO UPDATE SET
      file_id=excluded.file_id,
      set_name=COALESCE(excluded.set_name,tg_sticker_catalog.set_name),
      emoji=COALESCE(excluded.emoji,tg_sticker_catalog.emoji),
      last_seen_at=excluded.last_seen_at`)
    .bind(input.fileUniqueId, input.fileId, input.setName ?? null, input.emoji ?? null, now, now).run();
}

export async function getStickerCatalogEntry(db: D1Database, fileUniqueId: string): Promise<TgStickerCatalogEntry | null> {
  return db.prepare(`SELECT file_unique_id,file_id,set_name,emoji,description
    FROM tg_sticker_catalog WHERE file_unique_id=?`).bind(fileUniqueId).first<TgStickerCatalogEntry>();
}
