/**
 * Текущее число зрителей стрима через Twitch Helix "Get Streams". Скоупов не
 * требует — подходит любой токен (здесь — токен чат-бота).
 */

export interface StreamInfoConfig {
  clientId: string;
  broadcasterId: string;
  getAccessToken: () => Promise<string>;
}

/**
 * Возвращает viewer_count текущего стрима или null, если стрим сейчас
 * оффлайн (Twitch возвращает пустой data). Twitch обновляет это число с
 * задержкой в пару минут — для порога голосования этого достаточно.
 */
export async function getStreamViewerCount(cfg: StreamInfoConfig, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const token = await cfg.getAccessToken();

  const url = new URL('https://api.twitch.tv/helix/streams');
  url.searchParams.set('user_id', cfg.broadcasterId);

  const res = await fetchImpl(url, {
    headers: {
      'Client-Id': cfg.clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twitch Get Streams вернул ошибку HTTP ${res.status}`);
  }

  const data = (await res.json()) as { data: Array<{ viewer_count: number }> };
  return data.data[0]?.viewer_count ?? null;
}
