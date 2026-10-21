import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import {
  handleRedemption,
  registerPointsRequestHandler,
  type PointsRequestHandlerConfig,
} from '../src/music/pointsRequestHandler.ts';
import { handleChatMessage, type RequestHandlerConfig } from '../src/music/requestHandler.ts';
import { initDb } from '../src/db/index.ts';
import { peekNextPending } from '../src/db/musicQueue.ts';
import { resetSpotifyAppTokenCache } from '../src/music/spotifyAuth.ts';
import { setRequestsPaused } from '../src/music/requestsGate.ts';
import type { RewardRedeemedEvent } from '../src/core/events.ts';
import type { RedemptionStatus } from '../src/integrations/twitch/channelPointsApi.ts';

const requestCfg: RequestHandlerConfig = {
  commandName: '!sr',
  minFollowerDays: 3,
  maxYoutubeDurationSec: 600,
  youtubeApiKey: 'yt-key',
  twitchClientId: 'tw-cid',
  twitchBroadcasterId: 'broadcaster-1',
  getTwitchAccessToken: async () => 'mod-token',
};

function makeRedemption(overrides: Partial<RewardRedeemedEvent> = {}): RewardRedeemedEvent {
  return {
    redemptionId: 'red-1',
    rewardId: 'reward-1',
    rewardTitle: 'Заказ музыки',
    userId: 'viewer-1',
    userLogin: 'viewer1',
    userName: 'Viewer1',
    userInput: 'https://youtu.be/dQw4w9WgXcQ',
    ...overrides,
  };
}

function makeCfg(opts: { failStatusUpdate?: boolean; isPrivileged?: (userId: string) => Promise<boolean> } = {}): {
  cfg: PointsRequestHandlerConfig;
  statuses: Array<{ id: string; status: RedemptionStatus }>;
} {
  const statuses: Array<{ id: string; status: RedemptionStatus }> = [];
  return {
    statuses,
    cfg: {
      request: requestCfg,
      setRedemptionStatus: async (redemption, status) => {
        if (opts.failStatusUpdate) throw new Error('Twitch недоступен');
        statuses.push({ id: redemption.redemptionId, status });
      },
      isPrivileged: opts.isPrivileged,
    },
  };
}

function collectReplies(): { replies: string[]; unsubscribe: () => void } {
  const replies: string[] = [];
  const listener = ({ text }: { text: string }): void => {
    replies.push(text);
  };
  eventBus.on('chat.reply', listener);
  return { replies, unsubscribe: () => eventBus.off('chat.reply', listener) };
}

