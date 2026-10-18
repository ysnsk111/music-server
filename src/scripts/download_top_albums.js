import fs from 'fs';
import path from 'path';
import { processTrack } from '../services/downloader.js';
import { triggerNavidromeScan } from '../services/navidrome.js';
import { logger } from '../utils/logger.js';

const TARGET_ALBUMS = [
  // Michael Jackson Top Albums
  { artist: 'Michael Jackson', albumName: 'Thriller', deezerId: 96126 },
  { artist: 'Michael Jackson', albumName: 'Bad (Remastered)', deezerId: 5814031 },
  { artist: 'Michael Jackson', albumName: 'Dangerous', deezerId: 1441212 },
  { artist: 'Michael Jackson', albumName: 'Off the Wall', deezerId: 1440807 },

  // OneRepublic Top Albums
  { artist: 'OneRepublic', albumName: 'Native', deezerId: 6446668 },
  { artist: 'OneRepublic', albumName: 'Dreaming Out Loud', deezerId: 102809 },
  { artist: 'OneRepublic', albumName: 'Waking Up', deezerId: 95090392 },
  { artist: 'OneRepublic', albumName: 'Human (Deluxe)', deezerId: 253669142 },

  // Queen Top Album
  { artist: 'Queen', albumName: 'A Night At The Opera', deezerId: 1007321681 }
];

const MUSIC_DIR = '/home/suki/gdrive/Music Library';

/**
 * Check if track title already exists in artist directory
 */
function isTrackAlreadyInLibrary(artist, title) {
  const normTitle = title.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const artistDir = path.join(MUSIC_DIR, artist);
  if (!fs.existsSync(artistDir)) return false;

  const stack = [artistDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        stack.push(path.join(cur, ent.name));
      } else if (ent.isFile() && ent.name.endsWith('.flac')) {
        const fileNorm = ent.name.toLowerCase().replace(/[^\w\s]/g, '');
        if (fileNorm.includes(normTitle)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function fetchAlbumTracks(deezerId) {
  const res = await fetch(`https://api.deezer.com/album/${deezerId}`);
  if (!res.ok) throw new Error(`Deezer API returned ${res.status}`);
  const data = await res.json();
  const coverUrl = data.cover_xl || data.cover_big || data.cover_medium || '';
  const albumTitle = data.title;
  const albumArtist = data.artist?.name || '';
  const releaseDate = data.release_date || '';
  const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : undefined;

  const tracks = (data.tracks?.data || []).map((t, idx) => ({
    title: t.title,
    artist: t.artist?.name || albumArtist,
    album: albumTitle,
    albumArtist: albumArtist,
    trackNumber: t.track_position || idx + 1,
    trackCount: data.nb_tracks || data.tracks?.data?.length,
    discNumber: t.disk_number || 1,
    duration: t.duration,
    coverArt: coverUrl,
    year,
    isrc: t.isrc || ''
  }));

  return { albumTitle, albumArtist, coverUrl, year, tracks };
}

async function run() {
  console.log('🎵 Starting batch download for top albums...');
  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const item of TARGET_ALBUMS) {
    console.log(`\n📀 Processing Album: ${item.artist} - ${item.albumName} (Deezer ID: ${item.deezerId})`);
    try {
      const albumInfo = await fetchAlbumTracks(item.deezerId);
      console.log(`   Found ${albumInfo.tracks.length} tracks. Checking library...`);

      for (const track of albumInfo.tracks) {
        if (isTrackAlreadyInLibrary(item.artist, track.title)) {
          console.log(`   ⏭  Already in library: "${track.title}" (Skipped)`);
          totalSkipped++;
          continue;
        }

        console.log(`   ⬇  Downloading [${track.trackNumber}/${track.trackCount}]: "${track.artist} - ${track.title}"...`);
        try {
          const res = await processTrack({
            title: track.title,
            artist: track.artist,
            album: albumInfo.albumTitle,
            composer: '',
            coverArt: albumInfo.coverUrl,
            trackNumber: track.trackNumber,
            trackCount: track.trackCount,
            discNumber: track.discNumber,
            year: albumInfo.year,
            isrc: track.isrc
          }, {
            onStatus: (stage, detail) => {
              // optional live status
            }
          });

          if (res.success) {
            console.log(`   ✔  Downloaded successfully: ${res.filePath}`);
            totalDownloaded++;
          } else {
            console.log(`   ✖  Failed to download "${track.title}": ${res.error}`);
            totalFailed++;
          }
        } catch (dlErr) {
          console.log(`   ✖  Error: ${dlErr.message}`);
          totalFailed++;
        }

        // Brief delay between downloads
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`   ✖ Failed to fetch album info: ${err.message}`);
    }
  }

  console.log('\n=============================================');
  console.log(`🎉 Batch download finished!`);
  console.log(`✔ Downloaded: ${totalDownloaded}`);
  console.log(`⏭ Skipped (already existed): ${totalSkipped}`);
  console.log(`✖ Failed: ${totalFailed}`);
  console.log('=============================================');

  console.log('\n🔄 Triggering Navidrome library scan...');
  try {
    await triggerNavidromeScan();
    console.log('✔ Navidrome scan triggered successfully!');
  } catch (scanErr) {
    console.error('Scan trigger error:', scanErr.message);
  }
}

run().catch(console.error);
