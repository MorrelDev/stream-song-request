import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpotifyPlaylistUri, SPOTIFY_TOP_TRACKS } from '../src/music/spotifyPlaylistUri.ts';

test('принимает обычную ссылку-шаринг с ?si=...', () => {
  const result = normalizeSpotifyPlaylistUri(
    'https://open.spotify.com/playlist/0iHSvFHgT4iarY5QfK7rLR?si=xYParKgnSaiDCYaBqBC3Ew',
  );
  assert.equal(result, 'spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
});

test('принимает ссылку без ?si=', () => {
  const result = normalizeSpotifyPlaylistUri('https://open.spotify.com/playlist/0iHSvFHgT4iarY5QfK7rLR');
  assert.equal(result, 'spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
});

test('принимает уже готовый spotify:playlist: URI без изменений', () => {
  const result = normalizeSpotifyPlaylistUri('spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
  assert.equal(result, 'spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
});

test('принимает голый id плейлиста', () => {
  const result = normalizeSpotifyPlaylistUri('0iHSvFHgT4iarY5QfK7rLR');
  assert.equal(result, 'spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
});

test('обрезает пробелы по краям', () => {
  const result = normalizeSpotifyPlaylistUri('  spotify:playlist:0iHSvFHgT4iarY5QfK7rLR  ');
  assert.equal(result, 'spotify:playlist:0iHSvFHgT4iarY5QfK7rLR');
});

test('бросает понятную ошибку на нераспознанное значение', () => {
  assert.throws(() => normalizeSpotifyPlaylistUri('https://example.com/not-a-playlist'), /не удалось распознать/);
  assert.throws(() => normalizeSpotifyPlaylistUri(''), /не удалось распознать/);
});

test('TOP (в любом регистре) — топ-треки вместо плейлиста', () => {
  assert.equal(normalizeSpotifyPlaylistUri('TOP'), SPOTIFY_TOP_TRACKS);
  assert.equal(normalizeSpotifyPlaylistUri(' top '), SPOTIFY_TOP_TRACKS);
});