function fakeFetch(opts: { followedDaysAgo: number | null; youtubeDurationIso?: string }): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('api.twitch.tv/helix/channels/followers')) {
      if (opts.followedDaysAgo === null) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const followedAt = new Date(Date.now() - opts.followedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
      return new Response(JSON.stringify({ data: [{ followed_at: followedAt }] }), { status: 200 });
    }
    if (u.includes('googleapis.com/youtube/v3/videos')) {
      if (!opts.youtubeDurationIso) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          items: [
            { snippet: { title: 'Cool video', channelTitle: 'Channel' }, contentDetails: { duration: opts.youtubeDurationIso } },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Неожиданный URL в тесте: ${u}`);
  }) as typeof fetch;
}

beforeEach(() => {
  initDb(':memory:');
  resetSpotifyAppTokenCache();
  setRequestsPaused(false);
});

test('валидный заказ за баллы — трек в очереди, активация ждёт, пока трек зазвучит (статус не меняется)', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.deepEqual(statuses, [], 'выполнит/отклонит pointsMode по событию song.request_finished');
    assert.equal(peekNextPending()?.redemptionId, 'red-1', 'активация записана вместе с заказом');
    assert.ok(peekNextPending()?.rewardId);
    assert.equal(peekNextPending()?.title, 'Cool video');
    assert.equal(peekNextPending()?.requestedById, 'viewer-1');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /@Viewer1 трек добавлен в очередь.*Cool video.*позиция 1/s);
  } finally {
    unsubscribe();
  }
});

test('фолловинг за баллы не требуется — проверка не вызывается вовсе, заказ не-фолловера встаёт в очередь', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('api.twitch.tv/helix/channels/followers')) {
      throw new Error('checkFollowerEligibility не должен вызываться для заказа за баллы');
    }
    return fakeFetch({ followedDaysAgo: null, youtubeDurationIso: 'PT3M0S' })(url, init);
  }) as typeof fetch;
  try {
    await handleRedemption(makeRedemption(), cfg, fetchImpl);
    assert.deepEqual(statuses, []);
    assert.equal(peekNextPending()?.requestedById, 'viewer-1');
    assert.match(replies[0], /трек добавлен в очередь/);
  } finally {
    unsubscribe();
  }
});

test('невалидная ссылка — CANCELED', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  try {
    await handleRedemption(makeRedemption({ userInput: 'включи битлз' }), cfg, fakeFetch({ followedDaysAgo: 10 }));
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(replies[0], '@Viewer1 ссылка невалидная — принимаются ссылки на YouTube');
  } finally {
    unsubscribe();
  }
});

test('видео длиннее лимита — CANCELED', async () => {
  const { unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT10M1S' }));
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(peekNextPending(), undefined);
  } finally {
    unsubscribe();
  }
});

test('заказы приостановлены (!pr) — CANCELED, ничего не заказывается', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  setRequestsPaused(true);
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(replies[0], '@Viewer1 заказы музыки сейчас недоступны');
  } finally {
    unsubscribe();
  }
});

test('непредвиденная ошибка при обработке (например, сеть) — всё равно CANCELED, баллы не пропадают', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  const brokenFetch = (async () => {
    throw new Error('сеть упала');
  }) as unknown as typeof fetch;
  try {
    await handleRedemption(makeRedemption(), cfg, brokenFetch);
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(replies[0], '@Viewer1 не получилось обработать заказ, попробуй ещё раз чуть позже');
  } finally {
    unsubscribe();
  }
});

test('не удалось сменить статус в Twitch — в чате честно сказано, что баллы вернут вручную', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg } = makeCfg({ failStatusUpdate: true });
  try {
    await handleRedemption(makeRedemption({ userInput: 'включи битлз' }), cfg, fakeFetch({ followedDaysAgo: 10 }));
    assert.match(replies[0], /стример вернёт их вручную/);
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: заказ модератора/VIP встаёт в очередь, но активация отклоняется — баллы возвращаются', async () => {
  const { replies, unsubscribe } = collectReplies();
  const checked: string[] = [];
  const { cfg, statuses } = makeCfg({
    isPrivileged: async (userId) => {
      checked.push(userId);
      return true;
    },
  });
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.deepEqual(checked, ['viewer-1']);
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(peekNextPending()?.requestedById, 'viewer-1');
    assert.equal(peekNextPending()?.redemptionId, null, 'активация отвязана — потом её не тронут');
    assert.match(replies[0], /@Viewer1 трек добавлен в очередь.*Cool video.*позиция 1/s);
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: обычный зритель платит как раньше (активация ждёт, пока трек зазвучит)', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg({ isPrivileged: async () => false });
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.deepEqual(statuses, []);
    assert.equal(peekNextPending()?.redemptionId, 'red-1');
    assert.match(replies[0], /трек добавлен в очередь/);
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: стример бесплатно без запроса к Twitch', async () => {
  const { unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg({
    isPrivileged: async () => {
      throw new Error('для стримера проверка роли не нужна');
    },
  });
  try {
    await handleRedemption(
      makeRedemption({ userId: 'broadcaster-1' }),
      cfg,
      fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }),
    );
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.ok(peekNextPending());
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: роль узнать не удалось — заказ платный (ждёт звука), трек в очереди', async () => {
  const { unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg({
    isPrivileged: async () => {
      throw new Error('Twitch недоступен');
    },
  });
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.deepEqual(statuses, []);
    assert.equal(peekNextPending()?.redemptionId, 'red-1');
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: отказ модератору — роль не проверяется, CANCELED как обычно', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg({
    isPrivileged: async () => {
      throw new Error('при отказе проверка роли не нужна');
    },
  });
  try {
    await handleRedemption(makeRedemption({ userInput: 'включи битлз' }), cfg, fakeFetch({ followedDaysAgo: 10 }));
    assert.deepEqual(statuses, [{ id: 'red-1', status: 'CANCELED' }]);
    assert.equal(replies[0], '@Viewer1 ссылка невалидная — принимаются ссылки на YouTube');
  } finally {
    unsubscribe();
  }
});

test('Privilege-режим: не удалось вернуть баллы модератору — в чате сказано, что вернут вручную', async () => {
  const { replies, unsubscribe } = collectReplies();
  const { cfg } = makeCfg({ failStatusUpdate: true, isPrivileged: async () => true });
  try {
    await handleRedemption(makeRedemption(), cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
    assert.match(replies[0], /трек добавлен в очередь.*стример вернёт их вручную/s);
  } finally {
    unsubscribe();
  }
});

test('registerPointsRequestHandler подключает обработчик к событию channel_points.redeemed', async () => {
  const { unsubscribe } = collectReplies();
  const { cfg, statuses } = makeCfg();
  const unregister = registerPointsRequestHandler(cfg, fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }));
  try {
    eventBus.emit('channel_points.redeemed', makeRedemption());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(peekNextPending()?.redemptionId, 'red-1', 'заказ встал в очередь вместе с активацией');
    assert.deepEqual(statuses, []);
  } finally {
    unregister();
    unsubscribe();
  }
});

test('режим баллов: команда !sr ничего не заказывает, а подсказывает награду', async () => {
  const { replies, unsubscribe } = collectReplies();
  try {
    await handleChatMessage(
      {
        userId: 'viewer-1',
        login: 'viewer1',
        displayName: 'Viewer1',
        text: '!sr https://youtu.be/dQw4w9WgXcQ',
        isModerator: false,
        isBroadcaster: false,
      },
      { ...requestCfg, getPointsRewardTitle: () => 'Заказ музыки' },
      fakeFetch({ followedDaysAgo: 10, youtubeDurationIso: 'PT3M0S' }),
    );
    assert.equal(peekNextPending(), undefined);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /за баллы канала, награда "Заказ музыки"/);
  } finally {
    unsubscribe();
  }
});
