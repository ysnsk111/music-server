import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { processTrack } from '../src/services/downloader.js';
import { triggerNavidromeScan, queryTrackInNavidromeDb, isNavidromeRunning } from '../src/services/navidrome.js';
import * as mm from 'music-metadata';

test('Integration: full download, metadata embedding, and Navidrome indexing', { timeout: 120000 }, async () => {
  // Check Navidrome container is running
  const running = await isNavidromeRunning();
  assert.equal(running, true, 'Navidrome container must be running');

  // Process a real track: "Never Gonna Give You Up"
  const trackInfo = {
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley'
  };

  const res = await processTrack(trackInfo);
  assert.equal(res.success, true, `Download and tagging failed: ${res.error}`);
  assert.ok(res.filePath, 'Should have output audio file');
  assert.ok(fs.existsSync(res.filePath), 'Audio file must exist on disk');

  // Verify file tags with music-metadata
  const parsed = await mm.parseFile(res.filePath);
  assert.equal(parsed.common.title, 'Never Gonna Give You Up');
  assert.equal(parsed.common.artist, 'Rick Astley');
  assert.ok(parsed.common.album, 'Should have album tag');
  assert.ok(parsed.common.picture?.length > 0, 'Should have embedded cover art');
  assert.ok(parsed.common.lyrics?.length > 0, 'Should have embedded lyrics');
  assert.ok(parsed.common.isrc?.length > 0, 'Should have embedded ISRC');
  assert.ok(parsed.common.composer?.length > 0, 'Should have embedded composer');

  // Verify sidecar .lrc exists
  if (res.lrcPath) {
    assert.ok(fs.existsSync(res.lrcPath), 'Sidecar .lrc file must exist');
    const lrcContent = fs.readFileSync(res.lrcPath, 'utf-8');
    assert.ok(lrcContent.includes('['), '.lrc file should contain timestamps');
  }

  // Trigger Navidrome scanner
  const scanResult = await triggerNavidromeScan(true);
  assert.equal(scanResult.success, true, `Navidrome scan failed: ${scanResult.output}`);

  // Query Navidrome database to verify it recognized the song
  const dbTrack = queryTrackInNavidromeDb('Never Gonna Give You Up');
  assert.ok(dbTrack, 'Track should be found in Navidrome SQLite database');
  assert.equal(dbTrack.title, 'Never Gonna Give You Up');
  assert.equal(dbTrack.artist, 'Rick Astley');
  assert.ok(dbTrack.album, 'Album should be indexed in Navidrome DB');
  assert.equal(dbTrack.has_cover_art, true, 'Navidrome should detect embedded cover art');
  assert.equal(dbTrack.has_lyrics, true, 'Navidrome should detect lyrics');
  assert.ok(dbTrack.composer, 'Navidrome should index composer in participants');
});
