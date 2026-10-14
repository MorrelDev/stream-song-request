import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { registerSkipVoteHandler, type SkipableOrchestrator } from '../src/music/skipVoteHandler.ts';
import type { ChatMessageEvent } from '../src/core/events.ts';

// 10 зрителей на стриме — при пороге 30% нужно 3 голоса.
const cfg = {
  commandName: '!skip',
  thresholdPercent: 30,
  moderatorCanSkip: false,
  requesterCanSkipOwnRequest: false,
  getViewerCount: async (): Promise<number | null> => 10,
};

/** Даёт асинхронной обработке !skip (запрос числа зрителей) завершиться. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeOrchestrator implements SkipableOrchestrator {
  mode: 'default' | 'request' = 'request';
  skipCalls = 0;
  skipDefaultPlaylistCalls = 0;
  /** Эмулирует "нечего скипать" в дефолтном режиме, например Spotify не настроен. */
  defaultPlaylistSkippable = true;

  getMode(): 'default' | 'request' {
    return this.mode;
  }

  skip(): boolean {
    this.skipCalls += 1;
    return this.mode === 'request';
  }

  skipDefaultPlaylist(): boolean {
    this.skipDefaultPlaylistCalls += 1;
    return this.mode === 'default' && this.defaultPlaylistSkippable;
  }
}

