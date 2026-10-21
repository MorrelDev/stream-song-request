import { logger } from '../core/logger.ts';
import type { PlaybackSession } from './youtubePlayer.ts';

/** Минимум от Spotify-контроллера, нужный плееру (см. SpotifyPlaybackController). */
export interface SpotifyPlayerApi {
  getCurrentPlayback(): Promise<{
    isPlaying: boolean;
    progressMs: number;
    durationMs: number;
    trackUri: string | null;
    trackTitle?: string | null;
    trackArtist?: string | null;
  } | null>;
  playTrackUri(uri: string): Promise<void>;
  skipToNext(): Promise<void>;
  /** Только для лога: что на самом деле играет и что в очереди (см. SpotifyPlaybackController.diagnosePlayback). */
  diagnosePlayback?(expectedUri: string): Promise<string>;
}

export interface SpotifyTrackPlayerOptions {
  /** Как часто опрашивать Spotify, пока трек играет, мс (SPOTIFY_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  /** Как часто опрашивать, пока ждём, что трек начал играть, мс (по умолчанию 1 с, но не реже pollIntervalMs). */
  startPollIntervalMs?: number;
  /**
   * Трек уже стоит в очереди Spotify (его поставил туда prepareNext прошлого
   * трека). Тогда он не запускается заново: Spotify переключается на него сам,
   * а если прошлый трек скипнули — хватает одного "следующий".
   */
  queued?: boolean;
  /**
   * Вызывается один раз, когда до конца трека остаётся PREPARE_NEXT_LEAD_MS.
   * true — следующий трек поставлен в очередь Spotify: плеер не отдаёт
   * управление раньше конца, а ждёт, пока Spotify переключится сам.
   * false — следующий трек не из Spotify (или его нет): управление отдаётся
   * за HANDOFF_EARLY_MS до конца, чтобы оркестратор успел поставить паузу.
   */
  prepareNext?: () => Promise<boolean>;
  /**
   * Название и исполнитель трека. Spotify бывает играет ту же песню под
   * другим id — например, версию с альбома вместо запрошенной с сингла, и
   * API об этом никак не сообщает (linked_from пуст). По названию и
   * исполнителю плеер узнаёт такую подмену и не скипает "чужой" трек.
   */
  expected?: { title: string; artist: string };
}

/**
 * Название без уточнений версии: "(Remastered 2011)", "[Live]",
 * " - Single Version" и т.п. — у разных релизов одной песни они различаются.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstArtist(artist: string): string {
  return artist.split(',')[0].trim().toLowerCase();
}

/** Та же песня, что и expected, — пусть и под другим id. */
export function isSameSong(
  playing: { trackTitle?: string | null; trackArtist?: string | null },
  expected: { title: string; artist: string },
): boolean {
  if (!playing.trackTitle || !playing.trackArtist) return false;
  return (
    normalizeTitle(playing.trackTitle) === normalizeTitle(expected.title) &&
    firstArtist(playing.trackArtist) === firstArtist(expected.artist)
  );
}

/** Сколько опросов подряд ждать, пока трек начнёт играть, прежде чем сдаться. */
const MAX_START_POLLS = 12;
/** Через сколько опросов "ничего не играет" повторить команду запуска. */
const RESEND_AFTER_POLLS = 4;
/** Сколько раз можно нажать "следующий", если заиграл чужой трек из очереди Spotify. */
const MAX_EXTRA_SKIPS = 3;
/** Сколько сетевых сбоев подряд терпеть. */
const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * За сколько до конца трека звать prepareNext. С запасом: постановка в
 * очередь — это сетевой запрос, и он должен успеть задолго до конца трека.
 */
const PREPARE_NEXT_LEAD_MS = 15_000;
/**
 * Когда до конца трека остаётся меньше этого — перестаём опрашивать и просто
 * дожидаемся конца по часам (если следующий трек не стоит в очереди Spotify).
 */
const END_LEAD_MS = 2000;
/**
 * На сколько раньше конца трека отдавать управление, если следующий трек не
 * в очереди Spotify. После этого оркестратор ставит Spotify на паузу, а это
 * сетевой запрос: если он опоздает, Spotify успеет включить своё
 * автовоспроизведение. Лучше обрезать последнюю секунду трека.
 */
const HANDOFF_EARLY_MS = 1000;
/** Как часто опрашивать около конца трека, пока ждём, что Spotify сам переключится на следующий. */
const NEAR_END_POLL_MS = 500;
/**
 * Сколько ждать, что Spotify сам переключится на трек из очереди: и в конце
 * прошлого трека (после его расчётного конца), и при старте заранее
 * поставленного трека. Дольше — считаем, что само не переключится.
 */
