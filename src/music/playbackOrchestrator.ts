import { eventBus } from '../core/eventBus.ts';
import { logger } from '../core/logger.ts';
import { isRequestsPaused } from './requestsGate.ts';
import { playSpotifyTrack, type SpotifyPlayerApi } from './spotifyTrackPlayer.ts';
import type { QueuedSongRequest } from '../db/musicQueue.ts';
import type { DefaultTrack, NewDefaultTrack } from '../db/defaultTracks.ts';
import type { SongProvider } from '../core/events.ts';

/** Что оркестратору нужно от Spotify: запуск/опрос трека (плеер), очередь и пауза. */
export interface SpotifyPlaybackLike extends SpotifyPlayerApi {
  queueTrack(uri: string): Promise<void>;
  pause(): Promise<void>;
}

/** Плеер mpv: YouTube-ссылки и yandex:track:<id> (см. index.ts). */
export interface YoutubePlayerLike {
  play(url: string): { finished: Promise<void>; stop: () => void };
  /**
   * Подсказка: этот трек, скорее всего, заиграет следующим — можно заранее
   * подготовиться (см. preloadYoutubeInfo). Если следующим заиграет другое,
   * play() просто не воспользуется заготовкой.
   */
  prepare?(url: string): void;
}

/** Очередь заказов (db/musicQueue.ts). */
export interface QueueLike {
  peekNextPending(): QueuedSongRequest | undefined;
  markPlaying(id: number): void;
  markDone(id: number): void;
}

/** Таблица треков дефолтного плейлиста (db/defaultTracks.ts). */
export interface DefaultTracksLike {
  /** Первый трек таблицы; excludeId — пропустить этот трек (тот, что играет сейчас). */
  peekNext(excludeId?: number): DefaultTrack | undefined;
  remove(id: number): void;
  replaceAll(tracks: NewDefaultTrack[]): void;
}

/** Загружает все треки дефолтного плейлиста (Spotify или Яндекс). */
export type DefaultPlaylistLoader = () => Promise<NewDefaultTrack[]>;

export interface OrchestratorConfig {
  /** Как часто опрашивать Spotify, пока играет его трек, и как долго "спать", когда играть нечего, мс. */
  pollIntervalMs: number;
  /** Перемешивать ли дефолтный плейлист при каждой загрузке в таблицу. */
  shuffleDefaultPlaylist: boolean;
  /** Не чаще какого интервала пытаться заново загрузить плейлист после неудачи, мс. */
  reimportRetryMs?: number;
}

/** Трек, который сейчас играет — для команды "текущий трек" в чате (см. currentTrackHandler.ts). */
export interface CurrentTrackInfo {
  provider: SongProvider;
  title: string;
  author: string;
}

type Item = { kind: 'request'; track: QueuedSongRequest } | { kind: 'default'; track: DefaultTrack };

export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const DEFAULT_REIMPORT_RETRY_MS = 60_000;
/** За сколько до конца mpv-трека готовить следующий — как PREPARE_NEXT_LEAD_MS у Spotify. */
const MPV_PREPARE_NEXT_LEAD_MS = 15_000;

/**
 * Воспроизведение музыки: две очереди в базе и один цикл.
 *
 *  - song_requests — заказы зрителей (db/musicQueue.ts);
 *  - default_tracks — треки дефолтного плейлиста (db/defaultTracks.ts),
 *    загружаются целиком при старте и заново, когда закончились.
 *
 * Цикл: есть заказ — играть заказ; нет — играть первый трек из
 * default_tracks; трек доиграл — заказ помечается сыгранным, дефолтный трек
 * удаляется из таблицы. Текущий трек ничем не прерывается (кроме скипа), так
 * что заказ, пришедший во время дефолтного трека, играет сразу после него.
 *
 * Пока заказы на паузе (!pr), дефолтные треки не играют; уже принятые заказы
 * доигрываются.
 *
 * Треки Spotify играет Spotify (через Spotify Connect, см.
 * spotifyTrackPlayer.ts), остальные — mpv. Перед треком mpv и когда играть
 * нечего Spotify ставится на паузу, иначе он продолжил бы играть что-то своё.
 *
 * Spotify → Spotify: незадолго до конца Spotify-трека следующий трек, если он
 * тоже из Spotify, заранее ставится в очередь Spotify (queueNextSpotifyTrack),
 * и Spotify переключается на него сам — без паузы и без чужого трека между
 * ними. Выбор следующего трека при этом фиксируется: заказ, пришедший после
 * этого, сыграет через один трек (удалить трек из очереди Spotify нельзя).
 */
export class PlaybackOrchestrator {
  private readonly spotify: SpotifyPlaybackLike | null;
  private readonly mpv: YoutubePlayerLike;
  private readonly requests: QueueLike;
  private readonly defaults: DefaultTracksLike;
  private readonly loadDefaultPlaylist: DefaultPlaylistLoader | null;
  private readonly cfg: OrchestratorConfig;

