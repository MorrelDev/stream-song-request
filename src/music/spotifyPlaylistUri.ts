/**
 * Spotify то добавляет, то убирает пункт меню "Copy Spotify URI" в разных
 * версиях приложения — полагаться на него неудобно. Проще принимать то, что
 * реально доступно для копирования (ссылка вида
 * https://open.spotify.com/playlist/<id>?si=...), а также сам URI и голый id
 * плейлиста — и приводить всё это к единому виду spotify:playlist:<id>,
 * который требует Spotify Web API в параметре context_uri.
 */
/**
 * Особое значение SPOTIFY_DEFAULT_PLAYLIST_URI=TOP: вместо плейлиста играть
 * микс топ-треков пользователя за год, полгода и месяц (/me/top/tracks,
 * см. spotifyTopMix.ts) — "свой микс дня". Алгоритмические плейлисты Spotify (daylist, Daily Mix) Web API
 * приложениям в режиме разработки не отдаёт, см. fetchTopTracks.
 */
export const SPOTIFY_TOP_TRACKS = 'top';

export function normalizeSpotifyPlaylistUri(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.toLowerCase() === SPOTIFY_TOP_TRACKS) {
    return SPOTIFY_TOP_TRACKS;
  }

  if (trimmed.startsWith('spotify:playlist:')) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/);
    if (match) {
      return `spotify:playlist:${match[1]}`;
    }
  } catch {
    // не похоже на URL — возможно, это просто голый id плейлиста, см. ниже
  }

  if (/^[a-zA-Z0-9]{15,30}$/.test(trimmed)) {
    return `spotify:playlist:${trimmed}`;
  }

  throw new Error(
    `SPOTIFY_DEFAULT_PLAYLIST_URI: не удалось распознать плейлист в значении "${raw}". ` +
      'Подойдёт ссылка вида https://open.spotify.com/playlist/<id>, просто <id>, spotify:playlist:<id> ' +
        'или TOP (топ-треки аккаунта).',
  );
}
