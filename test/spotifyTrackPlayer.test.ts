import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameSong, playSpotifyTrack, type SpotifyPlayerApi } from '../src/music/spotifyTrackPlayer.ts';

type State = {
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUri: string | null;
  trackTitle?: string | null;
  trackArtist?: string | null;
} | null;
/** 'error' — эмуляция сетевого сбоя при опросе. */
type Step = State | 'error';

const URI = 'spotify:track:ours';
const OPTS = { pollIntervalMs: 2, startPollIntervalMs: 1 };

const playing = (progressMs: number, durationMs = 200_000, trackUri = URI): State => ({
  isPlaying: true,
  progressMs,
  durationMs,
  trackUri,
});

/** Spotify, отвечающий на опросы по сценарию (последний шаг повторяется). */
function scripted(steps: Step[]): SpotifyPlayerApi & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    async getCurrentPlayback() {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step === 'error') throw new Error('fetch failed');
      return step;
    },
    async playTrackUri(uri) {
      calls.push(`play ${uri}`);
    },
    async skipToNext() {
      calls.push('next');
    },
  };
}

test('обычный трек: запускается, играет до конца и не обрезается раньше последних секунд', async () => {
  const spotify = scripted([
    playing(0), // старт подтверждён
    playing(100_000), // середина — ждём дальше
    playing(198_500), // осталось 1.5 с — доигрываем по часам
  ]);
  await playSpotifyTrack(spotify, URI, OPTS).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`]);
});

test('трек не считается законченным, пока до конца далеко (нет ранних обрывов)', async () => {
  // 20 опросов посреди трека, затем Spotify ушёл на другой трек.
  const steps: Step[] = [playing(0)];
  for (let k = 1; k <= 20; k++) steps.push(playing(k * 1000));
  steps.push(playing(0, 200_000, 'spotify:track:next'));
  const spotify = scripted(steps);
  let polls = 0;
  const counting: SpotifyPlayerApi = {
    ...spotify,
    getCurrentPlayback: async () => {
      polls++;
      return spotify.getCurrentPlayback();
    },
  };
  await playSpotifyTrack(counting, URI, OPTS).finished;
  assert.equal(polls, 22);
});

test('в очереди Spotify застрял чужой трек — плеер жмёт "следующий", пока не заиграет наш', async () => {
  const foreign = playing(1000, 200_000, 'spotify:track:stale');
  const spotify = scripted([foreign, foreign, foreign, playing(0), playing(199_000)]);
  await playSpotifyTrack(spotify, URI, OPTS).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`, 'next']);
});

