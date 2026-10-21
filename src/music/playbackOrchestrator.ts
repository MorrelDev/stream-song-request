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
  /** audioStarted — см. PlaybackSession.audioStarted в youtubePlayer.ts. */
  play(url: string): { finished: Promise<void>; stop: () => void; audioStarted?: Promise<void> };
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
  /** Дописывает треки в конец таблицы. */
  append(tracks: NewDefaultTrack[]): void;
  count(): number;
}

/** Загружает все треки дефолтного плейлиста (Spotify или Яндекс). */
export type DefaultPlaylistLoader = () => Promise<NewDefaultTrack[]>;

/**
 * Бесконечный дефолтный "плейлист" (Моя волна Яндекс Музыки, см.
 * yandexWave.ts): треки приходят порциями, а источнику важно знать, что с
 * ними стало — по этому он подбирает следующие.
 */
export interface DefaultTrackStream {
  /** Следующая порция треков. */
  nextBatch(): Promise<NewDefaultTrack[]>;
  trackStarted(track: NewDefaultTrack): void;
  /** Трек доигран (skipped=false) или скипнут; playedSec — сколько он звучал. */
  trackEnded(track: NewDefaultTrack, playedSec: number, skipped: boolean): void;
}

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

/** Трек, который сейчас играет, со всем нужным оверлею "сейчас играет" (см. overlay/nowPlayingOverlay.ts). */
export interface NowPlayingInfo extends CurrentTrackInfo {
  kind: 'request' | 'default';
  /** spotify:track:..., yandex:track:... или ссылка на YouTube — по ней оверлей находит обложку. */
  playUri: string;
  durationSec: number;
  /**
   * Когда трек начал звучать (Date.now()). Для mpv — момент, когда он открыл
   * аудиовыход, для Spotify — момент запуска (точный прогресс оверлей
   * спрашивает у самого Spotify). null — звук ещё не пошёл.
   */
  startedAt: number | null;
  /** Логин заказчика; null — трек дефолтного плейлиста. */
  requestedByLogin: string | null;
}

interface CurrentPlayback {
  item: Item;
  stop?: () => void;
  /** См. NowPlayingInfo.startedAt. */
  startedAt: number | null;
  /** Дефолтный трек скипнут (skipDefaultPlaylist) — для обратной связи DefaultTrackStream. */
  skipped?: boolean;
}

type Item ={ kind: 'request'; track: QueuedSongRequest } | { kind: 'default'; track: DefaultTrack };

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
 * DefaultTrackStream: следующая порция подгружается, когда в таблице осталось
 * столько треков, считая играющий, — чтобы до конца порции успеть и
 * загрузить следующую, и подготовить её первый трек (prepareNextMpvTrack).
 */
const STREAM_PREFETCH_AT_COUNT = 2;