const QUEUED_SWITCH_GRACE_MS = 3000;
/** Трек на паузе ближе этого к концу (или на нуле) — считаем, что он закончился. */
const ENDED_NEAR_END_MS = 2500;

/**
 * Играет один трек через Spotify и сообщает (session.finished), когда он
 * закончился. У Spotify Web API нет событий "трек закончился", поэтому
 * состояние опрашивается. Правила:
 *
 *  1. Запуск. playTrackUri() и ждём, пока Spotify отчитается, что играет
 *     именно наш трек. Если играет чужой (застрял в очереди Spotify) —
 *     жмём "следующий", пока не дойдём до нашего. Если ничего не играет —
 *     через несколько опросов повторяем запуск. Не заиграл совсем — ошибка.
 *     Если трек заранее поставлен в очередь (options.queued) — playTrackUri
 *     не нужен: ждём, пока Spotify переключится сам, иначе жмём "следующий".
 *  2. Трек играет. Конец — это когда Spotify переключился на другой трек или
 *     остановился в самом конце. Ручная пауза посреди трека концом не
 *     считается — ждём дальше. Единичный сетевой сбой — тоже.
 *  3. За PREPARE_NEXT_LEAD_MS до конца — prepareNext(). Если следующий трек
 *     встал в очередь Spotify, ждём, пока Spotify на него переключится (это
 *     и есть бесшовный переход). Если нет — за END_LEAD_MS до конца ждём по
 *     часам и отдаём управление за HANDOFF_EARLY_MS до конца.
 *
 * stop() (скип) просто прекращает ожидание — что играть дальше (или
 * поставить Spotify на паузу), решает оркестратор.
 */
