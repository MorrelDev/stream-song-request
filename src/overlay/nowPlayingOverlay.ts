import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { logger } from '../core/logger.ts';
import { parseRequestLink } from '../music/linkParser.ts';
import { getSpotifyAppToken } from '../music/spotifyAuth.ts';
import { parseYandexPlayUri } from '../music/yandexMusicProvider.ts';
import type { NowPlayingInfo } from '../music/playbackOrchestrator.ts';
import type { SpotifyPlaybackState } from '../music/spotifyProvider.ts';
import { toTrackDisplay } from './trackDisplay.ts';

/**
 * Оверлей "сейчас играет" для OBS (источник "Браузер"): маленький
 * HTTP-сервер на 127.0.0.1, отдаёт
 *
 *  - /overlay        — сама страница-плашка (overlay.html);
 *  - /overlay/state  — что играет сейчас (JSON, страница опрашивает дважды в секунду);
 *  - /overlay/cover  — обложка текущего трека.
 *
 * Обложку сервер скачивает сам и отдаёт со своего адреса: так страница может
 * прочитать её пиксели (подобрать цвета плашки под обложку) — с чужого
 * домена браузер бы этого не дал. Адрес обложки сервер всегда вычисляет сам
 * по треку, который играет, — произвольные ссылки он не проксирует.
 */