/**
 * Воспроизведение музыки: две очереди в базе и один цикл.
 *
 *  - song_requests — заказы зрителей (db/musicQueue.ts);
 *  - default_tracks — треки дефолтного плейлиста (db/defaultTracks.ts),
 *    загружаются целиком при старте и заново, когда закончились. Источник
 *    без конца (DefaultTrackStream, Моя волна) дописывает их порциями, не
 *    дожидаясь, пока таблица опустеет, и не перемешивает.
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
  private readonly stream: DefaultTrackStream | null;
  private readonly cfg: OrchestratorConfig;

  private stopped = false;
  private running: Promise<void> | undefined;
  private current: CurrentPlayback | null = null;
  /** Следующий трек, уже поставленный в очередь Spotify: играет следующим, что бы ни пришло после. */
  private queuedNext: Item | null = null;
  /** true — текущий дефолтный трек остановлен командой !pr: из таблицы его не удаляем. */
  private haltRequested = false;
  /** Spotify мог что-то играть: был наш трек или его запустили до старта приложения. */
  private spotifyMayBePlaying: boolean;
  private lastImportFailedAt: number | null = null;
  /** Идущая загрузка треков: подгрузка порции волны в фоне и цикл не должны грузить одновременно. */
  private importing: Promise<void> | null = null;
  private wakeIdle: (() => void) | undefined;
  private readonly onSongQueued = (): void => this.wake();

  constructor(
    spotify: SpotifyPlaybackLike | null,
    mpv: YoutubePlayerLike,
    requests: QueueLike,
    defaults: DefaultTracksLike,
    defaultSource: DefaultPlaylistLoader | DefaultTrackStream | null,
    cfg: OrchestratorConfig,
  ) {
    this.spotify = spotify;
    this.mpv = mpv;
    this.requests = requests;
    this.defaults = defaults;
    this.loadDefaultPlaylist = typeof defaultSource === 'function' ? defaultSource : null;
    this.stream = typeof defaultSource === 'function' ? null : defaultSource;
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

  getNowPlaying(): NowPlayingInfo | null {
    if (!this.current) return null;
    const { item, startedAt } = this.current;
    const { track } = item;
    return {
      kind: item.kind,
      provider: track.provider,
      title: track.title,
      author: track.author,
      playUri: track.playUri,
      durationSec: track.durationSec,
      startedAt,
      requestedByLogin: item.kind === 'request' ? item.track.requestedByLogin : null,
    };
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
    this.current.skipped = true;
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
    if (this.hasDefaultSource()) await this.importDefaultPlaylist();

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
    logger.info('playback', `Следующий трек заранее поставлен в очередь Spotify: "${next.track.title}" (${next.track.playUri})`);
    return true;
  }

  /** Незадолго до конца mpv-трека: если следующий трек тоже играет mpv — подготовить его. */
  private prepareNextMpvTrack(current: Item): void {
    if (this.stopped || this.queuedNext) return;
    const next = this.peekNext(current.kind === 'default' ? current.track.id : undefined);
    if (next && next.track.provider !== 'spotify') this.mpv.prepare?.(next.track.playUri);
  }

  private hasDefaultSource(): boolean {
    return this.loadDefaultPlaylist !== null || this.stream !== null;
  }

  private shouldReimport(): boolean {
    if (!this.hasDefaultSource()) return false;
    const retryMs = this.cfg.reimportRetryMs ?? DEFAULT_REIMPORT_RETRY_MS;
    return this.lastImportFailedAt === null || Date.now() - this.lastImportFailedAt >= retryMs;
  }

  /** Загрузка уже идёт (подгрузка порции волны в фоне) — дождаться её, а не грузить второй раз. */
  private importDefaultPlaylist(): Promise<void> {
    this.importing ??= this.doImportDefaultPlaylist().finally(() => {
      this.importing = null;
    });
    return this.importing;
  }

  /** DefaultTrackStream: заранее подгрузить следующую порцию, пока играет конец текущей. */
  private prefetchStreamBatch(): void {
    if (!this.stream || this.importing || this.stopped) return;
    if (this.defaults.count() > STREAM_PREFETCH_AT_COUNT || !this.shouldReimport()) return;
    void this.importDefaultPlaylist();
  }

  private async doImportDefaultPlaylist(): Promise<void> {
    try {
      if (this.stream) {
        const tracks = await this.stream.nextBatch();
        if (tracks.length === 0) throw new Error('Моя волна не вернула доступных треков');
        this.defaults.append(tracks);
        logger.info('playback', `Моя волна: подгружено треков: ${tracks.length}`);
      } else {
        const tracks = await this.loadDefaultPlaylist!();
        if (tracks.length === 0) throw new Error('в плейлисте нет доступных треков');
        this.defaults.replaceAll(this.cfg.shuffleDefaultPlaylist ? shuffled(tracks) : tracks);
        logger.info('playback', `Дефолтный плейлист загружен в базу: ${tracks.length} треков`);
      }
      this.lastImportFailedAt = null;
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
    const current: CurrentPlayback = { item, startedAt: null };
    this.current = current;
    eventBus.emit('song.now_playing', {
      title: track.title,
      provider: track.provider,
      requestedById: item.kind === 'request' ? item.track.requestedById : null,
    });
    logger.info(
      'playback',
      `${item.kind === 'request' ? 'Играет заказ' : 'Играет дефолтный плейлист'}: "${track.title}" (${track.provider}, ${track.playUri})`,
    );
    if (item.kind === 'default' && this.stream) {
      this.stream.trackStarted(track);
      this.prefetchStreamBatch();
    }

    let ok = true;
    // Звук реально пошёл? Для заказа за баллы — выполнить награду или вернуть баллы.
    let audioConfirmed = false;
    let audioKnown = false;
    let prepareTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let session: { finished: Promise<void>; stop: () => void; audioStarted?: Promise<void> };
      if (track.provider === 'spotify') {
        if (!this.spotify) throw new Error('трек Spotify, но Spotify не настроен');
        this.spotifyMayBePlaying = true;
        session = playSpotifyTrack(this.spotify, track.playUri, {
          pollIntervalMs: this.cfg.pollIntervalMs,
          queued,
          prepareNext: () => this.queueNextSpotifyTrack(item),
          expected: { title: track.title, artist: track.author },
        });
        current.startedAt = Date.now();
      } else {
        await this.silenceSpotify();
        const mpvSession = this.mpv.play(track.playUri);
        void mpvSession.audioStarted?.then(() => {
          current.startedAt = Date.now();
        });
        session = mpvSession;
        // У mpv нет prepareNext, как у плеера Spotify, — следующий трек
        // готовим по таймеру от заявленной длительности трека. Отсчёт идёт с
        // запуска, а звук начинается на пару секунд позже, так что на деле
        // это чуть раньше, чем за MPV_PREPARE_NEXT_LEAD_MS до конца.
        if (track.durationSec > 0) {
          const delayMs = Math.max(0, track.durationSec * 1000 - MPV_PREPARE_NEXT_LEAD_MS);
          prepareTimer = setTimeout(() => this.prepareNextMpvTrack(item), delayMs);
        }
      }
      current.stop = session.stop;
      if (session.audioStarted) {
        audioKnown = true;
        void session.audioStarted.then(() => {
          audioConfirmed = true;
        });
      }
      // Скип/остановка могли прийти, пока запускали трек.
      if (this.stopped) session.stop();
      await session.finished;
    } catch (err) {
      ok = false;
      logger.error('playback', `Ошибка воспроизведения "${track.title}" — перехожу к следующему треку`, err);
    }
    clearTimeout(prepareTimer);
    await Promise.resolve(); // дать отработать .then у audioStarted, если он только что наступил

    if (item.kind === 'request') {
      eventBus.emit('song.request_finished', {
        requestId: item.track.id,
        title: track.title,
        requestedByLogin: item.track.requestedByLogin,
        redemptionId: item.track.redemptionId ?? null,
        rewardId: item.track.rewardId ?? null,
        // Плеер без сигнала о старте звука (тестовые подделки) — судим по исходу.
        audioStarted: audioKnown ? audioConfirmed : ok,
      });
    }

    const halted = this.haltRequested;
    this.haltRequested = false;
    this.current = null;
    if (item.kind === 'request') {
      this.requests.markDone(item.track.id);
    } else if (!halted) {
      this.defaults.remove(item.track.id);
      // Остановку приложения и сбой воспроизведения волне не сообщаем —
      // это не оценка трека; трек, остановленный !pr, ещё сыграет заново.
      if (this.stream && ok && !this.stopped) {
        const playedSec = current.startedAt === null ? 0 : (Date.now() - current.startedAt) / 1000;
        this.stream.trackEnded(track, playedSec, current.skipped === true);
      }
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
