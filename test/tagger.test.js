import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import * as mm from 'music-metadata';
import NodeID3 from 'node-id3';
import { embedMetadata, saveLrcSidecar, saveFolderCover, parseLrcToSylt } from '../src/services/tagger.js';

test('parseLrcToSylt: should convert LRC timestamp lines into SYLT milliseconds', () => {
  const lrc = '[00:01.50]Line one\n[00:03.200]Line two';
  const sylt = parseLrcToSylt(lrc);
  assert.ok(sylt && sylt.length > 0, 'Should parse SYLT');
  assert.equal(sylt[0].synchronisedText[0].text, 'Line one');
  assert.equal(sylt[0].synchronisedText[0].timeStamp, 1500);
  assert.equal(sylt[0].synchronisedText[1].text, 'Line two');
  assert.equal(sylt[0].synchronisedText[1].timeStamp, 3200);
});

test('embedMetadata MP3: should write standard ID3 tags, ISRC, SYLT, cover art, and lyrics', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag_test_mp3_'));
  const testMp3 = path.join(tmpDir, 'test.mp3');
  const testCover = path.join(tmpDir, 'cover.jpg');

  // Generate 1-sec silent MP3
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 -acodec libmp3lame ${testMp3}`, { stdio: 'ignore' });

  // Generate 100x100 test JPEG
  execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=100x100 -frames:v 1 ${testCover}`, { stdio: 'ignore' });
  const coverBuf = fs.readFileSync(testCover);

  const syncedLyrics = '[00:00.50]Hello test lyrics\n[00:01.00]Second test line';
  const plainLyrics = 'Hello test lyrics\nSecond test line';

  const tagged = await embedMetadata({
    filePath: testMp3,
    metadata: {
      title: 'Tagger Test Song',
      artist: 'Tagger Test Artist',
      album: 'Tagger Test Album',
      albumArtist: 'Tagger Test Artist',
      composer: 'Tagger Composer',
      isrc: 'USUG11904206',
      year: 2024,
      date: '2024-05-01',
      trackNumber: 2,
      trackCount: 12,
      discNumber: 1,
      genre: 'Alternative'
    },
    coverBuffer: coverBuf,
    syncedLyrics,
    plainLyrics
  });

  assert.equal(tagged, true, 'Metadata embedding should succeed');

  // Verify with music-metadata
  const parsed = await mm.parseFile(testMp3);
  assert.equal(parsed.common.title, 'Tagger Test Song');
  assert.equal(parsed.common.artist, 'Tagger Test Artist');
  assert.equal(parsed.common.album, 'Tagger Test Album');
  assert.equal(parsed.common.albumartist, 'Tagger Test Artist');
  assert.equal(parsed.common.composer?.[0], 'Tagger Composer');
  assert.equal(parsed.common.year, 2024);
  assert.equal(parsed.common.track.no, 2);
  assert.equal(parsed.common.track.of, 12);
  assert.equal(parsed.common.disk.no, 1);
  assert.equal(parsed.common.genre?.[0], 'Alternative');
  assert.equal(parsed.common.isrc?.[0], 'USUG11904206');
  assert.ok(parsed.common.lyrics?.length > 0, 'Lyrics should be embedded');
  assert.ok(parsed.common.picture?.length > 0, 'Cover art should be embedded');
  assert.equal(parsed.common.picture[0].type, 'Cover (front)');

  // Verify SYLT via NodeID3
  const id3 = NodeID3.read(testMp3);
  assert.ok(id3.synchronisedLyrics?.length > 0, 'Should have SYLT synchronisedLyrics in ID3');
  assert.equal(id3.synchronisedLyrics[0].synchronisedText[0].text, 'Hello test lyrics');

  // Test sidecar .lrc file saving
  const lrcPath = saveLrcSidecar(testMp3, syncedLyrics);
  assert.ok(fs.existsSync(lrcPath), 'Sidecar .lrc should exist');
  assert.equal(fs.readFileSync(lrcPath, 'utf-8'), syncedLyrics);

  // Test folder cover.jpg saving
  const savedCover = saveFolderCover(tmpDir, coverBuf);
  assert.ok(fs.existsSync(savedCover), 'cover.jpg should exist in folder');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('embedMetadata FLAC: should write Vorbis comments, ISRC, and attached picture', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag_test_flac_'));
  const testFlac = path.join(tmpDir, 'test.flac');
  const testCover = path.join(tmpDir, 'cover.jpg');

  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 -acodec flac ${testFlac}`, { stdio: 'ignore' });
  execSync(`ffmpeg -y -f lavfi -i color=c=red:s=100x100 -frames:v 1 ${testCover}`, { stdio: 'ignore' });
  const coverBuf = fs.readFileSync(testCover);

  const tagged = await embedMetadata({
    filePath: testFlac,
    metadata: {
      title: 'FLAC Song',
      artist: 'FLAC Artist',
      album: 'FLAC Album',
      albumArtist: 'FLAC Artist',
      composer: 'FLAC Composer',
      isrc: 'GBARL8700068',
      year: 2023,
      trackNumber: 3,
      trackCount: 10,
      discNumber: 1,
      genre: 'Rock'
    },
    coverBuffer: coverBuf,
    syncedLyrics: '[00:00.50]FLAC synced line',
    plainLyrics: 'FLAC synced line'
  });

  assert.equal(tagged, true, 'FLAC tagging should succeed');

  const parsed = await mm.parseFile(testFlac);
  assert.equal(parsed.common.title, 'FLAC Song');
  assert.equal(parsed.common.artist, 'FLAC Artist');
  assert.equal(parsed.common.album, 'FLAC Album');
  assert.equal(parsed.common.composer?.[0], 'FLAC Composer');
  assert.equal(parsed.common.isrc?.[0], 'GBARL8700068');
  assert.equal(parsed.common.track.no, 3);
  assert.equal(parsed.common.disk.no, 1);
  assert.ok(parsed.common.picture?.length > 0, 'FLAC should have attached picture');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
