/**
 * Проверка перед стримом: музыка заказывается и реально играет.
 *
 *   npm run check:music   (или check-music.bat)
 *
 * По очереди, тем же кодом, что и на стриме (оркестратор, processSongRequest,
 * плееры из playbackSetup.ts):
 *   1. дефолтный плейлист запустился и играет;
 *   2. заказ по ссылке на трек Spotify;
 *   3. заказ по названию (поиск в Spotify);
 *   4. заказ по ссылке на YouTube;
 *   5. заказ по ссылке на Яндекс Музыку.
 *
 * "Играет" — не просто "поставилось в очередь": у Spotify трек должен
 * появиться на устройстве и его позиция должна расти, у mpv (YouTube, Яндекс)
 * — mpv должен открыть аудиовыход и проиграть ещё несколько секунд без ошибки.
 * Каждый трек звучит несколько секунд, потом скипается.
 *
 * Очередь — в памяти, база приложения не трогается. Чат Twitch не нужен:
 * заказ делается напрямую, как от стримера (без проверки фолловинга).
 * Пока запущено само приложение, проверка не стартует — она перехватила бы
 * Spotify и mpv посреди его работы.
 */
import { execFileSync } from 'node:child_process';
import { config } from '../src/core/config.ts';
import { logger } from '../src/core/logger.ts';
import { initDb } from '../src/db/index.ts';
import { peekNextPending, markPlaying, markDone } from '../src/db/musicQueue.ts';
import {
  appendDefaultTracks,
  countDefaultTracks,
  peekNextDefaultTrack,
  removeDefaultTrack,
  replaceDefaultTracks,
} from '../src/db/defaultTracks.ts';
import { PlaybackOrchestrator, type SpotifyPlaybackLike, type YoutubePlayerLike } from '../src/music/playbackOrchestrator.ts';
import { createSpotifyController, createMpvPlayer, createDefaultPlaylistLoader } from '../src/music/playbackSetup.ts';
import { processSongRequest, type RequestHandlerConfig, type SongRequester } from '../src/music/requestHandler.ts';
import { parseRequestLink } from '../src/music/linkParser.ts';
import type { PlaybackSession } from '../src/music/youtubePlayer.ts';

// Тестовые заказы. Если какой-то трек перестанет открываться (удалили,
// недоступен в регионе) — замени ссылку на любую другую рабочую.
const CHECK_REQUESTS = {
  spotifyLink: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8',
  spotifySearch: 'a-ha - Take On Me',
  youtubeLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  yandexLink: 'https://music.yandex.ru/album/14599232/track/609676',
};

/** Сколько ждать первый трек дефолтного плейлиста: сначала плейлист загружается целиком. */
const DEFAULT_START_TIMEOUT_MS = 90_000;
/** Сколько ждать, пока заказ начнёт играть (yt-dlp бывает небыстрым). */
const REQUEST_START_TIMEOUT_MS = 60_000;
/** Сколько ждать, пока Spotify отчитается, что играет нужный трек. */
const SPOTIFY_PLAYING_TIMEOUT_MS = 30_000;
/** Сколько mpv должен играть без ошибки после того, как пошёл звук. */
const MPV_HOLD_MS = 5_000;

const CHECK_REQUESTER: SongRequester = {
  userId: 'music-check',
  login: 'music-check',
  displayName: 'music-check',
  isBroadcaster: true,
};

type StartedPlayback = { kind: 'spotify'; uri: string } | { kind: 'mpv'; url: string; session: PlaybackSession };

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

process.on('unhandledRejection', (err) => {
  logger.error('check', 'Необработанный promise rejection', err);
});

if (isAppRunning()) {
  logger.error(
    'check',
    'stream-companion сейчас запущен — проверка перехватила бы его Spotify и mpv. Закрой приложение и запусти проверку снова.',
  );
  process.exit(2);
}

// Очередь заказов проверки — только в памяти.
initDb(':memory:');

const spotify = createSpotifyController();

// --- Плееры с "подслушкой": проверке нужно знать, какой трек и чем запущен ---
let onPlaybackStarted: ((started: StartedPlayback) => void) | null = null;

function notifyStarted(started: StartedPlayback): void {
  const listener = onPlaybackStarted;
  onPlaybackStarted = null;
  listener?.(started);
}

/** Ждать следующий запуск трека. Вызывать ДО действия, которое его запустит. */
function expectPlaybackStart(timeoutMs: number): { started: Promise<StartedPlayback>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const started = new Promise<StartedPlayback>((resolve, reject) => {
    timer = setTimeout(() => {
      onPlaybackStarted = null;
      reject(new Error(`трек так и не запустился за ${Math.round(timeoutMs / 1000)} с (подробности — в логе выше)`));
    }, timeoutMs);
    onPlaybackStarted = (s) => {
      clearTimeout(timer);
      resolve(s);
    };
  });
  return {
    started,
    cancel: () => {
      clearTimeout(timer);
      onPlaybackStarted = null;
    },
  };
}

