import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Локальное хранилище на node:sqlite (встроен в Node, без зависимостей).
 * Используется для очереди музыкальных заказов (см. db/musicQueue.ts) и
 * небольших настроек, которые нужно помнить между запусками (db/settings.ts).
 */

let db: DatabaseSync | undefined;

export function initDb(path: string): void {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS song_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      play_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      requested_by_id TEXT NOT NULL,
      requested_by_login TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    -- Треки дефолтного плейлиста (см. db/defaultTracks.ts): заполняется при
    -- старте, играется сверху вниз, проигранный трек удаляется.
    CREATE TABLE IF NOT EXISTS default_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      play_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      duration_sec INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Заказ за баллы канала: какой активацией награды он оплачен — чтобы
  // выполнить её, когда трек зазвучит, или вернуть баллы, если не запустился
  // (см. music/pointsMode.ts). В старых базах этих колонок нет — добавляем.
  const columns = (db.prepare('PRAGMA table_info(song_requests)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes('redemption_id')) db.exec('ALTER TABLE song_requests ADD COLUMN redemption_id TEXT');
  if (!columns.includes('reward_id')) db.exec('ALTER TABLE song_requests ADD COLUMN reward_id TEXT');
}

/** Доступ к общему инстансу БД для остальных модулей (db/musicQueue.ts и т.п.). */
export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('База данных не инициализирована — вызови initDb() при старте приложения.');
  }
  return db;
}
