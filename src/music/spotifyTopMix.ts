import type { SpotifyPlaylistTrack } from './spotifyProvider.ts';
import { shuffled } from './playbackOrchestrator.ts';

/** Минимум того, что нужно от контроллера для микса (удобно подменять в тестах). */
export interface SpotifyTopTracksSource {
  fetchTopTracks(timeRange: 'short_term' | 'medium_term' | 'long_term'): Promise<SpotifyPlaylistTrack[]>;
}

/**
 * Объединяет несколько топов в равных долях без дублей: по кругу каждый топ
 * добавляет свой следующий трек, которого ещё нет в результате. Как только у
 * любого топа кончились новые треки — стоп, иначе доли перестанут быть
 * равными. Сначала отбираем уникальные, потом считаем доли — а не наоборот:
 * short_term во многом совпадает с long_term, и после удаления дублей его
 * доля иначе бы "съедалась". Пустые топы (мало истории за период) не
 * учитываются.
 */
export function mixTopTracksEqually(lists: SpotifyPlaylistTrack[][]): SpotifyPlaylistTrack[] {
  const sources = lists.filter((l) => l.length > 0);
  const positions = sources.map(() => 0);
  const seen = new Set<string>();
  const result: SpotifyPlaylistTrack[] = [];

  for (;;) {
    const round: SpotifyPlaylistTrack[] = [];
    for (let i = 0; i < sources.length; i++) {
      const list = sources[i];
      while (positions[i] < list.length && seen.has(list[positions[i]].uri)) positions[i]++;
      if (positions[i] >= list.length) return result;
      const track = list[positions[i]++];
      seen.add(track.uri);
      round.push(track);
    }
    if (round.length === 0) return result;
    result.push(...round);
  }
}

/**
 * "Свой микс дня" для SPOTIFY_DEFAULT_PLAYLIST_URI=TOP: топ-треки за год
 * (long_term), полгода (medium_term) и месяц (short_term) — в равных долях,
 * без дублей, перемешанные (независимо от DEFAULT_PLAYLIST_SHUFFLE).
 */
export async function loadSpotifyTopMix(
  source: SpotifyTopTracksSource,
  random: () => number = Math.random,
): Promise<SpotifyPlaylistTrack[]> {
  const lists = await Promise.all([
    source.fetchTopTracks('long_term'),
    source.fetchTopTracks('medium_term'),
    source.fetchTopTracks('short_term'),
  ]);
  const mix = mixTopTracksEqually(lists);
  if (mix.length === 0) {
    throw new Error('Spotify вернул пустые топ-треки — аккаунту не хватает истории прослушиваний для TOP.');
  }
  return shuffled(mix, random);
}
