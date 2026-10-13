import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaybackOrchestrator,
  shuffled,
  type DefaultTracksLike,
  type QueueLike,
  type SpotifyPlaybackLike,
  type YoutubePlayerLike,
} from '../src/music/playbackOrchestrator.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import { eventBus } from '../src/core/eventBus.ts';
import type { QueuedSongRequest } from '../src/db/musicQueue.ts';
import type { DefaultTrack, NewDefaultTrack } from '../src/db/defaultTracks.ts';
import type { SongNowPlayingEvent, SongProvider } from '../src/core/events.ts';

beforeEach(() => {
  setRequestsPaused(false);
});

/** mpv: трек "играет", пока тест не вызовет finish() или его не остановят. */
class FakeMpv implements YoutubePlayerLike {
  played: string[] = [];
  stopped: string[] = [];
  prepared: string[] = [];
  failNext = false;
  private finishers: Array<() => void> = [];

  prepare(url: string): void {
    this.prepared.push(url);
  }

  play(url: string): { finished: Promise<void>; stop: () => void } {
    this.played.push(url);
    if (this.failNext) {
      this.failNext = false;
      return { finished: Promise.reject(new Error('mpv упал')), stop: () => {} };
    }
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    this.finishers.push(resolve);
    return {
      finished,
      stop: () => {
        this.stopped.push(url);
        this.finishers = this.finishers.filter((f) => f !== resolve);
        resolve();
      },
    };
  }

  finish(): void {
    this.finishers.shift()?.();
  }
}

/**
 * Spotify-устройство с очередью: трек продвигается на stepMs за опрос; в
 * конце трека Spotify сам переходит к следующему в очереди, а если она
 * пуста — останавливается.
 */
class FakeSpotify implements SpotifyPlaybackLike {
  calls: string[] = [];
  private queue: string[] = [];
  private uri: string | null = null;
  private progress = 0;
  private readonly durationMs: number;
  private readonly stepMs: number;

  // По умолчанию второй опрос — "осталось меньше 2 с", трек доигрывается.
  constructor(durationMs = 1000, stepMs = 700) {
    this.durationMs = durationMs;
    this.stepMs = stepMs;
  }

  async playTrackUri(uri: string): Promise<void> {
    this.calls.push(`play ${uri}`);
    this.uri = uri;
    this.progress = 0;
  }
  async queueTrack(uri: string): Promise<void> {
    this.calls.push(`queue ${uri}`);
    this.queue.push(uri);
  }
  async skipToNext(): Promise<void> {
    this.calls.push('next');
    const next = this.queue.shift();
    if (next) {
      this.uri = next;
      this.progress = 0;
    }
  }
  async pause(): Promise<void> {
    this.calls.push('pause');
  }
  async getCurrentPlayback() {
    if (!this.uri) return null;
    if (this.progress >= this.durationMs) {
      const next = this.queue.shift();
      if (!next) return { isPlaying: false, progressMs: this.durationMs, durationMs: this.durationMs, trackUri: this.uri };
      this.uri = next;
      this.progress = 0;
    }
    const state = { isPlaying: true, progressMs: this.progress, durationMs: this.durationMs, trackUri: this.uri };
    this.progress += this.stepMs;
    return state;
  }
}

class FakeRequests implements QueueLike {
  private items: QueuedSongRequest[] = [];
  private nextId = 1;

  add(provider: SongProvider, playUri: string, requestedById = 'viewer-1'): void {
    this.items.push({
      id: this.nextId++,
      provider,
      externalId: playUri,
      playUri,
      title: `req ${playUri}`,
      author: 'someone',
      durationSec: 100,
      requestedById,
      requestedByLogin: 'viewer1',
      status: 'pending',
      createdAt: '',
    });
    eventBus.emit('song.queued', { title: playUri, provider, position: 1 });
  }
  statuses(): string[] {
    return this.items.map((i) => `${i.playUri}:${i.status}`);
  }
  peekNextPending() {
    return this.items.find((i) => i.status === 'pending');
  }
  markPlaying(id: number) {
    this.items.find((i) => i.id === id)!.status = 'playing';
  }
  markDone(id: number) {
    this.items.find((i) => i.id === id)!.status = 'done';
  }
}

