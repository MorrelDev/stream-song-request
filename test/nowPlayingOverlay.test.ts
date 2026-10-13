import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { resolveCoverUrl, startNowPlayingOverlay, type OverlayState } from '../src/overlay/nowPlayingOverlay.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';
import type { NowPlayingInfo } from '../src/music/playbackOrchestrator.ts';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('resolveCoverUrl: YouTube — maxresdefault, если есть, иначе mqdefault (без запросов к API)', async () => {
  const requested: string[] = [];
  const fetchWith = (maxresOk: boolean) =>
    (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(null, { status: maxresOk ? 200 : 404 });
    }) as typeof fetch;
  const deps = { spotifyApp: null, yandexToken: undefined };

  assert.equal(
    await resolveCoverUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', deps, fetchWith(true)),
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  );
  assert.equal(
    await resolveCoverUrl('https://youtu.be/dQw4w9WgXcQ', deps, fetchWith(false)),
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
  );
  assert.ok(requested.every((u) => u.startsWith('https://i.ytimg.com/')));
});

test('resolveCoverUrl: Spotify — самая большая обложка альбома', async () => {
  resetSpotifyAppTokenCache();
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === 'https://accounts.spotify.com/api/token') return json({ access_token: 'app', expires_in: 3600 });
    assert.equal(u, 'https://api.spotify.com/v1/tracks/abc');
    return json({ album: { images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'small', width: 64 }] } });
  }) as typeof fetch;
  const url = await resolveCoverUrl(
    'spotify:track:abc',
    { spotifyApp: { clientId: 'id', clientSecret: 'secret' }, yandexToken: undefined },
    fakeFetch,
  );
  assert.equal(url, 'https://i.scdn.co/image/big');
});

test('resolveCoverUrl: Spotify без настроек — без обложки', async () => {
  assert.equal(await resolveCoverUrl('spotify:track:abc', { spotifyApp: null, yandexToken: undefined }), null);
});

test('resolveCoverUrl: Яндекс — coverUri с размером 400x400', async () => {
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.music.yandex.net/tracks/42');
    assert.deepEqual(init?.headers, { Authorization: 'OAuth tok' });
    return json({ result: [{ coverUri: 'avatars.yandex.net/get-music-content/1/2/%%' }] });
  }) as typeof fetch;
  assert.equal(
    await resolveCoverUrl('yandex:track:42', { spotifyApp: null, yandexToken: 'tok' }, fakeFetch),
    'https://avatars.yandex.net/get-music-content/1/2/400x400',
  );
});

async function withServer(
  getNowPlaying: () => NowPlayingInfo | null,
  run: (base: string) => Promise<void>,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const server = startNowPlayingOverlay({
    port: 0,
    getNowPlaying,
    spotifyApp: null,
    getSpotifyPlayback: null,
    yandexToken: undefined,
    fetchImpl,
  });
  if (!server.listening) await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const youtubeRequest = (startedAt: number | null): NowPlayingInfo => ({
  kind: 'request',
  provider: 'youtube',
  title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
  author: 'Rick Astley',
  playUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  durationSec: 213,
  startedAt,
  requestedByLogin: 'shaky',
});

test('оверлей: /overlay/state — ничего не играет', async () => {
  await withServer(
    () => null,
    async (base) => {
      const state = (await (await fetch(`${base}/overlay/state`)).json()) as OverlayState;
      assert.equal(state.playing, false);
    },
  );
});

test('оверлей: /overlay/state — заказ YouTube с очищенным названием, заказчиком и прогрессом', async () => {
  await withServer(
    () => youtubeRequest(Date.now() - 10_000),
    async (base) => {
      const state = (await (await fetch(`${base}/overlay/state`)).json()) as OverlayState;
      assert.equal(state.playing, true);
      assert.equal(state.title, 'Never Gonna Give You Up');
      assert.equal(state.artist, 'Rick Astley');
      assert.equal(state.requester, 'shaky');
      assert.equal(state.durationSec, 213);
      assert.ok(state.positionSec! >= 10 && state.positionSec! < 12, `positionSec=${state.positionSec}`);
      assert.equal(state.isPlaying, true);
      assert.ok(state.coverUrl?.startsWith('/overlay/cover?uri='));
    },
  );
});

test('оверлей: пока звук не пошёл — positionSec null', async () => {
  await withServer(
    () => youtubeRequest(null),
    async (base) => {
      const state = (await (await fetch(`${base}/overlay/state`)).json()) as OverlayState;
      assert.equal(state.positionSec, null);
      assert.equal(state.isPlaying, false);
    },
  );
});

test('оверлей: /overlay/cover отдаёт обложку только текущего трека', async () => {
  const image = Buffer.from([1, 2, 3]);
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    assert.equal(String(url), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
    return new Response(image, { headers: { 'Content-Type': 'image/jpeg' } });
  }) as typeof fetch;
  await withServer(
    () => youtubeRequest(Date.now()),
    async (base) => {
      const state = (await (await fetch(`${base}/overlay/state`)).json()) as OverlayState;
      const res = await fetch(`${base}${state.coverUrl}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), image);

      const other = await fetch(`${base}/overlay/cover?uri=${encodeURIComponent('https://example.com/x.jpg')}`);
      assert.equal(other.status, 404);
    },
    fakeFetch,
  );
});

test('оверлей: /overlay — страница', async () => {
  await withServer(
    () => null,
    async (base) => {
      const res = await fetch(`${base}/overlay`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<div class="card hidden" id="card">/);
    },
  );
});

test('оверлей: пауза в Spotify — прогресс берётся у Spotify и не идёт дальше', async () => {
  const playUri = 'spotify:track:abc';
  let spotifyCalls = 0;
  const server = startNowPlayingOverlay({
    port: 0,
    getNowPlaying: () => ({
      kind: 'default',
      provider: 'spotify',
      title: 'Thunder',
      author: 'Skott',
      playUri,
      durationSec: 228,
      startedAt: Date.now() - 100_000,
      requestedByLogin: null,
    }),
    spotifyApp: null,
    getSpotifyPlayback: async () => {
      spotifyCalls++;
      return { isPlaying: false, progressMs: 16_000, durationMs: 228_000, trackUri: playUri, trackTitle: 'Thunder', trackArtist: 'Skott' };
    },
    yandexToken: undefined,
  });
  if (!server.listening) await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = async () => (await (await fetch(`${base}/overlay/state`)).json()) as OverlayState;
    await read(); // первый запрос запускает опрос Spotify
    await new Promise((r) => setTimeout(r, 50));
    const first = await read();
    assert.equal(first.isPlaying, false);
    assert.equal(first.positionSec, 16);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await read()).positionSec, 16, 'на паузе время стоит');
    assert.equal(spotifyCalls, 1, 'Spotify опрашивается не чаще раза в секунду');
  } finally {
    server.close();
  }
});
