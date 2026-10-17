import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { createSpotifyUserTokenStore } from './spotifyAuth.ts';
import { SpotifyPlaybackController } from './spotifyProvider.ts';
import { SPOTIFY_TOP_TRACKS } from './spotifyPlaylistUri.ts';
import { loadSpotifyTopMix } from './spotifyTopMix.ts';
import {
  playYoutubeUrl,
  preloadYoutubeInfo,
  type YoutubeInfoPreload,
  type YoutubePlaybackOptions,
} from './youtubePlayer.ts';
import { playYandexTrack } from './yandexPlayer.ts';
import { parseYandexPlayUri, resolveYandexPlayback } from './yandexMusicProvider.ts';
import { fetchYandexPlaylistTracks } from './yandexPlaylist.ts';
import { YandexWave } from './yandexWave.ts';
import type { DefaultPlaylistLoader, DefaultTrackStream, YoutubePlayerLike } from './playbackOrchestrator.ts';

/**
 * Сборка плееров из config — общая для приложения (index.ts) и проверки
 * перед стримом (scripts/music-check.ts), чтобы проверка играла музыку ровно
 * тем же кодом, что и стрим.
 */

/** null — Spotify не настроен. */
export function createSpotifyController(): SpotifyPlaybackController | null {
  if (!config.spotify) return null;
  const spotifyUserTokens = createSpotifyUserTokenStore({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    tokenFilePath: config.spotify.tokenFilePath,
  });
  if (!spotifyUserTokens.load()) {
    logger.error(
      'app',
      `Нет сохранённого Spotify-токена (${config.spotify.tokenFilePath}). Запусти "npm run auth:spotify" перед первым стартом.`,
    );
  }
  return new SpotifyPlaybackController(spotifyUserTokens, fetch, config.spotify.deviceName);
}

/**
 * Всё, что не Spotify, играет mpv: заказы Яндекс Музыки хранятся в очереди
 * как yandex:track:<id>, остальное — ссылки на YouTube.
 */
export function createMpvPlayer(): YoutubePlayerLike {
  const youtubeOptions = (): YoutubePlaybackOptions => ({
    playerClient: config.youtube.playerClient,
    cookiesFromBrowser: config.youtube.cookiesFromBrowser,
    cookiesFile: config.youtube.cookiesFile,
    ytdlPath: config.youtube.ytdlPath,
    forceIpv4: config.youtube.forceIpv4,
    volume: config.youtube.volume,
    audioDevice: config.youtube.audioDevice,
  });

  // Заранее разобранный следующий YouTube-трек (см. prepare). Привязан к
  // ссылке: если следующим заиграло другое (пришёл заказ, скип), заготовка
  // просто выбрасывается — сыграть не тот трек из-за неё нельзя.
  let preload: { url: string; createdAt: number; preload: YoutubeInfoPreload } | null = null;
  const takePreload = (url: string): YoutubeInfoPreload | undefined => {
    const current = preload;
    preload = null;
    if (current && current.url === url && Date.now() - current.createdAt < PRELOAD_MAX_AGE_MS) return current.preload;
    current?.preload.cancel();
    return undefined;
  };

  return {
    prepare: (url) => {
      if (parseYandexPlayUri(url) !== null) return;
      if (preload?.url === url) return;
      preload?.preload.cancel();
      logger.info('playback', `Заранее разбираю следующий YouTube-трек: ${url}`);
      preload = { url, createdAt: Date.now(), preload: preloadYoutubeInfo(url, youtubeOptions()) };
    },
    play: (url) => {
      const preloaded = takePreload(url);
      const yandexTrackId = parseYandexPlayUri(url);
      if (yandexTrackId !== null) {
        const token = config.yandexMusic?.token;
        if (!token) {
          // Заказ попал в очередь, пока токен был, а потом его убрали из .env.
          return {
            finished: Promise.reject(new Error('Заказ из Яндекс Музыки, но YANDEX_MUSIC_TOKEN не задан')),
            stop: () => {},
          };
        }
        const targetLufs = config.yandexMusic?.loudnessTargetLufs ?? null;
        return playYandexTrack(() => resolveYandexPlayback(yandexTrackId, token, targetLufs), config.mpvPath, {
          volume: config.youtube.volume,
          audioDevice: config.youtube.audioDevice,
        });
      }
      return playYoutubeUrl(url, config.mpvPath, youtubeOptions(), preloaded);
    },
  };
}

/** Ссылки на форматы YouTube живут часы; старше этого заготовку не используем. */
const PRELOAD_MAX_AGE_MS = 30 * 60_000;

/**
 * Откуда брать треки для таблицы дефолтного плейлиста. config.ts гарантирует,
 * что задан не больше чем один плейлист: Spotify (SPOTIFY_DEFAULT_PLAYLIST_URI)
 * или Яндекс Музыка (YANDEX_DEFAULT_PLAYLIST_URL) — плейлист или Моя волна.
 */
export function createDefaultPlaylistLoader(
  spotifyController: SpotifyPlaybackController | null,
): DefaultPlaylistLoader | DefaultTrackStream | null {
  const yandex = config.yandexMusic;
  const yandexDefault = yandex?.defaultPlaylist;
  if (yandex && yandexDefault?.kind === 'wave') {
    logger.info('app', 'Дефолтный плейлист — Моя волна Яндекс Музыки.');
    return new YandexWave(yandex.token);
  }
  if (yandex && yandexDefault) {
    const ref = yandexDefault.ref;
    return () => fetchYandexPlaylistTracks(ref, yandex.token);
  }
  const playlistUri = config.spotify?.defaultPlaylistUri;
  if (spotifyController && playlistUri) {
    const controller = spotifyController;
    const isTop = playlistUri === SPOTIFY_TOP_TRACKS;
    if (isTop) logger.info('app', 'Дефолтный плейлист — микс топ-треков Spotify (год, полгода, месяц).');
    return async () =>
      (await (isTop ? loadSpotifyTopMix(controller) : controller.fetchPlaylistTracks(playlistUri))).map((t) => ({
        provider: 'spotify' as const,
        playUri: t.uri,
        title: t.title,
        author: t.artist,
        durationSec: Math.round(t.durationMs / 1000),
      }));
  }
  logger.warn('app', 'Дефолтный плейлист не задан — между заказами будет тишина.');
  return null;
}
