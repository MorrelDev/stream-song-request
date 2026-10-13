import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkipVoteTracker } from '../src/music/skipVoteTracker.ts';

const cfg = { thresholdPercent: 30 };

test('computeRequired — округление вверх (30% от 3 зрителей = 0.9 → нужен хотя бы 1)', () => {
  const tracker = new SkipVoteTracker(cfg);
  assert.equal(tracker.computeRequired(3), 1);
});

test('computeRequired растёт вместе с числом зрителей (30% от 10 = 3)', () => {
  const tracker = new SkipVoteTracker(cfg);
  assert.equal(tracker.computeRequired(10), 3);
});

test('computeRequired никогда не меньше 1, даже если зрителей 0', () => {
  const tracker = new SkipVoteTracker(cfg);
  assert.equal(tracker.computeRequired(0), 1);
});

test('requiredVotes — null, пока порог не зафиксирован', () => {
  const tracker = new SkipVoteTracker(cfg);
  assert.equal(tracker.requiredVotes(), null);
  assert.throws(() => tracker.vote('u0'));
});

test('vote() возвращает passed только когда порог достигнут', () => {
  const tracker = new SkipVoteTracker(cfg);
  tracker.lockThreshold(10); // нужно 3 голоса

  assert.equal(tracker.vote('u0'), 'counted');
  assert.equal(tracker.vote('u1'), 'counted');
  assert.equal(tracker.vote('u2'), 'passed');
});

test('после достижения порога голоса возвращают closed — трек не скипается дважды', () => {
  const tracker = new SkipVoteTracker(cfg);
  tracker.lockThreshold(3); // нужен 1 голос

  assert.equal(tracker.vote('u0'), 'passed');
  assert.equal(tracker.vote('u1'), 'closed');
  assert.equal(tracker.voteCount, 1);
});

test('повторный голос того же пользователя не засчитывается дважды', () => {
  const tracker = new SkipVoteTracker(cfg);
  tracker.lockThreshold(10);

  tracker.vote('u0');
  tracker.vote('u0');
  tracker.vote('u0');
  assert.equal(tracker.voteCount, 1);
});

test('порог фиксируется один раз — повторный lockThreshold его не меняет', () => {
  const tracker = new SkipVoteTracker(cfg);
  tracker.lockThreshold(10);
  tracker.lockThreshold(100);
  assert.equal(tracker.requiredVotes(), 3);
});

test('resetVotes() очищает голоса и снимает фиксацию порога', () => {
  const tracker = new SkipVoteTracker(cfg);
  tracker.lockThreshold(10);
  tracker.vote('u1');

  tracker.resetVotes();
  assert.equal(tracker.voteCount, 0);
  assert.equal(tracker.requiredVotes(), null);
  tracker.lockThreshold(20);
  assert.equal(tracker.requiredVotes(), 6);
});
