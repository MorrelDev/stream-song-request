import type { SongProvider } from '../core/events.ts';

/**
 * Как показывать трек на оверлее "сейчас играет": отдельно название и
 * исполнитель. У Spotify и Яндекса они и так раздельные, а у YouTube есть
 * только название видео и имя канала — их приходится разбирать.
 */

export interface TrackDisplay {
  title: string;
  artist: string;
}

// Приписки в скобках, которые ничего не говорят о треке: "(Official Video)",
// "[4K Remaster]", "(Lyrics)", "(Премьера клипа, 2024)" и т.п. Скобка
// вырезается целиком, если в ней есть хотя бы одно такое слово.
const JUNK_IN_BRACKETS_RE =
  /\s*[([【]([^)\]】]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|mv|m\/v|clip)\b[^)\]】]*|[^)\]】]*(клип|премьера|официальн|текст)[^)\]】]*)[)\]】]/giu;

// Хвост имени канала, который не является частью имени исполнителя.
const CHANNEL_SUFFIX_RE = /\s*(-\s*topic|vevo|official|music)\s*$/i;

/** "Rick Astley - Never Gonna Give You Up (Official Video)" -> исполнитель + название. */
export function cleanYoutubeTitle(videoTitle: string, channelTitle: string): TrackDisplay {
  const cleaned = videoTitle.replace(JUNK_IN_BRACKETS_RE, '').replace(/\s{2,}/g, ' ').trim() || videoTitle.trim();

  // Типичный формат музыкальных видео — "Исполнитель - Название" (бывает
  // с длинным тире или "–"). Делим по первому разделителю с пробелами вокруг.
  const dash = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };

  const artist = channelTitle.replace(CHANNEL_SUFFIX_RE, '').trim() || channelTitle.trim();
  return { artist, title: cleaned };
}

export function toTrackDisplay(provider: SongProvider, title: string, author: string): TrackDisplay {
  return provider === 'youtube' ? cleanYoutubeTitle(title, author) : { title, artist: author };
}
