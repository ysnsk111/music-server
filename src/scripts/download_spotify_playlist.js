import fs from 'fs';
import path from 'path';
import { getPlaylist } from '../services/spotify.js';
import { processTrack } from '../services/downloader.js';
import { triggerNavidromeScan } from '../services/navidrome.js';

const PLAYLIST_URL = 'https://open.spotify.com/playlist/0Htlzs5bQ7mH14TkFxNorX?si=lH3_xW78S7OaCE03oaffkQ';
const MUSIC_DIR = '/home/suki/gdrive/Music Library';
const PLAYLISTS_DIR = path.join(MUSIC_DIR, 'Playlists');

if (!fs.existsSync(PLAYLISTS_DIR)) {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
}

/**
 * Scan library for existing track file
 */
function findExistingTrack(title, artist) {
  const normTitle = (title || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normArtist = (artist || '').toLowerCase().replace(/[^\w\s]/g, '').trim();

  const stack = [MUSIC_DIR];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur.startsWith(PLAYLISTS_DIR)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && (ent.name.endsWith('.flac') || ent.name.endsWith('.mp3'))) {
        const fileNorm = ent.name.toLowerCase().replace(/[^\w\s]/g, '');
        if (normTitle && fileNorm.includes(normTitle)) {
          return full;
        }
      }
    }
  }
  return null;
}

async function run() {
  console.log('🎵 Parsing Spotify playlist: Daily...');
  const pl = await getPlaylist(PLAYLIST_URL);
  console.log(`✔ Found playlist: "${pl.title}" with ${pl.tracks.length} tracks.`);

  const playlistEntries = [];
  let downloadedCount = 0;
  let reusedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < pl.tracks.length; i++) {
    const t = pl.tracks[i];
    const indexStr = `[${i + 1}/${pl.tracks.length}]`;
    console.log(`\n${indexStr} Checking: "${t.artist} - ${t.title}"...`);

    // 1. Check if already in library
    const existingFile = findExistingTrack(t.title, t.artist);
    if (existingFile) {
      console.log(`   ⏭  Found existing local file: ${existingFile}`);
      const relPath = path.relative(PLAYLISTS_DIR, existingFile);
      playlistEntries.push({
        title: t.title,
        artist: t.artist,
        duration: Math.round((t.duration || 200000) / 1000),
        filePath: relPath
      });
      reusedCount++;
      continue;
    }

    // 2. Download missing track
    console.log(`   ⬇  Downloading: "${t.artist} - ${t.title}"...`);
    try {
      const res = await processTrack({
        title: t.title,
        artist: t.artist,
        album: t.album,
        composer: '',
        coverArt: t.coverArt || pl.coverArt,
        trackNumber: i + 1,
        trackCount: pl.tracks.length,
        discNumber: 1,
        isrc: t.isrc || '',
        playlistTitle: 'Daily'
      });

      if (res.success && res.filePath) {
        console.log(`   ✔  Downloaded successfully: ${res.filePath}`);
        const relPath = path.relative(PLAYLISTS_DIR, res.filePath);
        playlistEntries.push({
          title: t.title,
          artist: t.artist,
          duration: Math.round((t.duration || 200000) / 1000),
          filePath: relPath
        });
        downloadedCount++;
      } else {
        console.log(`   ✖  Failed to download: ${res.error}`);
        failedCount++;
      }
    } catch (err) {
      console.log(`   ✖  Error: ${err.message}`);
      failedCount++;
    }

    // Write / update playlist periodically so user sees progress in Navidrome
    writeM3u8Playlist(playlistEntries);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Final M3U8 write
  writeM3u8Playlist(playlistEntries);

  console.log('\n=============================================');
  console.log(`🎉 Spotify Playlist "Daily" import complete!`);
  console.log(`✔ Newly downloaded: ${downloadedCount}`);
  console.log(`⏭ Reused from library: ${reusedCount}`);
  console.log(`✖ Failed: ${failedCount}`);
  console.log(`📋 Total playlist items in Daily.m3u8: ${playlistEntries.length}`);
  console.log('=============================================');

  console.log('\n🔄 Triggering Navidrome library scan...');
  try {
    await triggerNavidromeScan(true);
    console.log('✔ Navidrome scan triggered successfully!');
  } catch (scanErr) {
    console.error('Scan trigger error:', scanErr.message);
  }
}

function writeM3u8Playlist(entries) {
  const m3u8Path = path.join(PLAYLISTS_DIR, 'Daily.m3u8');
  let content = '#EXTM3U\n';
  for (const item of entries) {
    content += `#EXTINF:${item.duration || -1},${item.artist} - ${item.title}\n`;
    content += `${item.filePath}\n`;
  }
  fs.writeFileSync(m3u8Path, content, 'utf-8');
}

run().catch(console.error);
