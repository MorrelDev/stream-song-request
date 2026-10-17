import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpotifyTrackDetails, SpotifyPlaybackController } from '../src/music/spotifyProvider.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';

test('fetchSpotifyTrackDetails возвращает метаданные трека', async () => {
  resetSpotifyAppTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('api.spotify.com/v1/tracks/')) {
      return new Response(
        JSON.stringify({
          uri: 'spotify:track:6habFhsOp2NvshLv26DqMb',
          name: 'Test Track',
          artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
          duration_ms: 210000,
        }),
        { status: 200 },
      );
    }
    throw new Error(`Неожиданный URL: ${u}`);
  }) as typeof fetch;

  const details = await fetchSpotifyTrackDetails('6habFhsOp2NvshLv26DqMb', 'cid', 'secret', fakeFetch);
  assert.ok(details);
  assert.equal(details?.uri, 'spotify:track:6habFhsOp2NvshLv26DqMb');
  assert.equal(details?.title, 'Test Track');
  assert.equal(details?.artist, 'Artist A, Artist B');
  assert.equal(details?.durationMs, 210000);
});

test('fetchSpotifyTrackDetails возвращает null для 404', async () => {
  resetSpotifyAppTokenCache();
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const details = await fetchSpotifyTrackDetails('doesnotexist', 'cid', 'secret', fakeFetch);
  assert.equal(details, null);
});

test('SpotifyPlaybackController.getCurrentPlayback возвращает null при 204 (ничего не играет)', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const state = await controller.getCurrentPlayback();
  assert.equal(state, null);
});

test('SpotifyPlaybackController.getCurrentPlayback парсит состояние воспроизведения', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        is_playing: true,
        progress_ms: 1000,
        item: {
          duration_ms: 200000,
          uri: 'spotify:track:abc',
          name: 'Track Name',
          artists: [{ name: 'Artist One' }, { name: 'Artist Two' }],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const state = await controller.getCurrentPlayback();
  assert.deepEqual(state, {
    isPlaying: true,
    progressMs: 1000,
    durationMs: 200000,
    trackUri: 'spotify:track:abc',
    trackTitle: 'Track Name',
    trackArtist: 'Artist One, Artist Two',
  });
});

test('SpotifyPlaybackController.playTrackUri добавляет трек в очередь и переключается на него (queue + next)', async () => {
  // Реализовано через queue+next, а не через прямой PUT /play с uris — на
  // некоторых сторонних Connect-устройствах прямой запрос принимается
  // (HTTP 204), но реально не запускает воспроизведение (см. комментарий в
  // spotifyProvider.ts). queue+next надёжнее на таких устройствах.
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await controller.playTrackUri('spotify:track:xyz');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/me\/player\/queue\?uri=spotify%3Atrack%3Axyz$/);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/me\/player\/next$/);
});

test('playTrackUri: сбой при добавлении в очередь (не 404) бросает обычную ошибку, без подсказки про устройство, и не идёт дальше на next', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response('server error', { status: 500 });
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(() => controller.playTrackUri('spotify:track:xyz'), (err: Error) => {
    assert.match(err.message, /HTTP 500/);
    assert.doesNotMatch(err.message, /активного устройства/);
    return true;
  });
  assert.equal(calls, 1);
});