class FakeDefaults implements DefaultTracksLike {
  rows: DefaultTrack[] = [];
  private nextId = 1;
  peekNext(excludeId?: number) {
    return this.rows.find((r) => r.id !== excludeId);
  }
  remove(id: number) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  replaceAll(tracks: NewDefaultTrack[]) {
    this.rows = tracks.map((t) => ({ ...t, id: this.nextId++ }));
  }
  uris(): string[] {
    return this.rows.map((r) => r.playUri);
  }
}

const def = (n: number, provider: SongProvider = 'yandex'): NewDefaultTrack => ({
  provider,
  playUri: provider === 'spotify' ? `spotify:track:d${n}` : `yandex:track:${n}`,
  title: `Default ${n}`,
  author: 'Artist',
  durationSec: 100,
});

/** Ждать, пока условие станет истинным (цикл оркестратора асинхронный). */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

function setup(
  opts: {
    playlist?: NewDefaultTrack[];
    loader?: () => Promise<NewDefaultTrack[]>;
    spotify?: FakeSpotify | null;
    noPlaylist?: boolean;
    reimportRetryMs?: number;
  } = {},
) {
  const mpv = new FakeMpv();
  const requests = new FakeRequests();
  const defaults = new FakeDefaults();
  const spotify = opts.spotify === undefined ? null : opts.spotify;
  let loads = 0;
  const loader = opts.noPlaylist
    ? null
    : async () => {
        loads++;
        return opts.loader ? opts.loader() : (opts.playlist ?? [def(1), def(2), def(3)]);
      };
  const orchestrator = new PlaybackOrchestrator(spotify, mpv, requests, defaults, loader, {
    pollIntervalMs: 5,
    shuffleDefaultPlaylist: false,
    reimportRetryMs: opts.reimportRetryMs ?? 50,
  });
  const done = orchestrator.start();
  return { mpv, requests, defaults, spotify, orchestrator, done, loads: () => loads };
}

