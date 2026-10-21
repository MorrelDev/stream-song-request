import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { parseRequestLink } from './linkParser.ts';
import { fetchYoutubeVideoDetails } from './youtubeProvider.ts';
import { fetchSpotifyTrackDetails, type SpotifyTrackDetails } from './spotifyProvider.ts';
import { searchSpotifyTrackByText } from './spotifySearch.ts';
import { fetchYandexTrackDetails, fetchYandexFullDownloadInfo, yandexPlayUri } from './yandexMusicProvider.ts';
import { checkFollowerEligibility } from '../integrations/twitch/followerCheck.ts';
import { enqueueSongRequest } from '../db/musicQueue.ts';
import { formatTrackTitle } from './trackFormat.ts';
import { isRequestsPaused } from './requestsGate.ts';
import type { ChatMessageEvent } from '../core/events.ts';

export interface SpotifyRequestConfig {
  clientId: string;
  clientSecret: string;
}

export interface RequestHandlerConfig {
  /** Например "!sr". Сравнение регистронезависимое. */
  commandName: string;
  minFollowerDays: number;
  maxYoutubeDurationSec: number;
  /** undefined — YouTube не настроен (нет YOUTUBE_API_KEY), ссылки на него отклоняются. */
  youtubeApiKey?: string;
  /** undefined — Spotify не настроен, ссылки на него и поиск по названию отклоняются. */
  spotify?: SpotifyRequestConfig;
  /** undefined — Яндекс Музыка не настроена (нет YANDEX_MUSIC_TOKEN), ссылки на неё отклоняются. */
  yandex?: { token: string };
  twitchClientId: string;
  twitchBroadcasterId: string;
  getTwitchAccessToken: () => Promise<string>;
  /**
   * Задано — включён режим заказа за баллы канала (см. pointsRequestHandler.ts),
   * и команда заказа в чате больше ничего не заказывает, а только подсказывает
   * название награды. Функция, а не строка: награду могут переименовать в
   * панели Twitch, и подсказка должна показывать актуальное название.
   * undefined — обычный режим заказа командой.
   */
  getPointsRewardTitle?: () => string;
}

/**
 * Откуда сейчас принимаются ссылки, для подсказок в чате: "YouTube, Spotify
 * или Яндекс Музыку" — только настроенные источники (хотя бы один настроен
 * всегда, см. config.ts). conjunction — "или" для подсказки, "и" для отказа.
 */
export function describeLinkSources(
  cfg: Pick<RequestHandlerConfig, 'youtubeApiKey' | 'spotify' | 'yandex'>,
  conjunction: 'и' | 'или',
): string {
  const sources: string[] = [];
  if (cfg.youtubeApiKey) sources.push('YouTube');
  if (cfg.spotify) sources.push('Spotify');
  if (cfg.yandex) sources.push('Яндекс Музыку');
  const last = sources.pop()!;
  return sources.length ? `${sources.join(', ')} ${conjunction} ${last}` : last;
}

/** Кто заказывает трек — общее для заказа командой и за баллы канала. */
export interface SongRequester {
  userId: string;
  login: string;
  displayName: string;
  isBroadcaster: boolean;
  /** Заказ за баллы канала: активация награды — записывается вместе с заказом (см. pointsMode.ts). */
  redemption?: { redemptionId: string; rewardId: string };
}

export interface SongRequestOptions {
  /** Что ответить (после упоминания), если ссылку не указали — у команды и у награды подсказка разная. */
  emptyArgHint: string;
  /** Проверять ли стаж фолловинга (MUSIC_MIN_FOLLOWER_DAYS). У заказа за баллы канала — нет. */
  requireFollower: boolean;
}

