import fs from 'fs';
import path from 'path';
import { processTrack } from '../services/downloader.js';
import { triggerNavidromeScan } from '../services/navidrome.js';
import { getConfig } from '../config.js';

/**
 * Fetch top tracks for an artist from Deezer
 * @param {number} artistId
 * @param {number} limit
 * @returns {Promise<Array<{ title: string, artist: string, album?: string }>>}
 */
async function fetchArtistTopTracks(artistId, limit = 50) {
  const url = `https://api.deezer.com/artist/${artistId}/top?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deezer API returned status ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((t, idx) => ({
    title: t.title,
    artist: t.artist?.name,
    album: t.album?.title,
    trackNumber: idx + 1
  }));
}

/**
 * Check if a song already exists in the music library
 * @param {string} libraryPath
 * @param {string} artist
 * @param {string} title
 * @returns {boolean}
 */
function isTrackAlreadyDownloaded(libraryPath, artist, title) {
  const artistDir = path.join(libraryPath, artist);
  if (!fs.existsSync(artistDir)) return false;

  // Search recursively in artist folder
  const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  try {
    const albums = fs.readdirSync(artistDir);
    for (const album of albums) {
      const albumPath = path.join(artistDir, album);
      if (fs.statSync(albumPath).isDirectory()) {
        const files = fs.readdirSync(albumPath);
        for (const file of files) {
          if (file.endsWith('.flac') || file.endsWith('.mp3')) {
            const cleanFile = file.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (cleanFile.includes(cleanTitle)) {
              return true;
            }
          }
        }
      }
    }
  } catch (_) {}
  return false;
}

async function main() {
  const config = getConfig();
  const libraryPath = config.downloadPath;
  console.log(`[START] Media Library Target: ${libraryPath}`);
  console.log(`[START] Audio Format: ${config.audioFormat.toUpperCase()} (Quality: ${config.audioQuality})`);

  const artists = [
    { name: 'Michael Jackson', id: 259 },
    { name: 'OneRepublic', id: 74398 }
  ];

  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { name, id } of artists) {
    console.log(`\n============================================================`);
    console.log(`🎵 Fetching top 50 tracks for: ${name} (Deezer ID: ${id})`);
    console.log(`============================================================`);

    let tracks = [];
    try {
      tracks = await fetchArtistTopTracks(id, 50);
      console.log(`✔ Retrieved ${tracks.length} tracks for ${name}`);
    } catch (err) {
      console.error(`✖ Failed to fetch tracks for ${name}: ${err.message}`);
      continue;
    }

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const progressPrefix = `[${i + 1}/${tracks.length}] ${name} - ${track.title}`;

      // Check if already present
      if (isTrackAlreadyDownloaded(libraryPath, name, track.title)) {
        console.log(`⏩ ${progressPrefix} -> Already in library, skipping.`);
        totalSkipped++;
        continue;
      }

      console.log(`⏳ ${progressPrefix} -> Downloading & embedding metadata...`);
      try {
        const result = await processTrack(track, {
          onStatus: (stage, detail) => {
            // detail logging
          }
        });

        if (result.success) {
          console.log(`✅ ${progressPrefix} -> Success: ${result.track.album} | Composer: ${result.track.composer || 'N/A'} | ISRC: ${result.track.isrc || 'N/A'}`);
          totalDownloaded++;
        } else {
          console.warn(`⚠️ ${progressPrefix} -> Failed: ${result.error}`);
          totalFailed++;
        }
      } catch (err) {
        console.error(`✖ ${progressPrefix} -> Exception: ${err.message}`);
        totalFailed++;
      }

      // Trigger Navidrome scan every 5 downloaded tracks
      if (totalDownloaded > 0 && totalDownloaded % 5 === 0) {
        console.log(`🔄 Triggering Navidrome incremental scan...`);
        try {
          await triggerNavidromeScan(true);
        } catch (_) {}
      }
    }

    // End of artist scan
    console.log(`🔄 Triggering Navidrome library scan after completing ${name}...`);
    try {
      await triggerNavidromeScan(true);
    } catch (_) {}
  }

  console.log(`\n============================================================`);
  console.log(`🎉 ALL COMPLETED!`);
  console.log(`   Downloaded: ${totalDownloaded}`);
  console.log(`   Skipped (Already existed): ${totalSkipped}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`============================================================`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
