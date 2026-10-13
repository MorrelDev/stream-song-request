import { config } from './core/config.ts';
import { logger } from './core/logger.ts';
import { initDb } from './db/index.ts';
import { peekNextPending, markPlaying, markDone } from './db/musicQueue.ts';
import { TwitchChatClient } from './integrations/twitch/chatClient.ts';
import { createTwitchUserTokenStore } from './integrations/twitch/twitchUserAuth.ts';
import { getStreamViewerCount } from './integrations/twitch/streamInfo.ts';
import { registerMusicRequestHandler, type RequestHandlerConfig } from './music/requestHandler.ts';
import { startPointsRequestMode, disablePointsReward, type PointsModeHandle } from './music/pointsMode.ts';
import { registerSkipVoteHandler } from './music/skipVoteHandler.ts';
import { registerCurrentTrackHandler } from './music/currentTrackHandler.ts';
import { registerRequestsToggleHandler } from './music/requestsToggleHandler.ts';
import { setRequestsPaused } from './music/requestsGate.ts';
import { PlaybackOrchestrator } from './music/playbackOrchestrator.ts';
import { createSpotifyController, createMpvPlayer, createDefaultPlaylistLoader } from './music/playbackSetup.ts';
import {
  appendDefaultTracks,
  countDefaultTracks,
  peekNextDefaultTrack,
  removeDefaultTrack,
  replaceDefaultTracks,
} from './db/defaultTracks.ts';
import { startNowPlayingOverlay } from './overlay/nowPlayingOverlay.ts';

// Подстраховка: необработанный reject где-то в цепочке промисов не должен
// ронять всё приложение посреди стрима — логируем и продолжаем работать.
process.on('unhandledRejection', (err) => {
  logger.error('app', 'Необработанный promise rejection (см. детали ниже) — приложение продолжает работать', err);
});

logger.info('app', 'Запуск stream-companion...');

initDb(config.db.path);

// Запуск с флагом -s/--pause-requests — сразу приостановленные заказы (см.
// config.ts). Установлено до старта оркестратора и любых обработчиков чата,
// чтобы дефолтный плейлист не успел запуститься даже на долю секунды.
if (config.chat.startWithRequestsPaused) {
  setRequestsPaused(true);
  logger.info(
    'app',
    `Заказы музыки запущены в приостановленном состоянии (флаг -s/--pause-requests). Включить — команда "${config.chat.resumeRequestsCommand}" в чате (стример/модератор).`,
  );
}

// --- Заказ музыки ---
const twitchUserTokens = createTwitchUserTokenStore({
  clientId: config.twitch.clientId,
  clientSecret: config.twitch.clientSecret,
  tokenFilePath: config.chat.tokenFilePath,
});
if (!twitchUserTokens.load()) {
  logger.error(
    'app',
    `Нет сохранённого Twitch chat-токена (${config.chat.tokenFilePath}). Запусти "npm run auth:twitch" перед первым стартом.`,
  );
}

const chatClient = new TwitchChatClient({
  botUsername: config.chat.botUsername,
  channelLogin: config.twitch.broadcasterLogin,
  getAccessToken: () => twitchUserTokens.getValidAccessToken(),
});
chatClient.connect().catch((err: unknown) => {
  logger.error('app', 'Не удалось подключиться к чату Twitch (нужна авторизация — npm run auth:twitch)', err);
});

const requestCfg: RequestHandlerConfig = {
  commandName: config.chat.commandName,
  minFollowerDays: config.chat.minFollowerDays,
  maxYoutubeDurationSec: config.youtube.maxDurationSec,
  youtubeApiKey: config.youtube.apiKey,
  // SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_DEFAULT_PLAYLIST_URI
  // необязательны (см. config.ts) — если Spotify не настроен, заказы
  // принимаются только по YouTube-ссылкам.
  spotify: config.spotify ? { clientId: config.spotify.clientId, clientSecret: config.spotify.clientSecret } : undefined,
  yandex: config.yandexMusic ?? undefined,
  twitchClientId: config.twitch.clientId,
  twitchBroadcasterId: config.chat.broadcasterId,
  getTwitchAccessToken: () => twitchUserTokens.getValidAccessToken(),
};

const isPointsMode = config.points.requestMode === 'points';
// В режиме баллов команда заказа остаётся, но только подсказывает награду.
registerMusicRequestHandler({
  ...requestCfg,
  getPointsRewardTitle: isPointsMode ? () => pointsMode?.getRewardTitle() ?? config.points.rewardTitle : undefined,
});