export function playSpotifyTrack(
  spotify: SpotifyPlayerApi,
  uri: string,
  options: SpotifyTrackPlayerOptions,
): PlaybackSession {
  let stopped = false;
  let wake: (() => void) | undefined;
  /** id, под которым Spotify на самом деле играет трек (см. options.expected). */
  let playingUri = uri;

  /**
   * Играет ли наш трек (пока ждём старта). Если это та же песня под другим
   * id — запоминаем этот id: дальше конец трека отслеживается по нему.
   */
  const isOurs = (pb: { trackUri: string | null; trackTitle?: string | null; trackArtist?: string | null }): boolean => {
    if (pb.trackUri === uri || pb.trackUri === playingUri) return true;
    if (!pb.trackUri || !options.expected || !isSameSong(pb, options.expected)) return false;
    logger.info(
      'playback',
      `Spotify играет "${options.expected.title}" под другим id (${pb.trackUri} вместо ${uri}) — это тот же трек`,
    );
    playingUri = pb.trackUri;
    return true;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  /**
   * Состояние плеера и сколько длился запрос: progressMs Spotify измерил
   * где-то во время запроса, так что к моменту ответа трек уже продвинулся.
   */
  const poll = async (): Promise<{
    pb: Awaited<ReturnType<SpotifyPlayerApi['getCurrentPlayback']>> | 'error';
    latencyMs: number;
  }> => {
    const startedAt = Date.now();
    try {
      const pb = await spotify.getCurrentPlayback();
      return { pb, latencyMs: Date.now() - startedAt };
    } catch (err) {
      logger.error('playback', 'Не удалось опросить Spotify (временный сбой?)', err);
      return { pb: 'error', latencyMs: 0 };
    }
  };

  /** Подробности для лога, когда играет не тот трек. Сбой диагностики не мешает воспроизведению. */
  const diagnose = async (): Promise<string> => {
    if (!spotify.diagnosePlayback) return '';
    try {
      return ` [диагностика: ${await spotify.diagnosePlayback(uri)}]`;
    } catch (err) {
      return ` [диагностика не удалась: ${String(err)}]`;
    }
  };

  /**
   * Старт заранее поставленного трека. true — Spotify уже играет его.
   * false — дальше обычное ожидание старта; если Spotify сам не переключился
   * (прошлый трек скипнули или остановили !pr посреди) — нажат "следующий".
   */
  const startQueued = async (): Promise<boolean> => {
    const deadline = Date.now() + QUEUED_SWITCH_GRACE_MS;
    for (;;) {
      const { pb } = await poll();
      if (stopped) return false;
      if (pb !== 'error' && pb && isOurs(pb)) {
        // Наш трек, но на паузе — "следующий" его бы пропустил; разберётся обычное ожидание старта.
        return pb.isPlaying;
      }
      // Прошлый трек ещё посреди (скип, !pr) — сам Spotify до нашего не дойдёт.
      // В самом конце трека (или без ответа) — даём Spotify время переключиться самому.
      const midTrack = pb !== 'error' && pb !== null && pb.durationMs - pb.progressMs > ENDED_NEAR_END_MS;
      if (midTrack || Date.now() >= deadline) break;
      await sleep(NEAR_END_POLL_MS);
    }
    logger.warn('playback', `Spotify сам не переключился на трек из очереди ${uri} — жму "следующий"${await diagnose()}`);
    await spotify.skipToNext();
    return false;
  };

  /** Spotify подтвердил, что играет именно наш трек (см. PlaybackSession.audioStarted). */
  let resolveAudioStarted!: () => void;
  const audioStarted = new Promise<void>((resolve) => (resolveAudioStarted = resolve));

  const finished = (async () => {
    // --- 1. Ждём, пока заиграет именно наш трек ---
    let started = false;
    if (options.queued) {
      started = await startQueued();
    } else {
      await spotify.playTrackUri(uri);
    }
    if (stopped) return;

    const startPollMs = options.startPollIntervalMs ?? Math.min(1000, options.pollIntervalMs);
    let errors = 0;
    let idlePolls = 0;
    let foreignPolls = 0;
    let extraSkips = 0;
    for (let attempt = 0; attempt < MAX_START_POLLS && !stopped && !started; attempt++) {
      await sleep(startPollMs);
      if (stopped) return;
      const { pb } = await poll();
      if (pb === 'error') {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) throw new Error('Spotify не отвечает — не удалось запустить трек');
        continue;
      }
      errors = 0;
      if (pb && isOurs(pb) && pb.isPlaying) {
        started = true;
        break;
      }
      if (pb && pb.trackUri && !isOurs(pb) && pb.isPlaying) {
        // Играет чужой трек. Даём Spotify один опрос "на переключение", потом
        // жмём "следующий": наш трек стоит в очереди Spotify где-то дальше.
        if (++foreignPolls >= 2 && extraSkips < MAX_EXTRA_SKIPS) {
          extraSkips++;
          foreignPolls = 0;
          logger.warn(
            'playback',
            `Spotify играет не тот трек (${pb.trackUri}) — переключаю на следующий в очереди${await diagnose()}`,
          );
          await spotify.skipToNext();
        }
        continue;
      }
      // Ничего не играет (или наш трек, но на паузе) — через несколько опросов повторяем запуск.
      if (++idlePolls === RESEND_AFTER_POLLS) {
        logger.warn('playback', `Spotify не начал играть ${uri} — повторяю запуск`);
        await spotify.playTrackUri(uri);
      }
    }
    if (stopped) return;
    if (!started) throw new Error(`Spotify так и не начал играть трек ${uri}${await diagnose()}`);
    resolveAudioStarted();

    // --- 2. Трек играет — ждём конца ---
    errors = 0;
    let prepared = !options.prepareNext;
    let nextQueued = false;
    let waitMs = 0;
    for (;;) {
      await sleep(waitMs);
      if (stopped) return;
      const { pb, latencyMs } = await poll();
      if (pb === 'error') {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error('Spotify перестал отвечать посреди трека — перехожу к следующему');
        }
        waitMs = options.pollIntervalMs;
        continue;
      }
      errors = 0;

      // Spotify ушёл на другой трек или устройство пропало — наш закончился (или его переключили вручную).
      if (!pb || pb.trackUri !== playingUri) return;

      const remaining = pb.durationMs - pb.progressMs - latencyMs;
      if (!pb.isPlaying) {
        if (pb.progressMs === 0 || remaining <= ENDED_NEAR_END_MS) return;
        // Пауза посреди трека (например, стример нажал паузу в Spotify) — ждём.
        waitMs = options.pollIntervalMs;
        continue;
      }

      if (!prepared && remaining <= PREPARE_NEXT_LEAD_MS) {
        prepared = true;
        nextQueued = await options.prepareNext!();
        if (stopped) return;
        waitMs = 0; // постановка в очередь заняла время — сразу уточняем, сколько осталось
        continue;
      }

      if (nextQueued) {
        // --- 3а. Следующий трек в очереди Spotify — он переключится сам ---
        // Страховка: трек давно должен был кончиться, а Spotify всё "играет" его.
        if (remaining <= -QUEUED_SWITCH_GRACE_MS) return;
        waitMs = remaining > END_LEAD_MS ? Math.min(options.pollIntervalMs, remaining - END_LEAD_MS) : NEAR_END_POLL_MS;
        continue;
      }

      if (remaining <= END_LEAD_MS) {
        // --- 3б. Доигрываем хвост по часам ---
        await sleep(Math.max(remaining - HANDOFF_EARLY_MS, 0));
        return;
      }
      waitMs = Math.min(
        options.pollIntervalMs,
        remaining - END_LEAD_MS,
        prepared ? Infinity : remaining - PREPARE_NEXT_LEAD_MS,
      );
    }
  })();

  return {
    finished,
    stop: () => {
      stopped = true;
      wake?.();
    },
    audioStarted,
  };
}