function makeMsg(overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    userId: 'viewer-1',
    login: 'viewer1',
    displayName: 'Viewer1',
    text: '!skip',
    isModerator: false,
    isBroadcaster: false,
    ...overrides,
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

test('broadcaster скипает трек сразу, без учёта порога голосования', async () => {
  const orchestrator = new FakeOrchestrator();
  const { tracker: _tracker, unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    await flush();
    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies[0], /скипнут/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('модератор скипает заказ сразу, если это разрешено настройкой', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, moderatorCanSkip: true });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'mod-1', isModerator: true }));
    await flush();
    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies[0], /скипнут по команде модератора/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('по умолчанию !skip модератора на заказе — обычный голос', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'mod-1', isModerator: true }));
    await flush();
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies[0], /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('по умолчанию !skip модератора на треке дефолтного плейлиста — обычный голос', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'mod-1', isModerator: true }));
    await flush();
    assert.equal(orchestrator.skipDefaultPlaylistCalls, 0);
    assert.match(replies[0], /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('модератор скипает трек дефолтного плейлиста сразу, если это разрешено настройкой', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, moderatorCanSkip: true });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'mod-1', isModerator: true }));
    await flush();
    assert.equal(orchestrator.skipDefaultPlaylistCalls, 1);
    assert.match(replies[0], /скипнут по команде модератора/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('одного голоса зрителя недостаточно, если зрителей много', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('после накопления достаточного числа голосов трек скипается', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут голосованием \(3\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('broadcaster скипает трек дефолтного плейлиста сразу, без учёта порога голосования', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    await flush();
    assert.equal(orchestrator.skipDefaultPlaylistCalls, 1);
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies[0], /скипнут по команде стримера/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('зрители могут скипнуть трек дефолтного плейлиста голосованием, как и заказ', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipDefaultPlaylistCalls, 1);
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /скипнут голосованием \(3\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('заказчик текущего заказа не имеет мгновенного скипа над треками дефолтного плейлиста (у них нет заказчика)', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, requesterCanSkipOwnRequest: true });
  const { replies, unsubscribe } = collectReplies();
  try {
    // Раньше 'viewer-1' заказывал трек — но сейчас играет дефолтный плейлист,
    // мгновенного скипа быть не должно, только обычное голосование.
    eventBus.emit('song.now_playing', { title: 'First', provider: 'youtube', requestedById: 'viewer-1' });

    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.equal(orchestrator.skipDefaultPlaylistCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('дефолтный плейлист нечего скипать (например Spotify не настроен) — понятный ответ, а не тишина', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  orchestrator.defaultPlaylistSkippable = false;
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ isBroadcaster: true }));
    await flush();
    assert.equal(orchestrator.skipDefaultPlaylistCalls, 1);
    assert.match(replies[0], /нечего скипать/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('song.now_playing для трека дефолтного плейлиста тоже сбрасывает накопленные голоса', async () => {
  const orchestrator = new FakeOrchestrator();
  orchestrator.mode = 'default';
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));
    await flush();

    // Дефолтный плейлист сам переключился на новый трек — голоса за предыдущий должны сброситься.
    eventBus.emit('song.now_playing', { title: 'Next default track', provider: 'spotify', requestedById: null });

    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipDefaultPlaylistCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('song.now_playing сбрасывает накопленные голоса — старые голоса не переносятся на новый трек', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' }));
    await flush();

    // Новый трек начал играть — голоса за предыдущий должны сброситься.
    eventBus.emit('song.now_playing', { title: 'Next', provider: 'youtube', requestedById: 'nobody' });

    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));
    await flush();

    // Если бы голоса не сбросились, u0+u1+u2 = 3 голоса уже хватило бы раньше.
    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('зритель, заказавший текущий трек, скипает его сразу, если это разрешено настройкой', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, requesterCanSkipOwnRequest: true });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'Requester track', provider: 'youtube', requestedById: 'viewer-1' });

    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут.*твой заказ/s);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('по умолчанию !skip заказчика на своём заказе — обычный голос', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'Requester track', provider: 'youtube', requestedById: 'viewer-1' });

    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('зритель, который трек НЕ заказывал, не может скипнуть его сразу — обычное голосование', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'Someone else track', provider: 'youtube', requestedById: 'author-1' });

    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('право мгновенного скипа не переносится на следующий трек, если его заказал кто-то другой', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, requesterCanSkipOwnRequest: true });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('song.now_playing', { title: 'First', provider: 'youtube', requestedById: 'viewer-1' });
    eventBus.emit('song.now_playing', { title: 'Second', provider: 'youtube', requestedById: 'someone-else' });

    // viewer-1 заказывал предыдущий (First), а не текущий (Second) трек —
    // мгновенного скипа для него больше нет, только обычное голосование.
    eventBus.emit('chat.message', makeMsg({ userId: 'viewer-1', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.match(replies.at(-1) ?? '', /голос за скип принят/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('повторный !skip того же зрителя не учитывается дважды', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, cfg);
  const { unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('число зрителей запрашивается один раз на трек — порог не меняется от голоса к голосу', async () => {
  const orchestrator = new FakeOrchestrator();
  let calls = 0;
  let viewers = 10;
  const { unregister } = registerSkipVoteHandler(orchestrator, {
    ...cfg,
    getViewerCount: async () => {
      calls += 1;
      return viewers;
    },
  });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('chat.message', makeMsg({ userId: 'u1', text: '!skip' })); // пока первый запрос в полёте
    await flush();
    viewers = 100; // зрителей стало больше — на текущий трек это уже не влияет
    eventBus.emit('chat.message', makeMsg({ userId: 'u2', text: '!skip' }));
    await flush();

    assert.equal(calls, 1);
    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут голосованием \(3\/3\)/);

    // Новый трек — порог считается заново.
    eventBus.emit('song.now_playing', { title: 'Next', provider: 'youtube', requestedById: null });
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    assert.equal(calls, 2);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/30\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('стрим оффлайн — для скипа достаточно одного голоса', async () => {
  const orchestrator = new FakeOrchestrator();
  const { unregister } = registerSkipVoteHandler(orchestrator, { ...cfg, getViewerCount: async () => null });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    assert.equal(orchestrator.skipCalls, 1);
    assert.match(replies.at(-1) ?? '', /скипнут голосованием \(1\/1\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('Twitch не ответил — голос не засчитан, следующий !skip запрашивает число зрителей снова', async () => {
  const orchestrator = new FakeOrchestrator();
  let calls = 0;
  const { unregister } = registerSkipVoteHandler(orchestrator, {
    ...cfg,
    getViewerCount: async () => {
      calls += 1;
      if (calls === 1) throw new Error('HTTP 500');
      return 10;
    },
  });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    assert.match(replies.at(-1) ?? '', /не удалось узнать число зрителей/);

    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    await flush();
    assert.equal(calls, 2);
    assert.match(replies.at(-1) ?? '', /голос за скип принят \(1\/3\)/);
  } finally {
    unsubscribe();
    unregister();
  }
});

test('трек сменился, пока ждали число зрителей — голос не переносится на новый трек', async () => {
  const orchestrator = new FakeOrchestrator();
  let resolveViewers: (n: number) => void = () => {};
  const { tracker, unregister } = registerSkipVoteHandler(orchestrator, {
    ...cfg,
    getViewerCount: () => new Promise<number>((resolve) => (resolveViewers = resolve)),
  });
  const { replies, unsubscribe } = collectReplies();
  try {
    eventBus.emit('chat.message', makeMsg({ userId: 'u0', text: '!skip' }));
    eventBus.emit('song.now_playing', { title: 'Next', provider: 'youtube', requestedById: null });
    resolveViewers(1);
    await flush();

    assert.equal(orchestrator.skipCalls, 0);
    assert.equal(tracker.voteCount, 0);
    assert.equal(tracker.requiredVotes(), null);
    assert.equal(replies.length, 0);
  } finally {
    unsubscribe();
    unregister();
  }
});