// --- Заказ музыки за баллы канала ---
const broadcasterTokens = createTwitchUserTokenStore({
  clientId: config.twitch.clientId,
  clientSecret: config.twitch.clientSecret,
  tokenFilePath: config.points.tokenFilePath,
});
const hasBroadcasterToken = broadcasterTokens.load();
const channelPointsApi = {
  clientId: config.twitch.clientId,
  broadcasterId: config.chat.broadcasterId,
  getAccessToken: () => broadcasterTokens.getValidAccessToken(),
};

let pointsMode: PointsModeHandle | null = null;
if (isPointsMode) {
  if (!hasBroadcasterToken) {
    logger.error(
      'app',
      `Режим заказа за баллы канала включён, но нет токена стримера (${config.points.tokenFilePath}). ` +
        'Запусти "npm run auth:twitch-points" (залогинившись аккаунтом канала) и перезапусти приложение.',
    );
  } else {
    startPointsRequestMode({
      api: channelPointsApi,
      reward: { title: config.points.rewardTitle, cost: config.points.rewardCost, prompt: config.points.rewardPrompt },
      request: requestCfg,
      privilegeMode: config.points.privilegeMode,
    })
      .then((handle) => {
        pointsMode = handle;
      })
      .catch((err: unknown) => {
        logger.error('app', 'Не удалось включить заказ музыки за баллы канала', err);
      });
  }
} else if (hasBroadcasterToken) {
  // Награда могла остаться включённой с прошлого запуска в режиме баллов.
  disablePointsReward(channelPointsApi, config.points.rewardTitle)
    .then((disabledTitle) => {
      if (disabledTitle) logger.info('app', `Награда "${disabledTitle}" выключена — сейчас заказ командой`);
    })
    .catch((err: unknown) => {
      logger.error('app', 'Не удалось выключить награду за баллы канала (режим заказа командой)', err);
    });
}

const spotifyController = createSpotifyController();

const orchestrator = new PlaybackOrchestrator(
  spotifyController,
  createMpvPlayer(),
  { peekNextPending, markPlaying, markDone },
  {
    peekNext: peekNextDefaultTrack,
    remove: removeDefaultTrack,
    replaceAll: replaceDefaultTracks,
    append: appendDefaultTracks,
    count: countDefaultTracks,
  },
  createDefaultPlaylistLoader(spotifyController),
  {
    pollIntervalMs: config.playback.pollIntervalMs,
    shuffleDefaultPlaylist: config.playback.shuffleDefaultPlaylist,
  },
);
void orchestrator.start();

// unregister не используется — обработчик живёт всё время работы приложения.
registerSkipVoteHandler(orchestrator, {
  commandName: config.chat.skipCommand,
  thresholdPercent: config.chat.skipThresholdPercent,
  getViewerCount: () =>
    getStreamViewerCount({
      clientId: config.twitch.clientId,
      broadcasterId: config.chat.broadcasterId,
      getAccessToken: () => twitchUserTokens.getValidAccessToken(),
    }),
});

registerCurrentTrackHandler(orchestrator, { commandName: config.chat.currentTrackCommand });

registerRequestsToggleHandler(orchestrator, {
  pauseCommand: config.chat.pauseRequestsCommand,
  resumeCommand: config.chat.resumeRequestsCommand,
});

// --- Оверлей "сейчас играет" для OBS ---
const overlayServer = config.overlay
  ? startNowPlayingOverlay({
      port: config.overlay.port,
      getNowPlaying: () => orchestrator.getNowPlaying(),
      spotifyApp: config.spotify ? { clientId: config.spotify.clientId, clientSecret: config.spotify.clientSecret } : null,
      getSpotifyPlayback: spotifyController ? () => spotifyController.getCurrentPlayback() : null,
      yandexToken: config.yandexMusic?.token,
    })
  : null;

logger.info(
  'app',
  isPointsMode
    ? `Обработка заказов музыки включена (за баллы канала, награда "${config.points.rewardTitle}")`
    : `Обработка заказов музыки включена (команда "${config.chat.commandName}")`,
);

// Сколько ждать постановки награды на паузу при выходе — дольше держать
// окно открытым после Ctrl+C не стоит, даже если Twitch не отвечает.
const SHUTDOWN_REWARD_PAUSE_TIMEOUT_MS = 3000;

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('app', 'Останавливаюсь...');
  orchestrator.stop();
  chatClient.disconnect();
  overlayServer?.close();
  if (pointsMode) {
    const pausing = pointsMode.stop().catch((err: unknown) => {
      logger.error('app', 'Не удалось поставить награду за баллы канала на паузу при выходе', err);
    });
    await Promise.race([pausing, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_REWARD_PAUSE_TIMEOUT_MS))]);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