export interface OverlayDeps {
  port: number;
  getNowPlaying: () => NowPlayingInfo | null;
  /** Для обложек треков Spotify; null — Spotify не настроен. */
  spotifyApp: { clientId: string; clientSecret: string } | null;
  /** Для точного прогресса трека Spotify; null — Spotify не настроен. */
  getSpotifyPlayback: (() => Promise<SpotifyPlaybackState | null>) | null;
  /** Для обложек треков Яндекс Музыки; undefined — Яндекс не настроен. */
  yandexToken: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface OverlayState {
  playing: boolean;
  /** Меняется вместе с треком — по нему страница понимает, что пора сменить карточку. */
  key: string | null;
  title: string;
  artist: string;
  provider: string | null;
  requester: string | null;
  durationSec: number;
  /** Сколько трек уже играет, сек; null — звук ещё не пошёл. */
  positionSec: number | null;
  /** false — Spotify на паузе (например, вручную). */
  isPlaying: boolean;
  coverUrl: string | null;
}

const IDLE_STATE: OverlayState = {
  playing: false,
  key: null,
  title: '',
  artist: '',
  provider: null,
  requester: null,
  durationSec: 0,
  positionSec: null,
  isPlaying: false,
  coverUrl: null,
};

/** Не чаще этого спрашиваем у Spotify точный прогресс трека. */
// Чаще раза в секунду смысла нет, реже — плашка замечает паузу в Spotify с опозданием.
const SPOTIFY_PROGRESS_REFRESH_MS = 1000;
const COVER_CACHE_SIZE = 20;

/** Адрес обложки трека в интернете; null — обложки нет. */
export async function resolveCoverUrl(
  playUri: string,
  deps: Pick<OverlayDeps, 'spotifyApp' | 'yandexToken'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const yandexId = parseYandexPlayUri(playUri);
  if (yandexId !== null) {
    if (!deps.yandexToken) return null;
    const res = await fetchImpl(`https://api.music.yandex.net/tracks/${encodeURIComponent(yandexId)}`, {
      headers: { Authorization: `OAuth ${deps.yandexToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: Array<{ coverUri?: string; albums?: Array<{ coverUri?: string }> }> };
    const track = data.result?.[0];
    const coverUri = track?.coverUri ?? track?.albums?.[0]?.coverUri;
    // coverUri вида avatars.yandex.net/get-music-content/.../%% — %% заменяется размером.
    return coverUri ? `https://${coverUri.replace('%%', '400x400')}` : null;
  }

  const link = parseRequestLink(playUri);
  if (link.type === 'spotify') {
    if (!deps.spotifyApp) return null;
    const token = await getSpotifyAppToken(deps.spotifyApp.clientId, deps.spotifyApp.clientSecret, fetchImpl);
    const res = await fetchImpl(`https://api.spotify.com/v1/tracks/${encodeURIComponent(link.trackId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { album?: { images?: Array<{ url: string; width: number }> } };
    // Картинки отсортированы по убыванию размера — берём самую большую.
    return data.album?.images?.[0]?.url ?? null;
  }
  if (link.type === 'youtube') {
    // Превью видео лежит по постоянному адресу, запрос к YouTube API не нужен.
    // maxresdefault (1280x720) есть не у всех видео, mqdefault (320x180) —
    // у всех, и, в отличие от hqdefault, без чёрных полос сверху и снизу.
    const maxres = `https://i.ytimg.com/vi/${link.videoId}/maxresdefault.jpg`;
    const probe = await fetchImpl(maxres, { method: 'HEAD' });
    return probe.ok ? maxres : `https://i.ytimg.com/vi/${link.videoId}/mqdefault.jpg`;
  }
  return null;
}

export function startNowPlayingOverlay(deps: OverlayDeps): Server {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const html = readFileSync(new URL('./overlay.html', import.meta.url));

  const covers = new Map<string, Promise<{ type: string; body: Buffer } | null>>();
  let spotifyProgress: { playUri: string; progressMs: number; isPlaying: boolean; fetchedAt: number } | null = null;
  let spotifyRefresh: Promise<void> | null = null;

  function loadCover(playUri: string): Promise<{ type: string; body: Buffer } | null> {
    let cover = covers.get(playUri);
    if (!cover) {
      cover = (async () => {
        try {
          const url = await resolveCoverUrl(playUri, deps, fetchImpl);
          if (!url) return null;
          const res = await fetchImpl(url);
          if (!res.ok) return null;
          return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
        } catch (err) {
          logger.error('overlay', `Не удалось загрузить обложку для ${playUri}`, err);
          return null;
        }
      })();
      covers.set(playUri, cover);
      // Неудачу не кэшируем навсегда — следующий запрос попробует снова.
      void cover.then((c) => {
        if (!c) covers.delete(playUri);
      });
      while (covers.size > COVER_CACHE_SIZE) covers.delete(covers.keys().next().value!);
    }
    return cover;
  }

  /** Точный прогресс трека Spotify — у самого Spotify, не чаще раза в SPOTIFY_PROGRESS_REFRESH_MS. */
  function refreshSpotifyProgress(playUri: string): void {
    if (!deps.getSpotifyPlayback || spotifyRefresh) return;
    if (spotifyProgress?.playUri === playUri && Date.now() - spotifyProgress.fetchedAt < SPOTIFY_PROGRESS_REFRESH_MS) {
      return;
    }
    spotifyRefresh = deps
      .getSpotifyPlayback()
      .then((state) => {
        spotifyProgress =
          state && state.trackUri === playUri
            ? { playUri, progressMs: state.progressMs, isPlaying: state.isPlaying, fetchedAt: Date.now() }
            : null;
      })
      .catch(() => {
        // Не страшно: прогресс посчитается по времени старта трека.
      })
      .finally(() => {
        spotifyRefresh = null;
      });
  }

  function currentState(): OverlayState {
    const np = deps.getNowPlaying();
    if (!np) return IDLE_STATE;

    const now = Date.now();
    let positionSec = np.startedAt === null ? null : (now - np.startedAt) / 1000;
    let isPlaying = np.startedAt !== null;
    if (np.provider === 'spotify') {
      refreshSpotifyProgress(np.playUri);
      if (spotifyProgress?.playUri === np.playUri) {
        isPlaying = spotifyProgress.isPlaying;
        positionSec =
          (spotifyProgress.progressMs + (spotifyProgress.isPlaying ? now - spotifyProgress.fetchedAt : 0)) / 1000;
      }
    }
    if (positionSec !== null && np.durationSec > 0) positionSec = Math.min(positionSec, np.durationSec);

    const display = toTrackDisplay(np.provider, np.title, np.author);
    return {
      playing: true,
      key: `${np.kind}|${np.playUri}`,
      title: display.title,
      artist: display.artist,
      provider: np.provider,
      requester: np.requestedByLogin,
      durationSec: np.durationSec,
      positionSec,
      isPlaying,
      coverUrl: `/overlay/cover?uri=${encodeURIComponent(np.playUri)}`,
    };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/overlay' || url.pathname === '/overlay/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/overlay/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(currentState()));
      return;
    }
    if (url.pathname === '/overlay/cover') {
      // Отдаём обложку только текущего трека — сервер не прокси для любых ссылок.
      const np = deps.getNowPlaying();
      if (!np || url.searchParams.get('uri') !== np.playUri) {
        res.writeHead(404).end();
        return;
      }
      void loadCover(np.playUri).then((cover) => {
        if (!cover) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': cover.type, 'Cache-Control': 'max-age=3600' });
        res.end(cover.body);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  });

  server.on('error', (err) => {
    logger.error('overlay', `Оверлей "сейчас играет" не запустился на порту ${deps.port} (порт занят?)`, err);
  });
  server.listen(deps.port, '127.0.0.1', () => {
    logger.info('overlay', `Оверлей "сейчас играет": http://localhost:${deps.port}/overlay (источник "Браузер" в OBS)`);
  });
  return server;
}