const spotifyObserved: SpotifyPlaybackLike | null = spotify && {
  getCurrentPlayback: () => spotify.getCurrentPlayback(),
  playTrackUri: async (uri) => {
    notifyStarted({ kind: 'spotify', uri });
    await spotify.playTrackUri(uri);
  },
  skipToNext: () => spotify.skipToNext(),
  queueTrack: (uri) => spotify.queueTrack(uri),
  pause: () => spotify.pause(),
};

const mpv = createMpvPlayer();
const mpvObserved: YoutubePlayerLike = {
  play: (url) => {
    const session = mpv.play(url);
    notifyStarted({ kind: 'mpv', url, session });
    return session;
  },
};

const defaultPlaylistLoader = createDefaultPlaylistLoader(spotify);
const orchestrator = new PlaybackOrchestrator(
  spotifyObserved,
  mpvObserved,
  { peekNextPending, markPlaying, markDone },
  {
    peekNext: peekNextDefaultTrack,
    remove: removeDefaultTrack,
    replaceAll: replaceDefaultTracks,
    append: appendDefaultTracks,
    count: countDefaultTracks,
  },
  defaultPlaylistLoader,
  {
    pollIntervalMs: config.playback.pollIntervalMs,
    // Как на стриме: заодно проверяется, что играет не только первый трек плейлиста.
    shuffleDefaultPlaylist: config.playback.shuffleDefaultPlaylist,
  },
);

const requestCfg: RequestHandlerConfig = {
  commandName: config.chat.commandName,
  minFollowerDays: config.chat.minFollowerDays,
  maxYoutubeDurationSec: config.youtube.maxDurationSec,
  youtubeApiKey: config.youtube.apiKey,
  spotify: config.spotify ? { clientId: config.spotify.clientId, clientSecret: config.spotify.clientSecret } : undefined,
  yandex: config.yandexMusic ?? undefined,
  twitchClientId: config.twitch.clientId,
  twitchBroadcasterId: config.chat.broadcasterId,
  // Заказ идёт от имени стримера — фолловинг не проверяется, токен не нужен.
  getTwitchAccessToken: () => Promise.reject(new Error('проверке токен Twitch не нужен')),
};

// --- Проверка "реально играет" ---

async function verifySpotifyPlaying(uri: string): Promise<string> {
  if (!spotify) throw new Error('трек Spotify, но Spotify не настроен');
  const deadline = Date.now() + SPOTIFY_PLAYING_TIMEOUT_MS;
  let firstProgressMs: number | null = null;
  let lastState = 'Spotify не ответил';
  while (Date.now() < deadline) {
    await sleep(1000);
    const pb = await spotify.getCurrentPlayback().catch((err: unknown) => {
      lastState = `ошибка опроса Spotify: ${err instanceof Error ? err.message : String(err)}`;
      return undefined;
    });
    if (pb === undefined) continue;
    if (!pb) {
      lastState = 'на устройстве ничего не играет';
      continue;
    }
    if (pb.trackUri !== uri || !pb.isPlaying) {
      lastState = pb.isPlaying ? `играет другой трек (${pb.trackUri})` : 'трек стоит на паузе';
      firstProgressMs = null;
      continue;
    }
    if (firstProgressMs === null) {
      firstProgressMs = pb.progressMs;
    } else if (pb.progressMs > firstProgressMs) {
      return `Spotify играет "${pb.trackArtist} - ${pb.trackTitle}"`;
    }
  }
  const device = config.spotify?.deviceName ? `устройство "${config.spotify.deviceName}"` : 'активное устройство';
  throw new Error(`Spotify не играет ${uri} (${device}): ${lastState}. Открыт ли Spotify?`);
}

