import test from 'node:test';
import assert from 'node:assert/strict';
import { searchItunes } from '../src/services/itunes.js';
import { searchDeezer } from '../src/services/deezer.js';
import { fetchLyrics, stripLrcTimestamps, extractComposerFromLyrics } from '../src/services/lyrics.js';
import { sanitizeFilename, formatDuration, resolveNamingFormat } from '../src/utils/formatters.js';

test('formatters: sanitizeFilename, formatDuration, and resolveNamingFormat', () => {
  assert.equal(sanitizeFilename('AC/DC - Back In Black: (Live)?*'), 'AC_DC - Back In Black_ (Live)__');
  assert.equal(formatDuration(185000), '3:05');
  assert.equal(formatDuration(61000), '1:01');

  // Test resolveNamingFormat with Navidrome standard template
  const p1 = resolveNamingFormat('{albumArtist}/{album}/{track} - {title}', {
    artist: 'Rick Astley',
    albumArtist: 'Rick Astley',
    album: 'Whenever You Need Somebody',
    track: 1,
    title: 'Never Gonna Give You Up',
    year: 1987
  });
  assert.equal(p1, 'Rick Astley/Whenever You Need Somebody/01 - Never Gonna Give You Up');

  // Test flat structure template
  const p2 = resolveNamingFormat('{artist} - {title}', {
    artist: 'Queen',
    title: 'Bohemian Rhapsody'
  });
  assert.equal(p2, 'Queen - Bohemian Rhapsody');
});

test('searchDeezer: should return valid ISRC, album, track position, and high-res cover', async () => {
  const meta = await searchDeezer('Never Gonna Give You Up', 'Rick Astley');
  assert.ok(meta, 'Should find Deezer metadata');
  assert.equal(meta.artist, 'Rick Astley');
  assert.ok(meta.isrc, 'Should have ISRC');
  assert.ok(meta.isrc.length >= 10, 'ISRC should be valid length');
  assert.ok(meta.album, 'Should have album title');
  assert.ok(meta.artworkUrl.includes('1000x1000') || meta.artworkUrl.includes('500x500'), 'Should have high-res artwork');
});

test('searchItunes: should enrich track with album, year, and high-res cover', async () => {
  const meta = await searchItunes('Shape of You', 'Ed Sheeran');
  assert.ok(meta, 'Should find iTunes metadata');
  assert.equal(meta.artist, 'Ed Sheeran');
  assert.ok(meta.album, 'Should have album name');
  assert.ok(meta.year >= 2017, 'Year should be 2017 or later');
  assert.ok(meta.artworkUrl.includes('1200x1200bb'), 'Artwork should be high resolution');
});

test('fetchLyrics & stripLrcTimestamps: should strip metadata headers and multi-timestamps', async () => {
  const lrcSample = `[ti:Never Gonna Give You Up]
[ar:Rick Astley]
[al:Whenever You Need Somebody]
[by:Stock Aitken Waterman]
[offset:0]
[00:00.00] 作曲 : Stock Aitken Waterman
[00:01.00][01:05.50]We're no strangers to love
[00:05.20]You know the rules and so do I`;

  const composer = extractComposerFromLyrics(lrcSample);
  assert.equal(composer, 'Stock Aitken Waterman', 'Should extract composer from lyrics');

  const plain = stripLrcTimestamps(lrcSample);
  assert.ok(!plain.includes('[ti:'), 'Plain lyrics should not include [ti: header');
  assert.ok(!plain.includes('[00:'), 'Plain lyrics should not contain timestamps');
  assert.ok(plain.includes("We're no strangers to love"), 'Should include actual lyric text');
  assert.ok(plain.includes("You know the rules and so do I"), 'Should include subsequent lyric text');

  const lyrics = await fetchLyrics('Shape of You', 'Ed Sheeran');
  assert.ok(lyrics.syncedLyrics.length > 0, 'Should find synced lyrics');
  assert.ok(lyrics.plainLyrics.length > 0, 'Should have plain lyrics');
});
