import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixTopTracksEqually, loadSpotifyTopMix } from '../src/music/spotifyTopMix.ts';
import type { SpotifyPlaylistTrack } from '../src/music/spotifyProvider.ts';

const t = (id: string): SpotifyPlaylistTrack => ({ uri: `spotify:track:${id}`, title: id, artist: 'A', durationMs: 1000 });
const ids = (tracks: SpotifyPlaylistTrack[]) => tracks.map((x) => x.title);

test('mixTopTracksEqually: равные доли без дублей — дубль не съедает долю топа', () => {
  const long = [t('a'), t('b'), t('c'), t('d')];
  const medium = [t('a'), t('e'), t('f')];
  const short = [t('b'), t('g'), t('h'), t('i')];

  // раунд 1: a (long), e (medium — a уже взят), b (short)
  // раунд 2: c (long), f (medium), g (short)
  // раунд 3: d (long), у medium новых нет — стоп
  assert.deepEqual(ids(mixTopTracksEqually([long, medium, short])), ['a', 'e', 'b', 'c', 'f', 'g']);
});

test('mixTopTracksEqually: пустой топ не обнуляет микс', () => {
  assert.deepEqual(ids(mixTopTracksEqually([[t('a'), t('b')], [], [t('c')]])), ['a', 'c']);
  assert.deepEqual(mixTopTracksEqually([[], [], []]), []);
});

test('loadSpotifyTopMix: берёт три периода и перемешивает результат', async () => {
  const ranges: string[] = [];
  const source = {
    fetchTopTracks: async (range: string) => {
      ranges.push(range);
      return { long_term: [t('a'), t('b')], medium_term: [t('c'), t('d')], short_term: [t('e'), t('f')] }[range]!;
    },
  };

  const mix = await loadSpotifyTopMix(source, () => 0);

  assert.deepEqual(ranges.sort(), ['long_term', 'medium_term', 'short_term']);
  assert.deepEqual(ids(mix).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.notDeepEqual(ids(mix), ['a', 'c', 'e', 'b', 'd', 'f']);
});

test('loadSpotifyTopMix: все топы пустые — понятная ошибка', async () => {
  const source = { fetchTopTracks: async () => [] };
  await assert.rejects(() => loadSpotifyTopMix(source), /пустые топ-треки/);
});