async function verifyMpvPlaying(session: PlaybackSession): Promise<string> {
  const failed = session.finished.then(
    () => {
      throw new Error('mpv завершился раньше времени — трек не играет');
    },
    (err: unknown) => {
      throw new Error(`mpv не смог играть: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  failed.catch(() => {}); // после скипа finished резолвится — это не ошибка проверки

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`mpv не начал выводить звук за ${REQUEST_START_TIMEOUT_MS / 1000} с`)),
      REQUEST_START_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([session.audioStarted ?? Promise.resolve(), failed, timeout]);
  } finally {
    clearTimeout(timer);
  }
  await Promise.race([sleep(MPV_HOLD_MS), failed]);
  return `mpv играет (звук идёт, ${MPV_HOLD_MS / 1000} с без ошибок)`;
}

function verifyPlaying(started: StartedPlayback): Promise<string> {
  return started.kind === 'spotify' ? verifySpotifyPlaying(started.uri) : verifyMpvPlaying(started.session);
}

async function currentTrackLabel(): Promise<string> {
  const track = await orchestrator.getCurrentTrack();
  return track ? `"${track.author} - ${track.title}"` : '(неизвестный трек)';
}

// --- Сами проверки ---

async function checkDefaultPlaylist(): Promise<string> {
  const expectation = expectPlaybackStart(DEFAULT_START_TIMEOUT_MS);
  void orchestrator.start();
  if (!defaultPlaylistLoader) {
    expectation.cancel();
    throw new Error('дефолтный плейлист не задан (SPOTIFY_DEFAULT_PLAYLIST_URI или YANDEX_DEFAULT_PLAYLIST_URL в .env)');
  }
  const started = await expectation.started;
  const label = await currentTrackLabel();
  return `${label} — ${await verifyPlaying(started)}`;
}

/** Строка, которая должна быть в uri/ссылке запущенного трека; null — не проверяем (поиск). */
function expectedPlayUriPart(input: string): string | null {
  const parsed = parseRequestLink(input);
  if (parsed.type === 'spotify') return `spotify:track:${parsed.trackId}`;
  if (parsed.type === 'youtube') return parsed.videoId;
  if (parsed.type === 'yandex') return `yandex:track:${parsed.trackId}`;
  return null;
}

async function checkRequest(input: string, notConfiguredReason: string | null): Promise<string> {
  if (notConfiguredReason) throw new Error(notConfiguredReason);

  const expectation = expectPlaybackStart(REQUEST_START_TIMEOUT_MS);
  const outcome = await processSongRequest(CHECK_REQUESTER, input, requestCfg, {
    emptyArgHint: '',
    requireFollower: false,
  }).catch((err: unknown) => {
    expectation.cancel();
    throw err;
  });
  if (!outcome.queued) {
    expectation.cancel();
    throw new Error(`заказ не принят: ${outcome.replyText}`);
  }

  // Текущий трек сам не прерывается — скипаем его, чтобы сразу заиграл заказ.
  if (!orchestrator.skip()) orchestrator.skipDefaultPlaylist();

  const started = await expectation.started;
  const played = started.kind === 'spotify' ? started.uri : started.url;
  const expected = expectedPlayUriPart(input);
  if (orchestrator.getMode() !== 'request' || (expected && !played.includes(expected))) {
    throw new Error(`вместо заказа запустилось другое: ${played}`);
  }
  const label = await currentTrackLabel();
  return `${label} — ${await verifyPlaying(started)}`;
}

const spotifyOff = config.spotify ? null : 'Spotify не настроен (SPOTIFY_* в .env)';
const checks: [string, () => Promise<string>][] = [
  ['Дефолтный плейлист', checkDefaultPlaylist],
  ['Заказ по ссылке Spotify', () => checkRequest(CHECK_REQUESTS.spotifyLink, spotifyOff)],
  ['Заказ по названию (поиск Spotify)', () => checkRequest(CHECK_REQUESTS.spotifySearch, spotifyOff)],
  [
    'Заказ по ссылке YouTube',
    () => checkRequest(CHECK_REQUESTS.youtubeLink, config.youtube.apiKey ? null : 'YouTube не настроен (YOUTUBE_API_KEY в .env)'),
  ],
  [
    'Заказ по ссылке Яндекс Музыки',
    () => checkRequest(CHECK_REQUESTS.yandexLink, config.yandexMusic ? null : 'Яндекс Музыка не настроена (YANDEX_MUSIC_TOKEN в .env)'),
  ],
];

async function cleanup(): Promise<void> {
  orchestrator.stop(); // останавливает mpv
  // Spotify после скипа сам не замолкает — ставим на паузу.
  await spotify?.pause().catch(() => {});
}

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});

const results: CheckResult[] = [];
for (const [index, [name, run]] of checks.entries()) {
  const fullName = `${index + 1}. ${name}`;
  logger.info('check', `=== ${fullName} ===`);
  try {
    const detail = await run();
    results.push({ name: fullName, ok: true, detail });
    logger.info('check', `OK: ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name: fullName, ok: false, detail });
    logger.error('check', `ПРОВАЛ: ${detail}`);
  }
}

await cleanup();

const failedCount = results.filter((r) => !r.ok).length;
console.log('');
console.log('================ Итог проверки музыки ================');
for (const r of results) {
  console.log(`${r.ok ? '[ OK ]' : '[FAIL]'} ${r.name}`);
  console.log(`       ${r.detail.split('\n')[0]}`);
}
console.log('======================================================');
console.log(failedCount === 0 ? 'Всё работает — можно начинать стрим.' : `Не прошло проверок: ${failedCount} из ${results.length}.`);
process.exit(failedCount === 0 ? 0 : 1);

/** Запущен ли сам stream-companion (node src/index.ts) — только Windows, где он и живёт. */
function isAppRunning(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object CommandLine`],
      { encoding: 'utf8' },
    );
    return /src[\\/]index\.ts/.test(out);
  } catch {
    // Не смогли проверить — не мешаем запуску.
    return false;
  }
}
