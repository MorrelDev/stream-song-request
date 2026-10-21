import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eventBus } from '../src/core/eventBus.ts';
import { initDb } from '../src/db/index.ts';
import {
  enqueueSongRequest,
  markDone,
  markPlaying,
  pendingRedemptionIds,
  peekNextPending,
} from '../src/db/musicQueue.ts';
import { settleRequestRedemption } from '../src/music/pointsMode.ts';
import { PlaybackOrchestrator, type YoutubePlayerLike } from '../src/music/playbackOrchestrator.ts';
import type { SongRequestFinishedEvent } from '../src/core/events.ts';

beforeEach(() => {
  initDb(':memory:');
});

const track = (redemptionId: string | null) => ({
  provider: 'youtube' as const,
  externalId: 'x',
  playUri: 'https://yt/x',
  title: 'Song',
  author: 'Ch',
  durationSec: 100,
  requestedById: 'u1',
  requestedByLogin: 'viewer1',
  redemptionId,
  rewardId: redemptionId ? 'rew-1' : null,
});

test('активация записывается вместе с заказом; "ждущими" при старте считаются только pending', () => {
  const a = enqueueSongRequest(track('red-a'));
  enqueueSongRequest(track('red-b'));
  enqueueSongRequest(track(null));
  assert.equal(peekNextPending()?.redemptionId, 'red-a');
  assert.equal(peekNextPending()?.rewardId, 'rew-1');
  markPlaying(a.id);
  markDone(a.id);
  assert.deepEqual(pendingRedemptionIds(), ['red-b']);
});

const finished = (audioStarted: boolean, redemptionId: string | null = 'red-1'): SongRequestFinishedEvent => ({
  requestId: 1,
  title: 'Song',
  requestedByLogin: 'viewer1',
  redemptionId,
  rewardId: redemptionId ? 'rew-1' : null,
  audioStarted,
});

async function settle(e: SongRequestFinishedEvent) {
  const calls: string[] = [];
  const replies: string[] = [];
  const onReply = (r: { text: string }) => replies.push(r.text);
  eventBus.on('chat.reply', onReply);
  try {
    await settleRequestRedemption(e, async (rewardId, redemptionId, status) => {
      calls.push(`${rewardId}/${redemptionId}/${status}`);
    });
  } finally {
    eventBus.off('chat.reply', onReply);
  }
  return { calls, replies };
}

test('settleRequestRedemption: звук пошёл — FULFILLED, в чат ничего', async () => {
  const { calls, replies } = await settle(finished(true));
  assert.deepEqual(calls, ['rew-1/red-1/FULFILLED']);
  assert.deepEqual(replies, []);
});

test('settleRequestRedemption: не запустился — CANCELED (возврат баллов) и объяснение в чат', async () => {
  const { calls, replies } = await settle(finished(false));
  assert.deepEqual(calls, ['rew-1/red-1/CANCELED']);
  assert.deepEqual(replies, ['@viewer1 не получилось включить "Song" — баллы вернул']);
});

test('settleRequestRedemption: заказ командой !sr (без активации) — ничего не делает', async () => {
  const { calls, replies } = await settle(finished(false, null));
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

/** Оркестратор с одним заказом и mpv, который либо начинает играть, либо падает до звука. */
async function playOneRequest(behaviour: 'audio' | 'fail'): Promise<SongRequestFinishedEvent> {
  enqueueSongRequest(track('red-1'));
  const mpv: YoutubePlayerLike = {
    play: () =>
      behaviour === 'fail'
        ? { finished: Promise.reject(new Error('yt-dlp не смог')), stop: () => {}, audioStarted: new Promise<void>(() => {}) }
        : { finished: new Promise<void>((r) => setTimeout(r, 20)), stop: () => {}, audioStarted: Promise.resolve() },
  };
  const orchestrator = new PlaybackOrchestrator(
    null,
    mpv,
    { peekNextPending, markPlaying, markDone },
    { peekNext: () => undefined, remove: () => {}, replaceAll: () => {} },
    null,
    { pollIntervalMs: 5, shuffleDefaultPlaylist: false },
  );
  let onFinished!: (e: SongRequestFinishedEvent) => void;
  const event = new Promise<SongRequestFinishedEvent>((resolve) => (onFinished = resolve));
  eventBus.on('song.request_finished', onFinished);
  const done = orchestrator.start();
  try {
    return await event;
  } finally {
    eventBus.off('song.request_finished', onFinished);
    orchestrator.stop();
    await done;
  }
}

test('оркестратор: заказ зазвучал — song.request_finished с audioStarted=true и активацией из базы', async () => {
  const e = await playOneRequest('audio');
  assert.equal(e.audioStarted, true);
  assert.equal(e.redemptionId, 'red-1');
  assert.equal(e.rewardId, 'rew-1');
});

test('оркестратор: yt-dlp упал до звука — song.request_finished с audioStarted=false', async () => {
  const e = await playOneRequest('fail');
  assert.equal(e.audioStarted, false);
  assert.equal(e.redemptionId, 'red-1');
});

test('бесплатный заказ (Privilege-режим): активация отвязана — по окончании трека её не трогают', async () => {
  const { getRequestRedemption, detachRedemption } = await import('../src/db/musicQueue.ts');
  const { id } = enqueueSongRequest(track('red-free'));
  assert.deepEqual(getRequestRedemption(id), { redemptionId: 'red-free', rewardId: 'rew-1' });
  detachRedemption(id);
  assert.equal(getRequestRedemption(id), null);
  assert.deepEqual(pendingRedemptionIds(), [], 'и при старте её не считают ждущей');
});
