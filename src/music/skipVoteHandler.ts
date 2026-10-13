import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { SkipVoteTracker } from './skipVoteTracker.ts';
import type { ChatMessageEvent, SongNowPlayingEvent } from '../core/events.ts';

export interface SkipVoteHandlerConfig {
  /** Например "!skip". Сравнение регистронезависимое. */
  commandName: string;
  thresholdPercent: number;
  /** Текущее число зрителей стрима; null — стрим оффлайн. */
  getViewerCount: () => Promise<number | null>;
}

/** Минимальный контракт оркестратора, который нужен обработчику скипа. */
export interface SkipableOrchestrator {
  getMode(): 'default' | 'request';
  skip(): boolean;
  skipDefaultPlaylist(): boolean;
}

function reply(text: string): void {
  eventBus.emit('chat.reply', { text });
}

/**
 * Подписывает голосование за скип текущего трека на чат Twitch — как заказа,
 * так и трека дефолтного плейлиста (когда очередь заказов пуста).
 *
 * Условие (по требованию): трек скипается сразу, без порога, если команду
 * !skip введёт либо сам стример или модератор канала (по правам на скип
 * модератор равен стримеру; это скорее для YouTube-заказов, которые иначе не
 * переключить), либо (только для
 * заказов) тот же зритель, который этот трек и заказал (это его собственный
 * заказ — разумно, что он может передумать без голосования; у треков
 * дефолтного плейлиста заказчика нет, эта льгота на них не распространяется).
 * Для всех остальных — обычное голосование: наберётся достаточно голосов —
 * 30% (настраивается) от числа зрителей стрима (viewer_count из Twitch Get
 * Streams). Число зрителей запрашивается один раз на трек — при первом
 * голосе — и порог дальше не меняется. Если стрим оффлайн, нужен 1 голос.
 *
 * Голоса за конкретный трек (и то, кто его заказал, если заказал) сбрасываются/
 * обновляются при старте следующего трека (событие song.now_playing, которое
 * оркестратор эмитит для каждого трека — и заказа, и дефолтного плейлиста).
 */
export interface SkipVoteHandlerHandle {
  tracker: SkipVoteTracker;
  /** Отписывает обработчик от eventBus — используется в тестах для изоляции между тестами. */
  unregister: () => void;
}

export function registerSkipVoteHandler(
  orchestrator: SkipableOrchestrator,
  cfg: SkipVoteHandlerConfig,
): SkipVoteHandlerHandle {
  const tracker = new SkipVoteTracker({ thresholdPercent: cfg.thresholdPercent });
  let currentRequesterId: string | null = null;
  // Растёт при каждой смене трека — чтобы ответ Twitch, пришедший уже после
  // смены, не зафиксировал порог (и не засчитал голос) для нового трека.
  let trackGeneration = 0;
  // Общий запрос числа зрителей, чтобы несколько !skip подряд не дёргали Twitch каждый.
  let pendingViewerCount: Promise<number | null> | null = null;

  const onNowPlaying = (payload: SongNowPlayingEvent): void => {
    tracker.resetVotes();
    currentRequesterId = payload.requestedById;
    trackGeneration += 1;
    pendingViewerCount = null;
  };

  /** Фиксирует порог текущего трека, если ещё не зафиксирован. false — трек сменился или Twitch не ответил. */
  const ensureThreshold = async (): Promise<boolean> => {
    if (tracker.requiredVotes() !== null) return true;
    const generation = trackGeneration;
    pendingViewerCount ??= cfg.getViewerCount();
    const request = pendingViewerCount;
    let viewers: number | null;
    try {
      viewers = await request;
    } catch (err) {
      if (pendingViewerCount === request) pendingViewerCount = null; // следующий !skip попробует снова
      logger.error('skip', 'Не удалось получить число зрителей стрима', err);
      return false;
    }
    if (generation !== trackGeneration) return false;
    if (viewers === null) logger.info('skip', 'Стрим оффлайн — для скипа достаточно 1 голоса');
    tracker.lockThreshold(viewers ?? 0);
    return true;
  };

  const doSkip = (): boolean =>
    orchestrator.getMode() === 'request' ? orchestrator.skip() : orchestrator.skipDefaultPlaylist();

  const onChatMessage = async (msg: ChatMessageEvent): Promise<void> => {
    const [cmd] = msg.text.trim().split(/\s+/);
    if (!cmd || cmd.toLowerCase() !== cfg.commandName.toLowerCase()) return;

    const isRequestMode = orchestrator.getMode() === 'request';

    if (msg.isBroadcaster || msg.isModerator) {
      if (doSkip()) {
        reply(msg.isBroadcaster ? 'Трек скипнут по команде стримера' : 'Трек скипнут по команде модератора');
      } else {
        reply(`@${msg.displayName} сейчас нечего скипать`);
      }
      return;
    }

    if (isRequestMode && currentRequesterId !== null && msg.userId === currentRequesterId) {
      if (orchestrator.skip()) {
        reply(`@${msg.displayName} трек скипнут — это был твой заказ`);
      }
      return;
    }

    const generation = trackGeneration;
    if (!(await ensureThreshold())) {
      if (generation === trackGeneration) {
        reply(`@${msg.displayName} не удалось узнать число зрителей, попробуй ${cfg.commandName} ещё раз чуть позже`);
      }
      return;
    }

    const result = tracker.vote(msg.userId);
    if (result === 'closed') return;
    // Снимок до doSkip: смена трека сбросит голоса и порог.
    const tally = `${tracker.voteCount}/${tracker.requiredVotes()}`;
    if (result === 'passed') {
      if (doSkip()) {
        reply(`Трек скипнут голосованием (${tally})`);
      } else {
        reply(`@${msg.displayName} сейчас нечего скипать`);
      }
    } else {
      reply(`@${msg.displayName} голос за скип принят (${tally})`);
    }
  };

  eventBus.on('song.now_playing', onNowPlaying);
  const onChatMessageSafe = (msg: ChatMessageEvent): void => {
    onChatMessage(msg).catch((err: unknown) => logger.error('skip', 'Ошибка обработки !skip', err));
  };
  eventBus.on('chat.message', onChatMessageSafe);

  return {
    tracker,
    unregister: () => {
      eventBus.off('song.now_playing', onNowPlaying);
      eventBus.off('chat.message', onChatMessageSafe);
    },
  };
}