test('fetchPlaylistTracks: читает /items постранично, пропускает локальные файлы, подкасты и недоступные треки', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const urls: string[] = [];
  const track = (id: string, extra: object = {}) => ({
    is_local: false,
    item: { type: 'track', uri: `spotify:track:${id}`, name: `T${id}`, duration_ms: 1000, artists: [{ name: 'A' }], ...extra },
  });
  const fakeFetch = (async (url: string | URL) => {
    urls.push(String(url));
    const page2 = String(url).includes('page=2');
    return new Response(
      JSON.stringify(
        page2
          ? { next: null, items: [track('3')] }
          : {
              next: 'https://api.spotify.com/v1/playlists/abc/items?page=2',
              items: [
                track('1'),
                { is_local: true, item: { type: 'track', uri: 'spotify:local:x', name: 'L', duration_ms: 1 } },
                track('ep', { type: 'episode' }),
                track('2', { is_playable: false }),
                { is_local: false, item: null },
              ],
            },
      ),
      { status: 200 },
    );
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const tracks = await controller.fetchPlaylistTracks('spotify:playlist:abc');

  assert.deepEqual(
    tracks.map((t) => t.uri),
    ['spotify:track:1', 'spotify:track:3'],
  );
  assert.deepEqual(tracks[0], { uri: 'spotify:track:1', title: 'T1', artist: 'A', durationMs: 1000 });
  assert.match(urls[0], /\/v1\/playlists\/abc\/items\?.*market=from_token/);
  assert.equal(urls.length, 2);
});

test('fetchPlaylistTracks: HTTP 403 — подсказка добавить плейлист в медиатеку', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response('{"error":{"status":403}}', { status: 403 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(() => controller.fetchPlaylistTracks('spotify:playlist:abc'), /403.*медиатек/s);
});

test('fetchTopTracks: читает /me/top/tracks long_term постранично, пропускает локальные и недоступные', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const urls: string[] = [];
  const track = (id: string, extra: object = {}) => ({
    uri: `spotify:track:${id}`, name: `T${id}`, duration_ms: 1000, artists: [{ name: 'A' }], ...extra,
  });
  const fakeFetch = (async (url: string | URL) => {
    urls.push(String(url));
    const page2 = String(url).includes('offset=50');
    return new Response(
      JSON.stringify(
        page2
          ? { next: null, items: [track('3')] }
          : {
              next: 'https://api.spotify.com/v1/me/top/tracks?time_range=long_term&offset=50&limit=50',
              items: [track('1'), track('l', { is_local: true }), track('2', { is_playable: false }), null],
            },
      ),
      { status: 200 },
    );
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const tracks = await controller.fetchTopTracks('long_term');

  assert.deepEqual(tracks.map((t) => t.uri), ['spotify:track:1', 'spotify:track:3']);
  assert.deepEqual(tracks[0], { uri: 'spotify:track:1', title: 'T1', artist: 'A', durationMs: 1000 });
  assert.match(urls[0], /\/v1\/me\/top\/tracks\?time_range=long_term&limit=50&market=from_token$/);
  assert.equal(urls.length, 2);
});

test('fetchTopTracks: HTTP 403 — подсказка заново пройти авторизацию', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response('{"error":{"status":403}}', { status: 403 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(() => controller.fetchTopTracks('long_term'), /403.*user-top-read.*auth:spotify/s);
});

test('diagnosePlayback: что играет (с linked_from) и первые треки очереди — одной строкой', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/me/player/queue')) {
      return new Response(
        JSON.stringify({ queue: [{ uri: 'spotify:track:q1', name: 'Q1', artists: [{ name: 'B' }] }] }),
        { status: 200 },
      );
    }
    assert.match(u, /\/me\/player\?market=from_token$/);
    return new Response(
      JSON.stringify({
        is_playing: true,
        item: { uri: 'spotify:track:x', name: 'X', artists: [{ name: 'A' }], linked_from: { uri: 'spotify:track:ours' } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const text = await controller.diagnosePlayback('spotify:track:ours');
  assert.equal(
    text,
    'ожидался spotify:track:ours | играет: spotify:track:x "A - X", linked_from: spotify:track:ours | ' +
      'очередь: spotify:track:q1 "B - Q1"',
  );
});

test('SpotifyPlaybackController.skipToNext отправляет POST на /me/player/next', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  let capturedUrl: string | undefined;
  let capturedMethod: string | undefined;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = init?.method;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await controller.skipToNext();
  assert.equal(capturedMethod, 'POST');
  assert.match(capturedUrl ?? '', /\/me\/player\/next$/);
});

test('skipToNext при HTTP 404 добавляет понятную подсказку про активное устройство', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  await assert.rejects(() => controller.skipToNext(), /HTTP 404.*активного устройства.*SPOTIFY_DEVICE_NAME/s);
});

test('listDevices парсит список устройств', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        devices: [
          { id: 'dev-1', name: 'PAVEL-PC', is_active: true },
          { id: 'dev-2', name: 'iPhone', is_active: false },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch);

  const devices = await controller.listDevices();
  assert.deepEqual(devices, [
    { id: 'dev-1', name: 'PAVEL-PC', isActive: true },
    { id: 'dev-2', name: 'iPhone', isActive: false },
  ]);
});

test('с заданным deviceName playTrackUri сам находит device_id и подставляет его в оба запроса (queue и next)', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const capturedUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/devices')) {
      return new Response(
        JSON.stringify({
          devices: [
            { id: 'dev-1', name: 'PAVEL-PC', is_active: false },
            { id: 'dev-2', name: 'iPhone', is_active: false },
          ],
        }),
        { status: 200 },
      );
    }
    capturedUrls.push(u);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  // регистр не важен — ищем без учёта регистра
  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch, 'pavel-pc');
  await controller.playTrackUri('spotify:track:xyz');

  assert.equal(capturedUrls.length, 2);
  for (const url of capturedUrls) {
    assert.match(url, /device_id=dev-1/);
  }
});

test('device_id кэшируется на короткий срок — playTrackUri не делает два похода за списком устройств подряд', async () => {
  // Раньше queueTrack() и skipToNext() внутри playTrackUri() каждый сам по
  // себе резолвил device_id — то есть на один заказ уходило два отдельных
  // GET /me/player/devices, что добавляло заметную задержку и увеличивало
  // риск не успеть до естественного конца предыдущего трека (см. README).
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  let devicesCalls = 0;
  const fakeFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/devices')) {
      devicesCalls += 1;
      return new Response(
        JSON.stringify({ devices: [{ id: 'dev-1', name: 'PAVEL-PC', is_active: false }] }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch, 'PAVEL-PC');
  await controller.playTrackUri('spotify:track:xyz');

  assert.equal(devicesCalls, 1);

  // Повторный вызов сразу после — тоже должен переиспользовать кэш.
  await controller.skipToNext();
  assert.equal(devicesCalls, 1);
});

test('с заданным deviceName, которого нет среди устройств — понятная ошибка со списком доступных', async () => {
  const fakeUserAuth = { getValidAccessToken: async () => 'user-token' };
  const fakeFetch = (async (url: string | URL) => {
    if (String(url).includes('/devices')) {
      return new Response(JSON.stringify({ devices: [{ id: 'dev-2', name: 'iPhone', is_active: false }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const controller = new SpotifyPlaybackController(fakeUserAuth, fakeFetch, 'PAVEL-PC');

  await assert.rejects(() => controller.playTrackUri('spotify:track:xyz'), /PAVEL-PC.*iPhone/s);
});
