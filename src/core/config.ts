import { normalizeSpotifyPlaylistUri } from '../music/spotifyPlaylistUri.ts';
import { parseYandexPlaylistUrl, type YandexPlaylistRef } from '../music/yandexPlaylist.ts';
import { logger } from './logger.ts';

/**
 * Загружает .env (если он есть) и собирает типизированный конфиг из
 * переменных окружения. Падает с понятной ошибкой, если чего-то не хватает —
 * лучше узнать об этом сразу при старте, а не посреди работы.
 */

function loadDotEnvIfPresent(): void {
  try {
    // process.loadEnvFile — встроенная в Node (>=20.6) загрузка .env,
    // без сторонних зависимостей вроде dotenv.
    process.loadEnvFile();
  } catch {
    // .env необязателен — переменные могут быть заданы окружением напрямую
  }
}

loadDotEnvIfPresent();

// Флаг командной строки, чтобы запустить приложение сразу с приостановленными
// заказами (например, техническая пауза перед стримом) — без него пришлось бы
// сразу после старта писать !pr в чат самому. Включить обратно — команда !rr
// (см. requestsToggleHandler.ts) с тем же эффектом, как если бы её ввёл модератор.
const cliArgs = process.argv.slice(2);
const startWithRequestsPaused = cliArgs.includes('-s') || cliArgs.includes('--pause-requests');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Отсутствует обязательная переменная окружения: ${name}. Скопируй .env.example в .env и заполни значения.`,
    );
  }
  return value;
}

/**
 * Источники заказов (YouTube, Spotify, Яндекс Музыка) необязательны по
 * отдельности: источник, которому не хватает переменных, отключается, а в
 * лог пишется, чего именно не хватает. true — источник настроен полностью.
 */
function checkMusicSource(sourceName: string, varNames: string[], disabledNote: string): boolean {
  const missing = varNames.filter((name) => !process.env[name]);
  if (missing.length === 0) {
    logger.info('config', `${sourceName}: настроено`);
    return true;
  }
  logger.warn('config', `${sourceName}: не заданы ${missing.join(', ')} — ${disabledNote}`);
  return false;
}

// Как часто оркестратор опрашивает Spotify, пока играет Spotify-трек (конец
// трека он всё равно ловит точно, см. spotifyTrackPlayer.ts), и как долго
// ждёт, когда играть нечего.
const spotifyPollIntervalMs = Number(process.env.SPOTIFY_POLL_INTERVAL_MS ?? 4000);
if (!Number.isFinite(spotifyPollIntervalMs) || spotifyPollIntervalMs < 500) {
  throw new Error(`SPOTIFY_POLL_INTERVAL_MS должен быть числом от 500 (мс), а задано "${process.env.SPOTIFY_POLL_INTERVAL_MS}".`);
}

// Перемешивать ли дефолтный плейлист (любой — Spotify или Яндекс) при загрузке
// в базу. Старое имя YANDEX_DEFAULT_PLAYLIST_SHUFFLE тоже понимается.
const shuffleDefaultPlaylist =
  (process.env.DEFAULT_PLAYLIST_SHUFFLE ?? process.env.YANDEX_DEFAULT_PLAYLIST_SHUFFLE ?? 'true').trim().toLowerCase() !==
  'false';

// Порт оверлея "сейчас играет" (http://localhost:<порт>/overlay). 0 или off — выключен.
const overlayPortRaw = (process.env.OVERLAY_PORT ?? '8890').trim().toLowerCase();
const overlayPort = overlayPortRaw === 'off' || overlayPortRaw === '0' ? null : Number(overlayPortRaw);
if (overlayPort !== null && (!Number.isInteger(overlayPort) || overlayPort < 1 || overlayPort > 65535)) {
  throw new Error(`OVERLAY_PORT должен быть номером порта (1-65535), 0 или off, а задано "${process.env.OVERLAY_PORT}".`);
}

// Режим заказа музыки: командой в чате (!sr) или за баллы канала — только
// один из двух одновременно, см. MUSIC_REQUEST_MODE в .env.example.
const requestModeRaw = (process.env.MUSIC_REQUEST_MODE ?? 'command').trim().toLowerCase();
if (requestModeRaw !== 'command' && requestModeRaw !== 'points') {
  throw new Error(`MUSIC_REQUEST_MODE должен быть "command" или "points", а задано "${process.env.MUSIC_REQUEST_MODE}".`);
}
const requestMode: 'command' | 'points' = requestModeRaw;

// Privilege-режим (только для MUSIC_REQUEST_MODE=points): заказы стримера,
// модераторов и VIP бесплатны — см. MUSIC_PRIVILEGE_MODE в .env.example.
const privilegeModeRaw = (process.env.MUSIC_PRIVILEGE_MODE ?? 'false').trim().toLowerCase();
if (privilegeModeRaw !== 'true' && privilegeModeRaw !== 'false') {
  throw new Error(`MUSIC_PRIVILEGE_MODE должен быть "true" или "false", а задано "${process.env.MUSIC_PRIVILEGE_MODE}".`);
}
const privilegeMode = privilegeModeRaw === 'true';

const rewardCost = Number(process.env.MUSIC_REWARD_COST ?? 500);
if (!Number.isInteger(rewardCost) || rewardCost < 1) {
  throw new Error(`MUSIC_REWARD_COST должен быть целым числом баллов от 1, а задано "${process.env.MUSIC_REWARD_COST}".`);
}

// Необязательно. OAuth-токен аккаунта Яндекс Музыки с подпиской Плюс (см.
// .env.example, как его получить). Не задан — ссылки на Яндекс Музыку
// отклоняются.
const yandexMusicToken = process.env.YANDEX_MUSIC_TOKEN || undefined;

// Выравнивание громкости треков Яндекс Музыки до уровня нормализации Spotify
// (см. YANDEX_LOUDNESS_TARGET_LUFS в .env.example). null — выключено.
const yandexLoudnessRaw = (process.env.YANDEX_LOUDNESS_TARGET_LUFS ?? '-14').trim().toLowerCase();
const yandexLoudnessTargetLufs = yandexLoudnessRaw === 'off' ? null : Number(yandexLoudnessRaw);
if (yandexLoudnessTargetLufs !== null && !(yandexLoudnessTargetLufs < 0 && yandexLoudnessTargetLufs >= -40)) {
  throw new Error(
    `YANDEX_LOUDNESS_TARGET_LUFS должен быть числом от -40 до 0 (например -14) или "off", ` +
      `а задано "${process.env.YANDEX_LOUDNESS_TARGET_LUFS}".`,
  );
}

// Необязательно. Дефолтный плейлист из Яндекс Музыки вместо Spotify-плейлиста.
// Дефолтный плейлист может быть только один: заданы оба — это недосмотр,
// падаем сразу, а не выбираем за стримера молча. WAVE вместо ссылки — Моя
// волна (см. music/yandexWave.ts).
const yandexDefaultPlaylistRaw = process.env.YANDEX_DEFAULT_PLAYLIST_URL?.trim() || undefined;
let yandexDefaultPlaylist: { kind: 'playlist'; ref: YandexPlaylistRef } | { kind: 'wave' } | null = null;
if (yandexDefaultPlaylistRaw) {
  if (process.env.SPOTIFY_DEFAULT_PLAYLIST_URI) {
    throw new Error(
      'Заданы сразу YANDEX_DEFAULT_PLAYLIST_URL и SPOTIFY_DEFAULT_PLAYLIST_URI — дефолтный плейлист может быть ' +
        'только один. Оставь одну из переменных.',
    );
  }
  if (!yandexMusicToken) {
    throw new Error('YANDEX_DEFAULT_PLAYLIST_URL задан, но нет YANDEX_MUSIC_TOKEN — без токена треки не сыграть.');
  }
  if (yandexDefaultPlaylistRaw.toLowerCase() === 'wave') {
    yandexDefaultPlaylist = { kind: 'wave' };
  } else {
    const ref = parseYandexPlaylistUrl(yandexDefaultPlaylistRaw);
    if (!ref) {
      throw new Error(
        `YANDEX_DEFAULT_PLAYLIST_URL не похож на ссылку на плейлист Яндекс Музыки: "${yandexDefaultPlaylistRaw}". ` +
          'Нужна ссылка вида https://music.yandex.ru/playlists/<id> (Поделиться → Скопировать ссылку) ' +
          'или WAVE — Моя волна.',
      );
    }
    yandexDefaultPlaylist = { kind: 'playlist', ref };
  }
}

// Проверяем источники заказов по очереди. Не настроен ни один — заказывать
// музыку нечем, и работать дальше бессмысленно: сообщаем и завершаемся.
const youtubeEnabled = checkMusicSource(
  'YouTube',
  ['YOUTUBE_API_KEY'],
  'заказы по ссылкам на YouTube отключены.',
);
// С дефолтным плейлистом из Яндекса Spotify нужен только для Spotify-заказов,
// и SPOTIFY_DEFAULT_PLAYLIST_URI не требуется (задавать его нельзя, см. выше).
const spotifyEnabled = checkMusicSource(
  'Spotify',
  yandexDefaultPlaylist
    ? ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']
    : ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_DEFAULT_PLAYLIST_URI'],
  'интеграция со Spotify отключена, ссылки на Spotify и поиск трека по названию не принимаются.',
);
const yandexEnabled = checkMusicSource(
  'Яндекс Музыка',
  ['YANDEX_MUSIC_TOKEN'],
  'заказы по ссылкам на Яндекс Музыку отключены.',
);
if (!youtubeEnabled && !spotifyEnabled && !yandexEnabled) {
  logger.error(
    'config',
    'Не настроен ни один источник заказов музыки (YouTube, Spotify, Яндекс Музыка) — см. предупреждения выше. ' +
      'Заполни переменные хотя бы для одного из них в .env (см. .env.example). Приложение завершает работу.',
  );
  process.exit(1);
}

const spotify =
  spotifyEnabled
    ? {
        clientId: required('SPOTIFY_CLIENT_ID'),
        clientSecret: required('SPOTIFY_CLIENT_SECRET'),
        tokenFilePath: process.env.SPOTIFY_TOKEN_FILE ?? './data/spotify-token.json',
        // Принимает и https://open.spotify.com/playlist/<id>?si=..., и голый
        // <id>, и spotify:playlist:<id> — см. music/spotifyPlaylistUri.ts
        // null — дефолтный плейлист из Яндекс Музыки (см. выше).
        defaultPlaylistUri: yandexDefaultPlaylist
          ? null
          : normalizeSpotifyPlaylistUri(required('SPOTIFY_DEFAULT_PLAYLIST_URI')),
        // Необязательно. Точное имя устройства из Spotify Connect (см. "node
        // scripts/spotify-devices.ts"). Если не задано — приложение полагается
        // на то, что у аккаунта уже есть "активное устройство" (см. ошибку
        // HTTP 404 в spotifyProvider.ts, если что-то пошло не так).
        deviceName: process.env.SPOTIFY_DEVICE_NAME || undefined,
      }
    : null;

export const config = {
  twitch: {
    clientId: required('TWITCH_CLIENT_ID'),
    clientSecret: required('TWITCH_CLIENT_SECRET'),
    broadcasterLogin: required('TWITCH_BROADCASTER_LOGIN'),
  },
  db: {
    path: process.env.DB_PATH ?? './data/stream-companion.sqlite',
  },
  chat: {
    // Аккаунт, от имени которого бот пишет в чат. Если это сам broadcaster —
    // укажи тот же логин, что и TWITCH_BROADCASTER_LOGIN. Если отдельный бот —
    // он должен быть модератором канала (нужно для проверки фолловеров).
    botUsername: required('TWITCH_CHAT_BOT_USERNAME'),
    tokenFilePath: process.env.TWITCH_CHAT_TOKEN_FILE ?? './data/twitch-chat-token.json',
    broadcasterId: required('TWITCH_BROADCASTER_ID'),
    commandName: process.env.MUSIC_COMMAND ?? '!sr',
    minFollowerDays: Number(process.env.MUSIC_MIN_FOLLOWER_DAYS ?? 3),
    // Команда "текущий трек" — показывает в чате трек, который сейчас играет
    // (дефолтный плейлист или заказ), в том же виде, что и при добавлении в
    // очередь. Доступна всем без ограничений по фолловингу.
    currentTrackCommand: process.env.MUSIC_CURRENT_COMMAND ?? '!s',
    // Команда голосования за скип текущего трека и порог голосования — см.
    // skipVoteHandler.ts. Скипает броадкастер — сразу, без порога; остальные
    // зрители — голосованием, от числа зрителей стрима (Twitch Get Streams).
    skipCommand: process.env.MUSIC_SKIP_COMMAND ?? '!skip',
    skipThresholdPercent: Number(process.env.MUSIC_SKIP_THRESHOLD_PERCENT ?? 30),
    // Команды приостановки/возобновления приёма заказов (только для стримера
    // и модераторов) — см. requestsToggleHandler.ts. Пока приостановлено, не
    // играет и дефолтный плейлист (не только новые заказы недоступны).
    pauseRequestsCommand: process.env.MUSIC_PAUSE_COMMAND ?? '!pr',
    resumeRequestsCommand: process.env.MUSIC_RESUME_COMMAND ?? '!rr',
    // См. cliArgs/startWithRequestsPaused выше — запуск с флагом -s/--pause-requests.
    startWithRequestsPaused,
  },
  // Заказ музыки за баллы канала (MUSIC_REQUEST_MODE=points) — см.
  // pointsMode.ts. Правила заказа те же, что у команды.
  points: {
    requestMode,
    privilegeMode,
    // Токен именно стримера (не бота) со скоупом channel:manage:redemptions —
    // отдельный от чат-токена, см. npm run auth:twitch-points.
    tokenFilePath: process.env.TWITCH_BROADCASTER_TOKEN_FILE ?? './data/twitch-broadcaster-token.json',
    // Название/цена/подсказка — только для создания награды; дальше её
    // настраивают в панели Twitch (см. ensureReward).
    rewardTitle: process.env.MUSIC_REWARD_TITLE || 'Заказ музыки',
    rewardCost,
    rewardPrompt:
      process.env.MUSIC_REWARD_PROMPT ||
      `Ссылка на ${[
        ...(youtubeEnabled ? ['YouTube'] : []),
        ...(spotify ? ['Spotify'] : []),
        ...(yandexMusicToken ? ['Яндекс Музыку'] : []),
      ].join(', ')}${spotify ? ', либо название трека' : ''}. Если заказ не пройдёт — баллы вернутся.`,
  },
  youtube: {
    // undefined — YOUTUBE_API_KEY не задан, заказы по ссылкам на YouTube
    // отклоняются (воспроизведение через mpv при этом нужно Яндекс Музыке).
    apiKey: youtubeEnabled ? required('YOUTUBE_API_KEY') : undefined,
    maxDurationSec: Number(process.env.YOUTUBE_MAX_DURATION_SEC ?? 600),
    // Обходит проверку YouTube "Sign in to confirm you're not a bot" и
    // связанные с ней ошибки при локальном воспроизведении через mpv/yt-dlp —
    // см. комментарии в .env.example и youtubePlayer.ts. YouTube регулярно
    // меняет правила, так что при необходимости значение может понадобиться
    // сменить — это не жёстко зашитое "правильное" значение навсегда.
    // "android"-семейство клиентов (в т.ч. android_vr) сейчас особенно часто
    // ловит HTTP 403 на самом проигрывании (уже после успешного разбора
    // ссылки) — поэтому по умолчанию не используется, см. .env.example.
    playerClient: process.env.YOUTUBE_PLAYER_CLIENT ?? 'tv,web_safari,web_embedded',
    cookiesFromBrowser: process.env.YOUTUBE_COOKIES_FROM_BROWSER || undefined,
    cookiesFile: process.env.YOUTUBE_COOKIES_FILE || undefined,
    // Явный путь к yt-dlp, если на машине их несколько и mpv резолвит не
    // тот, который реально обновлялся (см. YTDLP_PATH в .env.example).
    ytdlPath: process.env.YTDLP_PATH || undefined,
    // См. YOUTUBE_FORCE_IPV4 в .env.example — обход HTTP 403 на dual-stack сетях.
    forceIpv4: process.env.YOUTUBE_FORCE_IPV4 === 'true',
    // Громкость mpv при старте YouTube-заказа (0-100). По умолчанию 50 —
    // раньше mpv стартовал со своей дефолтной громкостью (обычно заметно
    // громче, чем играл до этого Spotify), см. MPV_VOLUME в .env.example.
    volume: Number(process.env.MPV_VOLUME ?? 50),
    // Аудио-устройство для вывода звука mpv (например виртуальный кабель
    // для отдельного захвата в OBS) — см. MPV_AUDIO_DEVICE в .env.example.
    // Не задано — mpv играет на устройство по умолчанию, как обычная система.
    audioDevice: process.env.MPV_AUDIO_DEVICE || undefined,
  },
  spotify,
  yandexMusic: yandexMusicToken
    ? { token: yandexMusicToken, defaultPlaylist: yandexDefaultPlaylist, loudnessTargetLufs: yandexLoudnessTargetLufs }
    : null,
  // Параметры цикла оркестратора воспроизведения (см. playbackOrchestrator.ts).
  playback: {
    pollIntervalMs: spotifyPollIntervalMs,
    shuffleDefaultPlaylist,
  },
  mpvPath: process.env.MPV_PATH ?? 'mpv',
  // Оверлей "сейчас играет" для OBS (см. overlay/nowPlayingOverlay.ts).
  // null — выключен (OVERLAY_PORT=0 или off).
  overlay: overlayPort === null ? null : { port: overlayPort },
} as const;