  private stopped = false;
  private running: Promise<void> | undefined;
  private current: { item: Item; stop?: () => void } | null = null;
  /** Следующий трек, уже поставленный в очередь Spotify: играет следующим, что бы ни пришло после. */
  private queuedNext: Item | null = null;
  /** true — текущий дефолтный трек остановлен командой !pr: из таблицы его не удаляем. */
  private haltRequested = false;
  /** Spotify мог что-то играть: был наш трек или его запустили до старта приложения. */
  private spotifyMayBePlaying: boolean;
  private lastImportFailedAt: number | null = null;
  private wakeIdle: (() => void) | undefined;
  private readonly onSongQueued = (): void => this.wake();

  constructor(
    spotify: SpotifyPlaybackLike | null,
    mpv: YoutubePlayerLike,
    requests: QueueLike,
    defaults: DefaultTracksLike,
    loadDefaultPlaylist: DefaultPlaylistLoader | null,
    cfg: OrchestratorConfig,
  ) {
    this.spotify = spotify;
    this.mpv = mpv;
    this.requests = requests;
    this.defaults = defaults;
    this.loadDefaultPlaylist = loadDefaultPlaylist;
    this.cfg = cfg;
    this.spotifyMayBePlaying = spotify !== null;
  }

  /** Запускает цикл. Промис резолвится, когда цикл остановлен через stop() (нужно тестам). */
  start(): Promise<void> {
    eventBus.on('song.queued', this.onSongQueued);
    this.running = this.run();
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    eventBus.off('song.queued', this.onSongQueued);
    this.current?.stop?.();
    this.wake();
  }

  /** Разбудить цикл, если он ждёт (например, после снятия паузы !rr). */
  async tick(): Promise<void> {
    this.wake();
  }

  getMode(): 'default' | 'request' {
    return this.current?.item.kind === 'request' ? 'request' : 'default';
  }

  async getCurrentTrack(): Promise<CurrentTrackInfo | null> {
    const track = this.current?.item.track;
    return track ? { provider: track.provider, title: track.title, author: track.author } : null;
  }

  /** Скип текущего заказа. false — сейчас играет не заказ. */
  skip(): boolean {
    if (this.current?.item.kind !== 'request' || !this.current.stop) return false;
    this.current.stop();
    return true;
  }

  /** Скип текущего трека дефолтного плейлиста (он удаляется из таблицы, как проигранный). */
  skipDefaultPlaylist(): boolean {
    if (this.current?.item.kind !== 'default' || !this.current.stop) return false;
    this.current.stop();
    return true;
  }

  /**
   * Команда !pr: останавливает текущий дефолтный трек (заказ доигрывается).
   * Трек остаётся в таблице и после !rr начнётся заново.
   */
  async haltDefaultPlaylist(): Promise<void> {
    if (this.current?.item.kind !== 'default' || !this.current.stop) return;
    this.haltRequested = true;
    this.current.stop();
  }

