import { logger } from '../core/logger.ts';
import { yandexPlayUri } from './yandexMusicProvider.ts';
import type { NewDefaultTrack } from '../db/defaultTracks.ts';

/**
 * Дефолтный плейлист из Яндекс Музыки (YANDEX_DEFAULT_PLAYLIST_URL): разбор
 * ссылки и загрузка списка треков для таблицы дефолтных треков
 * (db/defaultTracks.ts). Играет их mpv — как заказы из Яндекса.
 */

/** Плейлист в новом формате (/playlists/<uuid>) или в старом (/users/<владелец>/playlists/<kind>). */
export type YandexPlaylistRef = { uuid: string } | { owner: string; kind: string };

const YANDEX_MUSIC_HOST_RE = /^music\.yandex\.(ru|com|by|kz|uz)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Принимает ссылку, которую даёт "Поделиться → Скопировать ссылку" (с utm-
 * хвостом или без), старую ссылку вида /users/<владелец>/playlists/<kind>
 * или просто uuid. null — это не ссылка на плейлист Яндекс Музыки.
 */
export function parseYandexPlaylistUrl(raw: string): YandexPlaylistRef | null {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return { uuid: trimmed };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!YANDEX_MUSIC_HOST_RE.test(url.hostname.toLowerCase())) return null;

  const byUuid = url.pathname.match(/^\/playlists\/([\w.-]+)\/?$/);
  if (byUuid) return { uuid: byUuid[1] };

  const byOwner = url.pathname.match(/^\/users\/([^/]+)\/playlists\/(\d+)\/?$/);
  if (byOwner) return { owner: decodeURIComponent(byOwner[1]), kind: byOwner[2] };

  return null;
}

function playlistApiUrl(ref: YandexPlaylistRef): string {
  return 'uuid' in ref
    ? `https://api.music.yandex.net/playlist/${encodeURIComponent(ref.uuid)}`
    : `https://api.music.yandex.net/users/${encodeURIComponent(ref.owner)}/playlists/${encodeURIComponent(ref.kind)}`;
}

/** Трек в ответах API Яндекс Музыки (плейлисты, Моя волна) — только нужные поля. */
export interface YandexTrackEntryJson {
  id: string | number;
  title: string;
  version?: string;
  durationMs?: number;
  available?: boolean;
  artists?: Array<{ name: string }>;
}

interface YandexPlaylistEntryJson {
  id: string | number;
  track?: YandexTrackEntryJson;
}

/** Трек для таблицы дефолтных треков; null — трек недоступен, играть его нельзя. */
export function yandexTrackToDefaultTrack(t: YandexTrackEntryJson): NewDefaultTrack | null {
  if (t.available === false) return null;
  return {
    provider: 'yandex',
    playUri: yandexPlayUri(String(t.id)),
    title: t.version ? `${t.title} (${t.version})` : t.title,
    author: (t.artists ?? []).map((a) => a.name).join(', '),
    durationSec: Math.round((t.durationMs ?? 0) / 1000),
  };
}

/** Треки плейлиста в его порядке, без недоступных. */
export async function fetchYandexPlaylistTracks(
  ref: YandexPlaylistRef,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewDefaultTrack[]> {
  const res = await fetchImpl(playlistApiUrl(ref), { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) {
    throw new Error(`Яндекс Музыка вернула ошибку HTTP ${res.status} на запрос дефолтного плейлиста`);
  }
  const data = (await res.json()) as { result?: { tracks?: YandexPlaylistEntryJson[] } };
  const entries = data.result?.tracks ?? [];

  const tracks: NewDefaultTrack[] = [];
  let skipped = 0;
  for (const entry of entries) {
    // Без полного объекта трека не знаем ни названия, ни доступности — пропускаем.
    const track = entry.track ? yandexTrackToDefaultTrack(entry.track) : null;
    if (!track) {
      skipped++;
      continue;
    }
    tracks.push(track);
  }
  if (skipped > 0) {
    logger.warn('playback', `В дефолтном плейлисте Яндекс Музыки пропущено недоступных треков: ${skipped}`);
  }
  return tracks;
}
