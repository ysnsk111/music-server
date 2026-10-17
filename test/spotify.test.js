import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyInput, getPlaylist, getTrack } from '../src/services/spotify.js';

test('parseSpotifyInput: should correctly parse various Spotify URL and URI formats', () => {
  // Web playlist URL with query params
  const p1 = parseSpotifyInput('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1234567890abcdef');
  assert.equal(p1.type, 'playlist');
  assert.equal(p1.id, '37i9dQZF1DXcBWIGoYBM5M');

  // Spotify URI
  const p2 = parseSpotifyInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(p2.type, 'playlist');
  assert.equal(p2.id, '37i9dQZF1DXcBWIGoYBM5M');

  // Spotify track URL
  const t1 = parseSpotifyInput('https://open.spotify.com/track/3XmwAZpIMNpTJy8faw3ajD');
  assert.equal(t1.type, 'track');
  assert.equal(t1.id, '3XmwAZpIMNpTJy8faw3ajD');

  // Spotify track URI
  const t2 = parseSpotifyInput('spotify:track:3XmwAZpIMNpTJy8faw3ajD');
  assert.equal(t2.type, 'track');
  assert.equal(t2.id, '3XmwAZpIMNpTJy8faw3ajD');

  // Spotify album URL
  const a1 = parseSpotifyInput('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  assert.equal(a1.type, 'album');
  assert.equal(a1.id, '4aawyAB9vmqN3uQ7FjRGTy');

  // Plain 22-char ID
  const raw = parseSpotifyInput('37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(raw.type, 'playlist');
  assert.equal(raw.id, '37i9dQZF1DXcBWIGoYBM5M');
});

test('getPlaylist: should fetch real playlist tracks and metadata', async () => {
  const pl = await getPlaylist('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.ok(pl.title, 'Playlist should have a title');
  assert.ok(pl.tracks.length > 0, 'Playlist should have tracks');
  assert.ok(pl.tracks[0].title, 'First track should have a title');
  assert.ok(pl.tracks[0].artist, 'First track should have an artist');
  assert.equal(pl.tracks[0].trackNumber, 1, 'First track should have trackNumber 1');
  assert.ok(pl.tracks[0].playlistTitle, 'Track should preserve playlist title');
});

test('getPlaylist: should fetch real album tracks and metadata', async () => {
  const album = await getPlaylist('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  assert.equal(album.type, 'album');
  assert.ok(album.title.includes('Global Warming'), 'Album title should match');
  assert.ok(album.tracks.length > 0, 'Album should have tracks');
  assert.equal(album.tracks[0].album, album.title, 'Tracks should be tagged with album title');
  assert.ok(album.tracks[0].coverArt, 'Tracks should inherit album cover art');
});

test('getTrack: should fetch real track metadata, ISRC, and cover art', async () => {
  const tr = await getTrack('https://open.spotify.com/track/3XmwAZpIMNpTJy8faw3ajD');
  assert.ok(tr.title, 'Track should have title');
  assert.ok(tr.artist, 'Track should have artist');
  assert.ok(tr.coverArt, 'Track should have coverArt');
  assert.ok(tr.isrc, 'Track should be enriched with ISRC');
});
