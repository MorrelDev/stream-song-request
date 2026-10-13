import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStreamViewerCount } from '../src/integrations/twitch/streamInfo.ts';

const cfg = { clientId: 'cid', broadcasterId: '42', getAccessToken: async () => 'tok' };

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: HeadersInit } = {}): typeof fetch {
  return (async (url: URL | string, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = init?.headers;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('getStreamViewerCount возвращает viewer_count стрима', async () => {
  const seen: { url?: string; headers?: HeadersInit } = {};
  const count = await getStreamViewerCount(cfg, fakeFetch(200, { data: [{ viewer_count: 57 }] }, seen));
  assert.equal(count, 57);
  assert.equal(seen.url, 'https://api.twitch.tv/helix/streams?user_id=42');
  assert.deepEqual(seen.headers, { 'Client-Id': 'cid', Authorization: 'Bearer tok' });
});

test('getStreamViewerCount возвращает null, если стрим оффлайн', async () => {
  assert.equal(await getStreamViewerCount(cfg, fakeFetch(200, { data: [] })), null);
});

test('getStreamViewerCount бросает ошибку при неуспешном ответе API', async () => {
  await assert.rejects(getStreamViewerCount(cfg, fakeFetch(401, {})), /HTTP 401/);
});