test('при старте плейлист загружается в базу; треки играют по порядку и удаляются после проигрывания', async () => {
  const { mpv, defaults, orchestrator, done } = setup();
  try {
    await until(() => mpv.played.length === 1, 'первый дефолтный трек');
    assert.deepEqual(mpv.played, ['yandex:track:1']);
    assert.deepEqual(defaults.uris(), ['yandex:track:1', 'yandex:track:2', 'yandex:track:3'], 'удаляется только после проигрывания');

    mpv.finish();
    await until(() => mpv.played.length === 2, 'второй дефолтный трек');
    assert.deepEqual(defaults.uris(), ['yandex:track:2', 'yandex:track:3']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('заказ, пришедший во время дефолтного трека, играет сразу после него; потом плейлист продолжается', async () => {
  const { mpv, requests, orchestrator, done } = setup();
  try {
    await until(() => mpv.played.length === 1, 'дефолтный трек');
    requests.add('youtube', 'https://yt/a');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(mpv.played, ['yandex:track:1'], 'дефолтный трек не прерывается');

    mpv.finish();
    await until(() => mpv.played.length === 2, 'заказ');
    assert.equal(mpv.played[1], 'https://yt/a');
    assert.equal(orchestrator.getMode(), 'request');

    mpv.finish();
    await until(() => mpv.played.length === 3, 'снова плейлист');
    assert.equal(mpv.played[2], 'yandex:track:2');
    assert.deepEqual(requests.statuses(), ['https://yt/a:done']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('несколько заказов подряд — строго по очереди, плейлист ждёт', async () => {
  const { mpv, requests, orchestrator, done } = setup({ noPlaylist: true });
  try {
    requests.add('youtube', 'https://yt/1');
    requests.add('yandex', 'yandex:track:77');
    await until(() => mpv.played.length === 1, 'первый заказ');
    mpv.finish();
    await until(() => mpv.played.length === 2, 'второй заказ');
    assert.deepEqual(mpv.played, ['https://yt/1', 'yandex:track:77']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('пока играть нечего, новый заказ будит цикл сразу (song.queued)', async () => {
  const { mpv, requests, orchestrator, done } = setup({ noPlaylist: true });
  try {
    await new Promise((r) => setTimeout(r, 20));
    requests.add('youtube', 'https://yt/a');
    await until(() => mpv.played.length === 1, 'заказ');
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('треки прошлого запуска удаляются при старте, даже если плейлист не загрузился или не задан', async () => {
  for (const variant of ['load-fails', 'no-playlist'] as const) {
    const mpv = new FakeMpv();
    const defaults = new FakeDefaults();
    defaults.replaceAll([def(100), def(101)]); // остались от прошлого запуска
    const loader =
      variant === 'no-playlist'
        ? null
        : async (): Promise<NewDefaultTrack[]> => {
            throw new Error('403');
          };
    const orchestrator = new PlaybackOrchestrator(null, mpv, new FakeRequests(), defaults, loader, {
      pollIntervalMs: 5,
      shuffleDefaultPlaylist: false,
      reimportRetryMs: 60_000,
    });
    const done = orchestrator.start();
    await new Promise((r) => setTimeout(r, 30));
    orchestrator.stop();
    await done;
    assert.deepEqual(mpv.played, [], `${variant}: старые треки не играют`);
    assert.deepEqual(defaults.uris(), [], `${variant}: таблица пуста`);
  }
});

test('треки кончились — плейлист загружается заново', async () => {
  const { mpv, orchestrator, done, loads } = setup({ playlist: [def(1)] });
  try {
    await until(() => mpv.played.length === 1, 'трек 1');
    mpv.finish();
    await until(() => mpv.played.length === 2, 'трек 1 после перезагрузки');
    assert.deepEqual(mpv.played, ['yandex:track:1', 'yandex:track:1']);
    assert.equal(loads(), 2);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('плейлист не загрузился — заказы всё равно играют, загрузка повторяется позже', async () => {
  let fail = true;
  const { mpv, requests, orchestrator, done, loads } = setup({
    loader: async () => {
      if (fail) throw new Error('нет сети');
      return [def(9)];
    },
    reimportRetryMs: 30,
  });
  try {
    requests.add('youtube', 'https://yt/a');
    await until(() => mpv.played.length === 1, 'заказ');
    fail = false;
    mpv.finish();
    await until(() => mpv.played.length === 2, 'плейлист после повторной загрузки');
    assert.equal(mpv.played[1], 'yandex:track:9');
    assert.ok(loads() >= 2);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('скип дефолтного трека удаляет его и включает следующий; skip() для заказа тут не срабатывает', async () => {
  const { mpv, defaults, orchestrator, done } = setup();
  try {
    await until(() => mpv.played.length === 1, 'трек 1');
    assert.equal(orchestrator.skip(), false);
    assert.equal(orchestrator.skipDefaultPlaylist(), true);
    await until(() => mpv.played.length === 2, 'трек 2');
    assert.deepEqual(mpv.stopped, ['yandex:track:1']);
    assert.deepEqual(defaults.uris(), ['yandex:track:2', 'yandex:track:3']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('скип заказа — заказ помечается сыгранным, дальше плейлист', async () => {
  const { mpv, requests, orchestrator, done } = setup();
  try {
    requests.add('youtube', 'https://yt/a');
    await until(() => mpv.played.length === 1, 'заказ');
    assert.equal(orchestrator.skipDefaultPlaylist(), false);
    assert.equal(orchestrator.skip(), true);
    await until(() => mpv.played.length === 2, 'плейлист');
    assert.deepEqual(requests.statuses(), ['https://yt/a:done']);
    assert.equal(mpv.played[1], 'yandex:track:1');
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('!pr: дефолтный трек останавливается и остаётся в базе; принятые заказы доигрываются; после !rr трек начинается заново', async () => {
  const { mpv, requests, defaults, orchestrator, done } = setup();
  try {
    await until(() => mpv.played.length === 1, 'трек 1');
    setRequestsPaused(true);
    await orchestrator.haltDefaultPlaylist();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mpv.played, ['yandex:track:1']);
    assert.deepEqual(defaults.uris(), ['yandex:track:1', 'yandex:track:2', 'yandex:track:3']);

    requests.add('youtube', 'https://yt/accepted-before-pause');
    await until(() => mpv.played.length === 2, 'уже принятый заказ');
    mpv.finish();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mpv.played.length, 2, 'на паузе плейлист не играет');

    setRequestsPaused(false);
    await orchestrator.tick();
    await until(() => mpv.played.length === 3, 'плейлист после !rr');
    assert.equal(mpv.played[2], 'yandex:track:1');
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('ошибка воспроизведения: трек пропускается (заказ — done, дефолтный — удалён), цикл идёт дальше', async () => {
  const { mpv, defaults, orchestrator, done } = setup();
  try {
    mpv.failNext = true;
    await until(() => mpv.played.length === 2, 'следующий трек после сбоя');
    assert.deepEqual(mpv.played, ['yandex:track:1', 'yandex:track:2']);
    assert.deepEqual(defaults.uris(), ['yandex:track:2', 'yandex:track:3']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('song.now_playing: у заказа есть заказчик, у дефолтного трека — null', async () => {
  const events: SongNowPlayingEvent[] = [];
  const listener = (e: SongNowPlayingEvent): void => void events.push(e);
  eventBus.on('song.now_playing', listener);
  const { mpv, requests, orchestrator, done } = setup();
  try {
    await until(() => mpv.played.length === 1, 'трек 1');
    requests.add('youtube', 'https://yt/a', 'viewer-42');
    mpv.finish();
    await until(() => mpv.played.length === 2, 'заказ');
    assert.deepEqual(
      events.map((e) => [e.title, e.requestedById]),
      [
        ['Default 1', null],
        ['req https://yt/a', 'viewer-42'],
      ],
    );
    assert.deepEqual(await orchestrator.getCurrentTrack(), {
      provider: 'youtube',
      title: 'req https://yt/a',
      author: 'someone',
    });
  } finally {
    eventBus.off('song.now_playing', listener);
    orchestrator.stop();
    await done;
  }
});

test('Spotify → Spotify: следующий трек заранее встаёт в очередь Spotify, и Spotify переключается сам; перед mpv — пауза', async () => {
  const spotify = new FakeSpotify();
  const { mpv, requests, orchestrator, done } = setup({
    spotify,
    playlist: [def(1, 'spotify'), def(2, 'spotify')],
  });
  try {
    await until(() => spotify.calls.includes('queue spotify:track:d2'), 'второй трек в очереди Spotify');
    // Заказ пришёл, когда следующий трек уже в очереди Spotify, — играет после него.
    requests.add('youtube', 'https://yt/a');
    await until(() => mpv.played.length === 1, 'YouTube-заказ после Spotify');
    // Ни "play", ни "next" для второго трека: Spotify перешёл на него сам. Перед mpv — пауза.
    assert.deepEqual(spotify.calls, ['play spotify:track:d1', 'queue spotify:track:d2', 'pause']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('скип трека, когда следующий уже в очереди Spotify, — один "следующий", без повторной постановки', async () => {
  // Трек стоит посреди и сам не кончится; до конца меньше 15 с — следующий ставится в очередь сразу.
  const spotify = new FakeSpotify(10_000, 0);
  const { defaults, orchestrator, done } = setup({
    spotify,
    playlist: [def(1, 'spotify'), def(2, 'spotify'), def(3, 'spotify')],
  });
  try {
    await until(() => spotify.calls.includes('queue spotify:track:d2'), 'второй трек в очереди Spotify');
    assert.equal(orchestrator.skipDefaultPlaylist(), true);
    await until(() => spotify.calls.includes('queue spotify:track:d3'), 'второй трек заиграл, третий в очереди');
    assert.deepEqual(spotify.calls, [
      'play spotify:track:d1',
      'queue spotify:track:d2',
      'next',
      'queue spotify:track:d3',
    ]);
    assert.deepEqual(defaults.uris(), ['spotify:track:d2', 'spotify:track:d3']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('Spotify-заказ без настроенного Spotify — пропускается, приложение не падает', async () => {
  const { mpv, requests, orchestrator, done } = setup({ noPlaylist: true });
  try {
    requests.add('spotify', 'spotify:track:x');
    requests.add('youtube', 'https://yt/after');
    await until(() => mpv.played.length === 1, 'следующий заказ');
    assert.deepEqual(requests.statuses(), ['spotify:track:x:done', 'https://yt/after:playing']);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('незадолго до конца mpv-трека следующий mpv-трек готовится заранее (prepare)', async () => {
  // durationSec меньше 15 с — таймер подготовки срабатывает сразу.
  const short = (n: number): NewDefaultTrack => ({ ...def(n), durationSec: 5 });
  const { mpv, requests, orchestrator, done } = setup({ playlist: [short(1), short(2)] });
  try {
    await until(() => mpv.played.length === 1, 'первый трек');
    await until(() => mpv.prepared.length === 1, 'подготовка следующего');
    assert.deepEqual(mpv.prepared, ['yandex:track:2']);

    // Пришёл заказ — теперь следующим будет он; по таймеру следующего трека готовится уже заказ.
    requests.add('youtube', 'https://yt/a');
    mpv.finish();
    await until(() => mpv.played.length === 2, 'заказ');
    assert.equal(mpv.played[1], 'https://yt/a');
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('Spotify-трек, следующий — YouTube: YouTube готовится заранее, в очередь Spotify ничего не ставится', async () => {
  const spotify = new FakeSpotify();
  const { mpv, requests, orchestrator, done } = setup({ noPlaylist: true, spotify });
  try {
    requests.add('spotify', 'spotify:track:x');
    requests.add('youtube', 'https://yt/next');
    await until(() => mpv.prepared.length === 1, 'подготовка YouTube');
    assert.deepEqual(mpv.prepared, ['https://yt/next']);
    await until(() => mpv.played.length === 1, 'YouTube после Spotify');
    assert.ok(!spotify.calls.some((c) => c.startsWith('queue')));
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('shuffled: перестановка тех же элементов, исходный массив не меняется', () => {
  const src = [1, 2, 3];
  assert.deepEqual(shuffled(src, () => 0), [2, 3, 1]);
  assert.deepEqual(src, [1, 2, 3]);
});

test('getNowPlaying: заказ — с логином заказчика; startedAt появляется, когда mpv открыл аудиовыход', async () => {
  let audioStarted!: () => void;
  let finish!: () => void;
  const mpv: YoutubePlayerLike = {
    play: () => ({
      finished: new Promise<void>((r) => (finish = r)),
      stop: () => finish(),
      audioStarted: new Promise<void>((r) => (audioStarted = r)),
    }),
  };
  const requests = new FakeRequests();
  const orchestrator = new PlaybackOrchestrator(null, mpv, requests, new FakeDefaults(), null, {
    pollIntervalMs: 5,
    shuffleDefaultPlaylist: false,
  });
  assert.equal(orchestrator.getNowPlaying(), null, 'ничего не играет');
  const done = orchestrator.start();
  try {
    requests.add('youtube', 'https://yt/a');
    await until(() => orchestrator.getNowPlaying() !== null, 'заказ заиграл');
    const pending = orchestrator.getNowPlaying()!;
    assert.equal(pending.kind, 'request');
    assert.equal(pending.playUri, 'https://yt/a');
    assert.equal(pending.requestedByLogin, 'viewer1');
    assert.equal(pending.durationSec, 100);
    assert.equal(pending.startedAt, null, 'звук ещё не пошёл');

    const before = Date.now();
    audioStarted();
    await until(() => orchestrator.getNowPlaying()?.startedAt !== null, 'startedAt');
    assert.ok(orchestrator.getNowPlaying()!.startedAt! >= before);

    finish();
    await until(() => orchestrator.getNowPlaying() === null, 'заказ доиграл');
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('getNowPlaying: трек дефолтного плейлиста Spotify — без заказчика, startedAt сразу', async () => {
  const { orchestrator, done } = setup({ spotify: new FakeSpotify(), playlist: [def(1, 'spotify')] });
  try {
    await until(() => orchestrator.getNowPlaying() !== null, 'дефолтный трек');
    const np = orchestrator.getNowPlaying()!;
    assert.equal(np.kind, 'default');
    assert.equal(np.provider, 'spotify');
    assert.equal(np.requestedByLogin, null);
    assert.notEqual(np.startedAt, null);
  } finally {
    orchestrator.stop();
    await done;
  }
});

test('getNowPlaying при переходе Spotify → Spotify через очередь: второй трек со своим startedAt (для оверлея)', async () => {
  const spotify = new FakeSpotify();
  const { orchestrator, done } = setup({ spotify, playlist: [def(1, 'spotify'), def(2, 'spotify')] });
  try {
    await until(() => orchestrator.getNowPlaying()?.playUri === 'spotify:track:d1', 'первый трек');
    const first = orchestrator.getNowPlaying()!;
    assert.notEqual(first.startedAt, null);
    await until(() => spotify.calls.includes('queue spotify:track:d2'), 'второй трек в очереди Spotify');
    await until(() => orchestrator.getNowPlaying()?.playUri === 'spotify:track:d2', 'второй трек заиграл');
    const second = orchestrator.getNowPlaying()!;
    assert.equal(second.kind, 'default');
    assert.notEqual(second.startedAt, null);
    assert.ok(second.startedAt! >= first.startedAt!, 'время старта второго трека — не раньше первого');
    assert.ok(!spotify.calls.includes('play spotify:track:d2'), 'Spotify перешёл сам, без play');
  } finally {
    orchestrator.stop();
    await done;
  }
});