  private wake(): void {
    this.wakeIdle?.();
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const timer = setTimeout(done, ms);
      const self = this;
      function done(): void {
        clearTimeout(timer);
        if (self.wakeIdle === done) self.wakeIdle = undefined;
        resolve();
      }
      this.wakeIdle = done;
    });
  }

  private async run(): Promise<void> {
    // Треки прошлого запуска не нужны: плейлист могли сменить или убрать из
    // .env. Очищаем сразу, а не только при успешной загрузке — иначе при
    // сбое загрузки доигрывался бы старый плейлист.
    this.defaults.replaceAll([]);
    if (this.loadDefaultPlaylist) await this.importDefaultPlaylist();

    while (!this.stopped) {
      const item = this.pickNext();
      if (item) {
        const ok = await this.play(item);
        // Сбой воспроизведения (нет сети, протух токен и т.п.) — небольшая
        // пауза, чтобы не пролистать всю таблицу за секунды.
        if (!ok) await this.idle(this.cfg.pollIntervalMs);
        continue;
      }

      await this.silenceSpotify();
      if (!isRequestsPaused() && this.shouldReimport()) {
        await this.importDefaultPlaylist();
        continue;
      }
      await this.idle(this.cfg.pollIntervalMs);
    }
  }

  private pickNext(): Item | null {
    // Трек из очереди Spotify — первым; дефолтный на паузе (!pr) ждёт её снятия.
    const queued = this.queuedNext;
    if (queued && (queued.kind === 'request' || !isRequestsPaused())) return queued;
    return this.peekNext();
  }

  /** Что играть следующим по правилам очередей. excludeDefaultId — дефолтный трек, который играет сейчас. */
  private peekNext(excludeDefaultId?: number): Item | null {
    const request = this.requests.peekNextPending();
    if (request) return { kind: 'request', track: request };
    if (isRequestsPaused()) return null;
    const def = this.defaults.peekNext(excludeDefaultId);
    return def ? { kind: 'default', track: def } : null;
  }

  /**
   * Вызывается плеером Spotify незадолго до конца текущего трека (prepareNext).
   * Если следующий трек тоже из Spotify — ставит его в очередь Spotify и
   * закрепляет за ним следующую очередь в pickNext. true — поставлен.
   */
  private async queueNextSpotifyTrack(current: Item): Promise<boolean> {
    // Уже есть закреплённый трек (например, дефолтный, ждущий снятия !pr) — второй не ставим.
    if (!this.spotify || this.stopped || this.queuedNext) return false;
    const next = this.peekNext(current.kind === 'default' ? current.track.id : undefined);
    if (!next) return false;
    if (next.track.provider !== 'spotify') {
      this.mpv.prepare?.(next.track.playUri);
      return false;
    }
    try {
      await this.spotify.queueTrack(next.track.playUri);
    } catch (err) {
      logger.error('playback', `Не удалось заранее поставить "${next.track.title}" в очередь Spotify`, err);
      return false;
    }
    this.queuedNext = next;
    logger.info('playback', `Следующий трек заранее поставлен в очередь Spotify: "${next.track.title}"`);
    return true;
  }

  /** Незадолго до конца mpv-трека: если следующий трек тоже играет mpv — подготовить его. */
  private prepareNextMpvTrack(current: Item): void {
    if (this.stopped || this.queuedNext) return;
    const next = this.peekNext(current.kind === 'default' ? current.track.id : undefined);
    if (next && next.track.provider !== 'spotify') this.mpv.prepare?.(next.track.playUri);
  }

  private shouldReimport(): boolean {
    if (!this.loadDefaultPlaylist) return false;
    const retryMs = this.cfg.reimportRetryMs ?? DEFAULT_REIMPORT_RETRY_MS;
    return this.lastImportFailedAt === null || Date.now() - this.lastImportFailedAt >= retryMs;
  }

  private async importDefaultPlaylist(): Promise<void> {
    try {
      const tracks = await this.loadDefaultPlaylist!();
      if (tracks.length === 0) throw new Error('в плейлисте нет доступных треков');
      this.defaults.replaceAll(this.cfg.shuffleDefaultPlaylist ? shuffled(tracks) : tracks);
      this.lastImportFailedAt = null;
      logger.info('playback', `Дефолтный плейлист загружен в базу: ${tracks.length} треков`);
    } catch (err) {
      this.lastImportFailedAt = Date.now();
      const retrySec = Math.round((this.cfg.reimportRetryMs ?? DEFAULT_REIMPORT_RETRY_MS) / 1000);
      logger.error('playback', `Не удалось загрузить дефолтный плейлист, повторю через ${retrySec} с`, err);
    }
  }

  /** Играет один трек до конца. false — воспроизведение не удалось. */
  private async play(item: Item): Promise<boolean> {
    const { track } = item;
    const queued = item === this.queuedNext;
    if (queued) this.queuedNext = null;
    if (item.kind === 'request') this.requests.markPlaying(item.track.id);
    this.current = { item };
    eventBus.emit('song.now_playing', {
      title: track.title,
      provider: track.provider,
      requestedById: item.kind === 'request' ? item.track.requestedById : null,
    });
    logger.info(
      'playback',
      `${item.kind === 'request' ? 'Играет заказ' : 'Играет дефолтный плейлист'}: "${track.title}" (${track.provider})`,
    );

    let ok = true;
    let prepareTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let session: { finished: Promise<void>; stop: () => void };
      if (track.provider === 'spotify') {
        if (!this.spotify) throw new Error('трек Spotify, но Spotify не настроен');
        this.spotifyMayBePlaying = true;
        session = playSpotifyTrack(this.spotify, track.playUri, {
          pollIntervalMs: this.cfg.pollIntervalMs,
          queued,
          prepareNext: () => this.queueNextSpotifyTrack(item),
        });
      } else {
        await this.silenceSpotify();
        session = this.mpv.play(track.playUri);
        // У mpv нет prepareNext, как у плеера Spotify, — следующий трек
        // готовим по таймеру от заявленной длительности трека. Отсчёт идёт с
        // запуска, а звук начинается на пару секунд позже, так что на деле
        // это чуть раньше, чем за MPV_PREPARE_NEXT_LEAD_MS до конца.
        if (track.durationSec > 0) {
          const delayMs = Math.max(0, track.durationSec * 1000 - MPV_PREPARE_NEXT_LEAD_MS);
          prepareTimer = setTimeout(() => this.prepareNextMpvTrack(item), delayMs);
        }
      }
      this.current.stop = session.stop;
      // Скип/остановка могли прийти, пока запускали трек.
      if (this.stopped) session.stop();
      await session.finished;
    } catch (err) {
      ok = false;
      logger.error('playback', `Ошибка воспроизведения "${track.title}" — перехожу к следующему треку`, err);
    }
    clearTimeout(prepareTimer);

    const halted = this.haltRequested;
    this.haltRequested = false;
    this.current = null;
    if (item.kind === 'request') {
      this.requests.markDone(item.track.id);
    } else if (!halted) {
      this.defaults.remove(item.track.id);
    }
    return ok;
  }

  /** Ставит Spotify на паузу, если он мог что-то играть. */
  private async silenceSpotify(): Promise<void> {
    if (!this.spotify || !this.spotifyMayBePlaying) return;
    this.spotifyMayBePlaying = false;
    try {
      await this.spotify.pause();
    } catch (err) {
      logger.error('playback', 'Не удалось поставить Spotify на паузу', err);
    }
  }
}