export interface SongRequestOutcome {
  /** true — трек поставлен в очередь. */
  queued: boolean;
  /** Готовый ответ в чат (с упоминанием зрителя). */
  replyText: string;
  /** id заказа в очереди (db/musicQueue.ts), если он поставлен. */
  requestId?: number;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/** Подписывает обработчик заказов на входящие сообщения чата. */
export function registerMusicRequestHandler(cfg: RequestHandlerConfig, fetchImpl: typeof fetch = fetch): void {
  eventBus.on('chat.message', (msg) => {
    void handleChatMessage(msg, cfg, fetchImpl).catch((err) => {
      logger.error('music', 'Ошибка обработки заказа музыки', err);
      reply(`@${msg.displayName} не получилось обработать заказ, попробуй ещё раз чуть позже`);
    });
  });
}

/**
 * Основная логика одного сообщения чата. Вынесена отдельной экспортируемой
 * функцией (не только через eventBus) — так её проще тестировать напрямую,
 * без поднятия реального чат-клиента.
 */
export async function handleChatMessage(
  msg: ChatMessageEvent,
  cfg: RequestHandlerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = msg.text.trim();
  const [cmd, ...rest] = text.split(/\s+/);
  if (!cmd || cmd.toLowerCase() !== cfg.commandName.toLowerCase()) return;

  if (cfg.getPointsRewardTitle) {
    reply(`@${msg.displayName} заказ музыки — за баллы канала, награда "${cfg.getPointsRewardTitle()}"`);
    return;
  }

  const outcome = await processSongRequest(
    msg,
    rest.join(' '),
    cfg,
    { emptyArgHint: `укажи ссылку: ${cfg.commandName} <ссылка на ${describeLinkSources(cfg, 'или')}>`, requireFollower: true },
    fetchImpl,
  );
  reply(outcome.replyText);
}

/**
 * Правила заказа — общие для команды в чате и награды за баллы канала:
 * пауза заказов, валидация ссылки/поиск, лимит длительности; фолловинг —
 * только если options.requireFollower. Сама в чат не пишет — возвращает
 * готовый текст ответа, чтобы вызывающий решал, что и когда отправить
 * (например, награду сначала нужно отклонить в Twitch).
 */
export async function processSongRequest(
  requester: SongRequester,
  rawArg: string,
  cfg: RequestHandlerConfig,
  options: SongRequestOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SongRequestOutcome> {
  const mention = `@${requester.displayName}`;
  const rejected = (text: string): SongRequestOutcome => ({ queued: false, replyText: `${mention} ${text}` });

  if (isRequestsPaused()) {
    return rejected('заказы музыки сейчас недоступны');
  }

  const arg = rawArg.trim();

  if (!arg) {
    return rejected(options.emptyArgHint);
  }

  // Сам стример не может зафолловить собственный канал, поэтому проверка
  // фолловера для него всегда провалится — пропускаем её для broadcaster'а.
  if (options.requireFollower && !requester.isBroadcaster) {
    const eligibility = await checkFollowerEligibility(
      {
        broadcasterId: cfg.twitchBroadcasterId,
        userId: requester.userId,
        clientId: cfg.twitchClientId,
        getAccessToken: cfg.getTwitchAccessToken,
      },
      cfg.minFollowerDays,
      fetchImpl,
    );
    if (!eligibility.isEligible) {
      return rejected(`заказывать музыку могут фолловеры канала от ${cfg.minFollowerDays} дн.`);
    }
  }

  const parsed = parseRequestLink(arg);

  if (parsed.type === 'youtube') {
    if (!cfg.youtubeApiKey) {
      return rejected('заказ по ссылке на YouTube сейчас недоступен');
    }
    return handleYoutubeRequest(parsed.videoId, requester, mention, cfg.youtubeApiKey, cfg, fetchImpl);
  }

  if (parsed.type === 'spotify') {
    if (!cfg.spotify) {
      return rejected('заказ по ссылке на Spotify сейчас недоступен');
    }
    return handleSpotifyRequest(parsed.trackId, requester, mention, cfg.spotify, fetchImpl);
  }

  if (parsed.type === 'yandex') {
    if (!cfg.yandex) {
      return rejected('заказ по ссылке на Яндекс Музыку сейчас недоступен');
    }
    return handleYandexRequest(parsed.trackId, requester, mention, cfg.yandex.token, fetchImpl);
  }

  // parsed.type === 'invalid' — это необязательно ошибка: если Spotify
  // настроен, это может быть текстовый запрос ("название трека" или
  // "исполнитель - название") вместо ссылки — заказываем первый результат
  // поиска в Spotify (см. spotifySearch.ts), прежде чем окончательно отказать.
  if (cfg.spotify) {
    const matched = await searchSpotifyTrackByText(arg, cfg.spotify.clientId, cfg.spotify.clientSecret, fetchImpl);
    if (matched) {
      return enqueueSpotifyTrack(matched, requester, mention);
    }
  }

  return rejected(
    `ссылка невалидная — принимаются ссылки на ${describeLinkSources(cfg, 'и')}` +
      (cfg.spotify ? ', либо название трека для поиска в Spotify' : ''),
  );
}

async function handleYoutubeRequest(
  videoId: string,
  requester: SongRequester,
  mention: string,
  apiKey: string,
  cfg: RequestHandlerConfig,
  fetchImpl: typeof fetch,
): Promise<SongRequestOutcome> {
  const details = await fetchYoutubeVideoDetails(videoId, apiKey, fetchImpl);
  if (!details) {
    return { queued: false, replyText: `${mention} ссылка невалидная — видео не найдено` };
  }
  if (details.durationSec > cfg.maxYoutubeDurationSec) {
    return {
      queued: false,
      replyText: `${mention} ссылка невалидная — видео длиннее ${Math.round(cfg.maxYoutubeDurationSec / 60)} мин.`,
    };
  }

  const { id: requestId, position } = enqueueSongRequest({
    provider: 'youtube',
    externalId: videoId,
    playUri: `https://www.youtube.com/watch?v=${videoId}`,
    title: details.title,
    author: details.channelTitle,
    durationSec: details.durationSec,
    requestedById: requester.userId,
    requestedByLogin: requester.login,
    redemptionId: requester.redemption?.redemptionId ?? null,
    rewardId: requester.redemption?.rewardId ?? null,
  });

  eventBus.emit('song.queued', { title: details.title, provider: 'youtube', position });
  return {
    queued: true,
    requestId,
    replyText: `${mention} трек добавлен в очередь: "${formatTrackTitle('youtube', details.title, details.channelTitle)}" (позиция ${position})`,
  };
}

async function handleSpotifyRequest(
  trackId: string,
  requester: SongRequester,
  mention: string,
  spotifyCfg: SpotifyRequestConfig,
  fetchImpl: typeof fetch,
): Promise<SongRequestOutcome> {
  const details = await fetchSpotifyTrackDetails(trackId, spotifyCfg.clientId, spotifyCfg.clientSecret, fetchImpl);
  if (!details) {
    return { queued: false, replyText: `${mention} ссылка невалидная — трек не найден` };
  }
  return enqueueSpotifyTrack(details, requester, mention);
}

/** Общий "хвост" постановки в очередь для заказа по ссылке и по текстовому поиску (#6). */
function enqueueSpotifyTrack(details: SpotifyTrackDetails, requester: SongRequester, mention: string): SongRequestOutcome {
  const { id: requestId, position } = enqueueSongRequest({
    provider: 'spotify',
    externalId: details.trackId,
    playUri: details.uri,
    title: details.title,
    author: details.artist,
    durationSec: Math.round(details.durationMs / 1000),
    requestedById: requester.userId,
    requestedByLogin: requester.login,
    redemptionId: requester.redemption?.redemptionId ?? null,
    rewardId: requester.redemption?.rewardId ?? null,
  });

  eventBus.emit('song.queued', { title: details.title, provider: 'spotify', position });
  // В отличие от YouTube, у Spotify-трека почти всегда есть чёткое поле
  // "исполнитель" — показываем его в чате вместе с названием, иначе не
  // всегда понятно, о каком именно треке речь (мало ли каверов/ремиксов).
  return {
    queued: true,
    requestId,
    replyText: `${mention} трек добавлен в очередь: "${formatTrackTitle('spotify', details.title, details.artist)}" (позиция ${position})`,
  };
}

async function handleYandexRequest(
  trackId: string,
  requester: SongRequester,
  mention: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SongRequestOutcome> {
  const details = await fetchYandexTrackDetails(trackId, token, fetchImpl);
  if (!details) {
    return { queued: false, replyText: `${mention} ссылка невалидная — трек не найден` };
  }
  // Проверяем сразу, а не при воспроизведении: иначе зритель получит
  // "трек добавлен", а когда до него дойдёт очередь, заказ молча пропустится.
  if (!details.available || !(await fetchYandexFullDownloadInfo(trackId, token, fetchImpl))) {
    return { queued: false, replyText: `${mention} этот трек Яндекс Музыки недоступен для прослушивания` };
  }

  const { id: requestId, position } = enqueueSongRequest({
    provider: 'yandex',
    externalId: details.trackId,
    playUri: yandexPlayUri(details.trackId),
    title: details.title,
    author: details.artist,
    durationSec: details.durationSec,
    requestedById: requester.userId,
    requestedByLogin: requester.login,
    redemptionId: requester.redemption?.redemptionId ?? null,
    rewardId: requester.redemption?.rewardId ?? null,
  });

  eventBus.emit('song.queued', { title: details.title, provider: 'yandex', position });
  return {
    queued: true,
    requestId,
    replyText: `${mention} трек добавлен в очередь: "${formatTrackTitle('yandex', details.title, details.artist)}" (позиция ${position})`,
  };
}
