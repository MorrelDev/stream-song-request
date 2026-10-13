import { getDb } from './index.ts';
import type { SongProvider } from '../core/events.ts';

/**
 * Треки дефолтного плейлиста — вторая "очередь" рядом с заказами
 * (db/musicQueue.ts). Заполняется целиком при старте приложения (и заново,
 * когда опустеет) или, для Моей волны, порциями; играется по порядку id,
 * проигранный трек удаляется.
 */

export interface NewDefaultTrack {
  provider: SongProvider;
  /** То же, что playUri заказа: spotify:track:..., yandex:track:... */
  playUri: string;
  title: string;
  author: string;
  durationSec: number;
}

export interface DefaultTrack extends NewDefaultTrack {
  id: number;
}

interface DefaultTrackRow {
  id: number;
  provider: string;
  play_uri: string;
  title: string;
  author: string;
  duration_sec: number;
}

/** Заменяет содержимое таблицы новым списком (в переданном порядке). */
export function replaceDefaultTracks(tracks: NewDefaultTrack[]): void {
  insertDefaultTracks(tracks, true);
}

/** Дописывает треки в конец таблицы (порции Моей волны, см. yandexWave.ts). */
export function appendDefaultTracks(tracks: NewDefaultTrack[]): void {
  insertDefaultTracks(tracks, false);
}

function insertDefaultTracks(tracks: NewDefaultTrack[], clearFirst: boolean): void {
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO default_tracks (provider, play_uri, title, author, duration_sec) VALUES (?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    if (clearFirst) db.exec('DELETE FROM default_tracks');
    for (const t of tracks) {
      insert.run(t.provider, t.playUri, t.title, t.author, t.durationSec);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Следующий трек дефолтного плейлиста (не удаляет его). excludeId — пропустить
 * этот трек: так оркестратор узнаёт, что играть после текущего.
 */
export function peekNextDefaultTrack(excludeId?: number): DefaultTrack | undefined {
  const row = getDb()
    .prepare('SELECT * FROM default_tracks WHERE id != ? ORDER BY id LIMIT 1')
    .get(excludeId ?? -1) as DefaultTrackRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider as SongProvider,
    playUri: row.play_uri,
    title: row.title,
    author: row.author,
    durationSec: row.duration_sec,
  };
}

export function removeDefaultTrack(id: number): void {
  getDb().prepare('DELETE FROM default_tracks WHERE id = ?').run(id);
}

export function countDefaultTracks(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM default_tracks').get() as { n: number }).n;
}
