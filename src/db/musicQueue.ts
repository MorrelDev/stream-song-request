import { getDb } from './index.ts';
import type { SongProvider } from '../core/events.ts';

export interface NewSongRequest {
  provider: SongProvider;
  externalId: string;
  /** Что именно передавать в плеер: spotify:track:... для Spotify либо URL для mpv/YouTube. */
  playUri: string;
  title: string;
  author: string;
  durationSec: number;
  requestedById: string;
  requestedByLogin: string;
  /**
   * Заказ за баллы канала: активация награды, которой он оплачен. Остаётся
   * "в ожидании", пока трек не зазвучит (тогда её выполняют), а если не
   * запустился — её отклоняют, и Twitch возвращает баллы (см. pointsMode.ts).
   */
  redemptionId?: string | null;
  rewardId?: string | null;
}

export interface QueuedSongRequest extends NewSongRequest {
  id: number;
  status: 'pending' | 'playing' | 'done';
  createdAt: string;
}

interface SongRequestRow {
  id: number;
  provider: string;
  external_id: string;
  play_uri: string;
  title: string;
  author: string;
  duration_sec: number;
  requested_by_id: string;
  requested_by_login: string;
  status: string;
  created_at: string;
  redemption_id?: string | null;
  reward_id?: string | null;
}

function rowToRequest(row: SongRequestRow): QueuedSongRequest {
  return {
    id: row.id,
    provider: row.provider as SongProvider,
    externalId: row.external_id,
    playUri: row.play_uri,
    title: row.title,
    author: row.author,
    durationSec: row.duration_sec,
    requestedById: row.requested_by_id,
    requestedByLogin: row.requested_by_login,
    status: row.status as QueuedSongRequest['status'],
    createdAt: row.created_at,
    redemptionId: row.redemption_id ?? null,
    rewardId: row.reward_id ?? null,
  };
}

/** Сколько заказов сейчас ждут своей очереди (не считая того, что уже играет). */
export function countPending(): number {
  const row = getDb().prepare(`SELECT COUNT(*) as c FROM song_requests WHERE status = 'pending'`).get() as {
    c: number;
  };
  return row.c;
}

/** Добавляет заказ в конец очереди. Возвращает id и позицию в очереди (1 = следующий). */
export function enqueueSongRequest(track: NewSongRequest): { id: number; position: number } {
  const db = getDb();
  const positionBefore = countPending();
  const info = db
    .prepare(
      `INSERT INTO song_requests
         (provider, external_id, play_uri, title, author, duration_sec, requested_by_id, requested_by_login, status, created_at, redemption_id, reward_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      track.provider,
      track.externalId,
      track.playUri,
      track.title,
      track.author,
      track.durationSec,
      track.requestedById,
      track.requestedByLogin,
      new Date().toISOString(),
      track.redemptionId ?? null,
      track.rewardId ?? null,
    );
  return { id: Number(info.lastInsertRowid), position: positionBefore + 1 };
}

/** Заказ, который должен играть следующим (самый старый pending, без приоритетов). */
export function peekNextPending(): QueuedSongRequest | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM song_requests WHERE status = 'pending' ORDER BY id ASC LIMIT 1`)
    .get() as SongRequestRow | undefined;
  return row ? rowToRequest(row) : undefined;
}

export function markPlaying(id: number): void {
  getDb().prepare(`UPDATE song_requests SET status = 'playing' WHERE id = ?`).run(id);
}

export function markDone(id: number): void {
  getDb().prepare(`UPDATE song_requests SET status = 'done' WHERE id = ?`).run(id);
}

/** Активации наград у заказов, которые ещё ждут очереди: их при старте не отклоняем. */
export function pendingRedemptionIds(): string[] {
  const rows = getDb()
    .prepare(`SELECT redemption_id FROM song_requests WHERE status = 'pending' AND redemption_id IS NOT NULL`)
    .all() as Array<{ redemption_id: string }>;
  return rows.map((r) => r.redemption_id);
}

/** Активация награды, которой сейчас оплачен заказ (null — заказ не за баллы или бесплатный). */
export function getRequestRedemption(id: number): { redemptionId: string; rewardId: string } | null {
  const row = getDb().prepare('SELECT redemption_id, reward_id FROM song_requests WHERE id = ?').get(id) as
    | { redemption_id: string | null; reward_id: string | null }
    | undefined;
  return row?.redemption_id && row.reward_id ? { redemptionId: row.redemption_id, rewardId: row.reward_id } : null;
}

/** Заказ стал бесплатным (Privilege-режим): активацию уже отклонили — больше её не трогаем. */
export function detachRedemption(id: number): void {
  getDb().prepare('UPDATE song_requests SET redemption_id = NULL, reward_id = NULL WHERE id = ?').run(id);
}