test('Spotify ничего не играет после запуска — через несколько опросов запуск повторяется', async () => {
  const spotify = scripted([null, null, null, null, playing(0), playing(199_000)]);
  await playSpotifyTrack(spotify, URI, OPTS).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`, `play ${URI}`]);
});

test('трек так и не заиграл — ошибка (оркестратор перейдёт к следующему)', async () => {
  const spotify = scripted([null]);
  await assert.rejects(playSpotifyTrack(spotify, URI, OPTS).finished, /так и не начал играть/);
});

test('ручная пауза посреди трека — не конец, ждём; конец — когда Spotify ушёл на другой трек', async () => {
  const paused: State = { isPlaying: false, progressMs: 50_000, durationMs: 200_000, trackUri: URI };
  const spotify = scripted([playing(0), paused, paused, paused, playing(60_000), null]);
  let polls = 0;
  const counting: SpotifyPlayerApi = {
    ...spotify,
    getCurrentPlayback: async () => {
      polls++;
      return spotify.getCurrentPlayback();
    },
  };
  await playSpotifyTrack(counting, URI, OPTS).finished;
  assert.equal(polls, 6);
});

test('Spotify остановился в конце трека (пауза на нуле) — трек закончился', async () => {
  const stoppedAtZero: State = { isPlaying: false, progressMs: 0, durationMs: 200_000, trackUri: URI };
  const spotify = scripted([playing(0), playing(100_000), stoppedAtZero]);
  await playSpotifyTrack(spotify, URI, OPTS).finished;
});

test('единичные сетевые сбои терпятся; пять подряд — ошибка', async () => {
  const flaky = scripted([playing(0), 'error', 'error', playing(100_000), playing(199_000)]);
  await playSpotifyTrack(flaky, URI, OPTS).finished;

  const dead = scripted([playing(0), 'error']);
  await assert.rejects(playSpotifyTrack(dead, URI, OPTS).finished, /перестал отвечать/);
});

test('stop() (скип) сразу завершает ожидание, даже при длинном интервале опроса', async () => {
  const spotify = scripted([playing(0), playing(10_000)]);
  const session = playSpotifyTrack(spotify, URI, { pollIntervalMs: 60_000, startPollIntervalMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  session.stop();
  await session.finished;
  assert.ok(Date.now() - started < 1000);
});

test('следующий трек в очереди Spotify (prepareNext → true): плеер не обрывает трек, а ждёт, пока Spotify переключится сам', async () => {
  const spotify = scripted([
    playing(0),
    playing(190_000), // осталось 10 с — пора ставить следующий в очередь
    playing(190_500),
    playing(199_000),
    playing(199_900),
    playing(0, 200_000, 'spotify:track:next'), // Spotify сам перешёл на следующий
  ]);
  let prepares = 0;
  let polls = 0;
  const counting: SpotifyPlayerApi = {
    ...spotify,
    getCurrentPlayback: async () => {
      polls++;
      return spotify.getCurrentPlayback();
    },
  };
  await playSpotifyTrack(counting, URI, {
    ...OPTS,
    prepareNext: async () => {
      prepares++;
      return true;
    },
  }).finished;
  assert.equal(prepares, 1);
  assert.equal(polls, 6, 'трек закончился только когда Spotify ушёл на следующий');
  assert.deepEqual(spotify.calls, [`play ${URI}`]);
});

test('следующий трек не из Spotify (prepareNext → false): трек доигрывается по часам', async () => {
  const spotify = scripted([playing(0), playing(190_000), playing(199_500)]);
  let prepares = 0;
  await playSpotifyTrack(spotify, URI, {
    ...OPTS,
    prepareNext: async () => {
      prepares++;
      return false;
    },
  }).finished;
  assert.equal(prepares, 1);
  assert.deepEqual(spotify.calls, [`play ${URI}`]);
});

test('трек из очереди Spotify (queued): Spotify уже играет его — ни "play", ни "next"', async () => {
  const spotify = scripted([playing(0), playing(199_500)]);
  await playSpotifyTrack(spotify, URI, { ...OPTS, queued: true }).finished;
  assert.deepEqual(spotify.calls, []);
});

test('трек из очереди Spotify, а прошлый скипнули посреди — один "следующий"', async () => {
  const spotify = scripted([playing(50_000, 200_000, 'spotify:track:prev'), playing(0), playing(199_500)]);
  await playSpotifyTrack(spotify, URI, { ...OPTS, queued: true }).finished;
  assert.deepEqual(spotify.calls, ['next']);
});

test('трек из очереди Spotify, а прошлый ещё в самом конце — ждём, пока Spotify переключится сам', async () => {
  const prevAtEnd: State = { isPlaying: false, progressMs: 199_800, durationMs: 200_000, trackUri: 'spotify:track:prev' };
  const spotify = scripted([prevAtEnd, playing(0), playing(199_500)]);
  await playSpotifyTrack(spotify, URI, { ...OPTS, queued: true }).finished;
  assert.deepEqual(spotify.calls, []);
});

test('играет не тот трек — диагностика (что играет, очередь) вызывается для лога, поведение то же', async () => {
  const foreign = playing(1000, 200_000, 'spotify:track:stale');
  const spotify = scripted([foreign, foreign, playing(0), playing(199_000)]);
  const diagnosed: string[] = [];
  const withDiagnose: SpotifyPlayerApi = {
    ...spotify,
    diagnosePlayback: async (expected) => {
      diagnosed.push(expected);
      throw new Error('сбой диагностики не должен мешать');
    },
  };
  await playSpotifyTrack(withDiagnose, URI, OPTS).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`, 'next']);
  assert.deepEqual(diagnosed, [URI]);
});

test('Spotify играет ту же песню под другим id (альбом вместо сингла) — это наш трек: без скипов, конец по реальному id', async () => {
  const album = (progressMs: number): State => ({
    ...playing(progressMs, 200_000, 'spotify:track:album')!,
    trackTitle: 'When You Were Young',
    trackArtist: 'The Killers',
  });
  const steps: Step[] = [album(0), album(100_000), playing(0, 200_000, 'spotify:track:next')];
  const spotify = scripted(steps);
  let polls = 0;
  const counting: SpotifyPlayerApi = {
    ...spotify,
    getCurrentPlayback: async () => {
      polls++;
      return spotify.getCurrentPlayback();
    },
  };
  await playSpotifyTrack(counting, URI, { ...OPTS, expected: { title: 'When You Were Young', artist: 'The Killers' } }).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`]);
  assert.equal(polls, 3); // доиграл до перехода Spotify на следующий трек, а не закончился сразу
});

test('другая песня того же исполнителя — по-прежнему чужой трек, плеер жмёт "следующий"', async () => {
  const other: State = { ...playing(1000, 200_000, 'spotify:track:other')!, trackTitle: 'Mr. Brightside', trackArtist: 'The Killers' };
  const spotify = scripted([other, other, playing(0), playing(199_000)]);
  await playSpotifyTrack(spotify, URI, { ...OPTS, expected: { title: 'When You Were Young', artist: 'The Killers' } }).finished;
  assert.deepEqual(spotify.calls, [`play ${URI}`, 'next']);
});

test('isSameSong: уточнения версии в названии не мешают, исполнитель сравнивается по первому', () => {
  const expected = { title: 'Master Of Puppets (Remastered)', artist: 'Metallica' };
  assert.ok(isSameSong({ trackTitle: 'Master of Puppets - Remastered 2017', trackArtist: 'Metallica, Someone' }, expected));
  assert.ok(isSameSong({ trackTitle: 'Master Of Puppets', trackArtist: 'metallica' }, expected));
  assert.ok(!isSameSong({ trackTitle: 'Battery', trackArtist: 'Metallica' }, expected));
  assert.ok(!isSameSong({ trackTitle: 'Master Of Puppets', trackArtist: 'Apocalyptica' }, expected));
  assert.ok(!isSameSong({ trackTitle: null, trackArtist: 'Metallica' }, expected));
});
