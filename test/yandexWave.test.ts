import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YandexWave } from '../src/music/yandexWave.ts';

interface Call {
  path: string;
  body: Record<string, unknown>;
  auth: string | null;
}

/** Подменённый fetch: отвечает по пути запроса, запоминает запросы. */
function fakeApi(handler: (path: string, body: Record<string, unknown>) => { status?: number; result?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
    const path = String(u).replace('https://api.music.yandex.net', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body, auth: new Headers(init?.headers).get('Authorization') });
    const { status = 200, result } = handler(path, body);
    return new Response(JSON.stringify({ result }), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const track = (id: number, extra: Record<string, unknown> = {}) => ({
  type: 'track',
  track: { id: String(id), title: `T${id}`, durationMs: 200_000, artists: [{ name: 'A' }], ...extra },
});

/** Дать отработать фоновым запросам обратной связи. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('YandexWave: первая порция — новая сессия; следующие — по id сессии с уже полученными треками в queue', async () => {
  const { calls, fetchImpl } = fakeApi((path) => {
    if (path === '/rotor/session/new') {
      return { result: { radioSessionId: 'S1', batchId: 'B1', sequence: [track(1), track(2, { available: false })] } };
    }
    if (path === '/rotor/session/S1/tracks') {
      // Повтор уже полученного трека 1 отсеивается.
      return { result: { batchId: 'B2', sequence: [track(1), track(3)] } };
    }
    return { result: {} };
  });
  const wave = new YandexWave('ya-token', fetchImpl);

  assert.deepEqual(await wave.nextBatch(), [
    { provider: 'yandex', playUri: 'yandex:track:1', title: 'T1', author: 'A', durationSec: 200 },
  ]);
  assert.deepEqual(calls[0], {
    path: '/rotor/session/new',
    body: { seeds: ['user:onyourwave'], includeTracksInResponse: true, incognito: true, queue: [] },
    auth: 'OAuth ya-token',
  });

  const second = await wave.nextBatch();
  assert.deepEqual(
    second.map((t) => t.playUri),
    ['yandex:track:3'],
  );
  const tracksCall = calls.find((c) => c.path === '/rotor/session/S1/tracks')!;
  assert.deepEqual(tracksCall.body, { queue: ['1'] });

  await flush();
  const radioStarted = calls.find((c) => c.path === '/rotor/session/S1/feedback')!;
  assert.equal((radioStarted.body.event as { type: string }).type, 'radioStarted');
  assert.equal(radioStarted.body.batchId, 'B1');
});

test('YandexWave: начало, конец и скип трека уходят в feedback с партией трека', async () => {
  const { calls, fetchImpl } = fakeApi((path) =>
    path === '/rotor/session/new'
      ? { result: { radioSessionId: 'S1', batchId: 'B1', sequence: [track(1), track(2)] } }
      : { result: 'ok' },
  );
  const wave = new YandexWave('ya-token', fetchImpl);
  const [t1, t2] = await wave.nextBatch();

  wave.trackStarted(t1);
  wave.trackEnded(t1, 199.96, false);
  wave.trackStarted(t2);
  wave.trackEnded(t2, 12.34, true);
  await flush();

  const events = calls
    .filter((c) => c.path === '/rotor/session/S1/feedback')
    .map((c) => {
      const { timestamp, ...event } = c.body.event as Record<string, unknown>;
      assert.equal(typeof timestamp, 'string');
      return { ...event, batchId: c.body.batchId };
    });
  assert.deepEqual(events, [
    { type: 'radioStarted', batchId: 'B1' },
    { type: 'trackStarted', trackId: '1', batchId: 'B1' },
    { type: 'trackFinished', trackId: '1', totalPlayedSeconds: 200, batchId: 'B1' },
    { type: 'trackStarted', trackId: '2', batchId: 'B1' },
    { type: 'skip', trackId: '2', totalPlayedSeconds: 12.3, batchId: 'B1' },
  ]);
});

test('YandexWave: сессия протухла (unknownSession или ошибка) — создаётся новая, queue сохраняется', async () => {
  let sessions = 0;
  let tracksAnswer: { status?: number; result?: unknown } = { result: { unknownSession: true } };
  const { calls, fetchImpl } = fakeApi((path) => {
    if (path === '/rotor/session/new') {
      sessions++;
      return { result: { radioSessionId: `S${sessions}`, batchId: 'B', sequence: [track(sessions * 10)] } };
    }
    if (path.endsWith('/tracks')) return tracksAnswer;
    return { result: 'ok' };
  });
  const wave = new YandexWave('ya-token', fetchImpl);

  await wave.nextBatch();
  assert.deepEqual(
    (await wave.nextBatch()).map((t) => t.playUri),
    ['yandex:track:20'],
  );
  assert.deepEqual(calls.filter((c) => c.path === '/rotor/session/new')[1].body.queue, ['10']);

  tracksAnswer = { status: 500 };
  assert.deepEqual(
    (await wave.nextBatch()).map((t) => t.playUri),
    ['yandex:track:30'],
  );
  assert.ok(calls.some((c) => c.path === '/rotor/session/S2/tracks'), 'сначала пробует продолжить текущую сессию');
});

test('YandexWave: отклонённый токен — понятная ошибка', async () => {
  const { fetchImpl } = fakeApi(() => ({ status: 401 }));
  const wave = new YandexWave('bad', fetchImpl);
  await assert.rejects(wave.nextBatch(), /YANDEX_MUSIC_TOKEN/);
});
