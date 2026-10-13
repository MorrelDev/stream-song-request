import { logger } from '../core/logger.ts';
import { parseYandexPlayUri } from './yandexMusicProvider.ts';
import { yandexTrackToDefaultTrack, type YandexTrackEntryJson } from './yandexPlaylist.ts';
import type { NewDefaultTrack } from '../db/defaultTracks.ts';
import type { DefaultTrackStream } from './playbackOrchestrator.ts';

/**
 * Моя волна Яндекс Музыки как дефолтный плейлист (YANDEX_DEFAULT_PLAYLIST_URL=WAVE).
 *
 * Неофициальный API "сессий радио" (rotor session) — тот же, что у
 * официальных клиентов и библиотеки yandex-music-api:
 *
 *  - POST /rotor/session/new {seeds: ['user:onyourwave'], incognito: true} —
 *    новая сессия и первая порция треков; incognito — стрим не влияет на
 *    рекомендации аккаунта;
 *  - POST /rotor/session/<id>/tracks {queue} — следующая порция; в queue —
 *    уже полученные треки, чтобы волна их не повторяла;
 *  - POST /rotor/session/<id>/feedback — начало, конец и скип трека: по ним
 *    волна подстраивает следующие порции этой сессии.
 *
 * Сессия может протухнуть (например, приложение долго стояло на паузе !pr) —
 * тогда API отвечает unknownSession, и создаётся новая.
 */

const API_BASE = 'https://api.music.yandex.net';
const WAVE_SEED = 'user:onyourwave';
/** Сколько последних полученных треков помнить и передавать в queue. */
const RECEIVED_LIMIT = 50;

interface WaveBatchJson {
  radioSessionId?: string;
  batchId?: string;
  sequence?: Array<{ type?: string; track?: YandexTrackEntryJson }>;
  unknownSession?: boolean;
  terminated?: boolean;
}

interface WaveEvent {
  type: 'radioStarted' | 'trackStarted' | 'trackFinished' | 'skip';
  trackId?: string;
  totalPlayedSeconds?: number;
}

export class YandexWave implements DefaultTrackStream {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  /** id последних полученных треков — для queue и чтобы отсеять повторы. */
  private received: string[] = [];
  /** Из какой порции трек (playUri → batchId) — для обратной связи. */
  private batchOf = new Map<string, string>();

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async nextBatch(): Promise<NewDefaultTrack[]> {
    let batch: WaveBatchJson | null = null;
    if (this.sessionId) {
      try {
        batch = await this.post<WaveBatchJson>(`/rotor/session/${encodeURIComponent(this.sessionId)}/tracks`, {
          queue: this.received,
        });
      } catch (err) {
        // Что бы ни случилось со старой сессией — пробуем новую; если дело
        // в токене или сети, ошибку бросит уже запрос новой сессии.
        logger.warn('playback', `Моя волна: не удалось продолжить сессию (${String(err)}) — начинаю новую`);
      }
      if (batch?.unknownSession || batch?.terminated) {
        logger.info('playback', 'Сессия Моей волны закончилась — начинаю новую');
        batch = null;
      }
    }
    if (!batch) {
      batch = await this.post<WaveBatchJson>('/rotor/session/new', {
        seeds: [WAVE_SEED],
        includeTracksInResponse: true,
        // Стрим не должен влиять на рекомендации аккаунта: в "инкогнито"
        // прослушивания и скипы подстраивают только текущую сессию волны.
        incognito: true,
        queue: this.received,
      });
      if (!batch.radioSessionId) throw new Error('Яндекс Музыка не вернула id сессии Моей волны');
      this.sessionId = batch.radioSessionId;
      this.sendFeedback({ type: 'radioStarted' }, batch.batchId);
    }

    const tracks: NewDefaultTrack[] = [];
    for (const entry of batch.sequence ?? []) {
      if (entry.type !== undefined && entry.type !== 'track') continue;
      const track = entry.track ? yandexTrackToDefaultTrack(entry.track) : null;
      if (!track) continue;
      const id = parseYandexPlayUri(track.playUri)!;
      if (this.received.includes(id)) continue;
      this.received.push(id);
      if (batch.batchId) this.batchOf.set(track.playUri, batch.batchId);
      tracks.push(track);
    }
    this.received = this.received.slice(-RECEIVED_LIMIT);
    return tracks;
  }

  trackStarted(track: NewDefaultTrack): void {
    const trackId = parseYandexPlayUri(track.playUri);
    if (!trackId) return;
    this.sendFeedback({ type: 'trackStarted', trackId }, this.batchOf.get(track.playUri));
  }

  trackEnded(track: NewDefaultTrack, playedSec: number, skipped: boolean): void {
    const trackId = parseYandexPlayUri(track.playUri);
    if (!trackId) return;
    const totalPlayedSeconds = Math.round(playedSec * 10) / 10;
    this.sendFeedback(
      { type: skipped ? 'skip' : 'trackFinished', trackId, totalPlayedSeconds },
      this.batchOf.get(track.playUri),
    );
    this.batchOf.delete(track.playUri);
  }

  /** Обратная связь не критична: ошибка только пишется в лог, музыка играет дальше. */
  private sendFeedback(event: WaveEvent, batchId: string | undefined): void {
    if (!this.sessionId) return;
    const body = {
      event: { ...event, timestamp: new Date().toISOString() },
      ...(batchId ? { batchId } : {}),
    };
    this.post(`/rotor/session/${encodeURIComponent(this.sessionId)}/feedback`, body).catch((err: unknown) => {
      logger.warn('playback', `Моя волна: не удалось отправить обратную связь (${event.type}): ${String(err)}`);
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Яндекс Музыка отклонила токен (HTTP ${res.status}) — обнови YANDEX_MUSIC_TOKEN`);
    }
    if (!res.ok) {
      throw new Error(`Яндекс Музыка вернула ошибку HTTP ${res.status} на запрос Моей волны (${path})`);
    }
    const data = (await res.json()) as { result?: T };
    if (data.result === undefined) throw new Error(`Яндекс Музыка вернула пустой ответ на запрос Моей волны (${path})`);
    return data.result;
  }
}
