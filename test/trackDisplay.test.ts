import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanYoutubeTitle, toTrackDisplay } from '../src/overlay/trackDisplay.ts';

test('cleanYoutubeTitle: "Исполнитель - Название (Official Video)" делится, приписка вырезается', () => {
  assert.deepEqual(
    cleanYoutubeTitle('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley'),
    { artist: 'Rick Astley', title: 'Never Gonna Give You Up' },
  );
});

test('cleanYoutubeTitle: квадратные скобки, длинное тире, feat. остаётся', () => {
  assert.deepEqual(cleanYoutubeTitle('Daft Punk — Get Lucky (feat. Pharrell Williams) [Official Audio]', 'DaftPunkVEVO'), {
    artist: 'Daft Punk',
    title: 'Get Lucky (feat. Pharrell Williams)',
  });
});

test('cleanYoutubeTitle: русские приписки', () => {
  assert.deepEqual(cleanYoutubeTitle('Кино - Группа крови (Официальный клип)', 'Кино'), {
    artist: 'Кино',
    title: 'Группа крови',
  });
});

test('cleanYoutubeTitle: без разделителя исполнитель берётся из канала без " - Topic"/VEVO', () => {
  assert.deepEqual(cleanYoutubeTitle('Thunder', 'Skott - Topic'), { artist: 'Skott', title: 'Thunder' });
  assert.deepEqual(cleanYoutubeTitle('Thunder (Lyrics)', 'SkottVEVO'), { artist: 'Skott', title: 'Thunder' });
});

test('cleanYoutubeTitle: если вырезать нечего — название как есть', () => {
  assert.deepEqual(cleanYoutubeTitle('(Official Video)', 'Channel'), { artist: 'Channel', title: '(Official Video)' });
});

test('toTrackDisplay: Spotify и Яндекс не трогаются', () => {
  assert.deepEqual(toTrackDisplay('spotify', 'Thunder - Live (Official)', 'Skott'), {
    title: 'Thunder - Live (Official)',
    artist: 'Skott',
  });
});
