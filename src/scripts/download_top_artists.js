import { processTrack } from '../services/downloader.js';
import { triggerNavidromeScan } from '../services/navidrome.js';
import { logger } from '../utils/logger.js';

async function fetchTopTracks(artistId, limit = 50) {
  const url = `https://api.deezer.com/artist/${artistId}/top?limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Deezer API returned ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((t, idx) => ({
    title: t.title,
    artist: t.artist?.name || 'Unknown',
    album: t.album?.title || t.title,
    coverArt: t.album?.cover_xl || t.album?.cover_big,
    duration: t.duration,
    trackNumber: idx + 1,
    isrc: t.isrc || ''
  }));
}

async function run() {
  console.log('========================================================');
  console.log(' Starting Top 50 Downloads for Michael Jackson & OneRepublic');
  console.log('========================================================\n');

  const artists = [
    { name: 'Michael Jackson', id: 259 },
    { name: 'OneRepublic', id: 74398 }
  ];

  for (const a of artists) {
    console.log(`\n>>> Fetching Top 50 for ${a.name}...`);
    let tracks = [];
    try {
      tracks = await fetchTopTracks(a.id, 50);
      console.log(`Found ${tracks.length} tracks for ${a.name}.`);
    } catch (err) {
      console.error(`Failed to fetch tracks for ${a.name}:`, err.message);
      continue;
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      console.log(`[${i + 1}/${tracks.length}] Downloading: ${t.artist} - ${t.title}`);

      try {
        const res = await processTrack({
          title: t.title,
          artist: t.artist,
          album: t.album,
          albumArtist: a.name, // Force primary artist as album artist
          coverArt: t.coverArt,
          trackNumber: t.trackNumber,
          isrc: t.isrc
        }, {
          onStatus: (st, msg) => {
            // concise status
          }
        });

        if (res.success) {
          successCount++;
          console.log(`  ✓ SUCCESS: ${res.filePath}`);
        } else {
          failCount++;
          console.log(`  ✗ FAILED: ${res.error}`);
        }
      } catch (e) {
        failCount++;
        console.log(`  ✗ ERROR: ${e.message}`);
      }
    }

    console.log(`\nCompleted ${a.name}: ${successCount} succeeded, ${failCount} failed.`);
  }

  console.log('\nTriggering full Navidrome library scan...');
  try {
    await triggerNavidromeScan(true);
    console.log('Navidrome library scan triggered successfully.');
  } catch (err) {
    console.error('Scan trigger failed:', err.message);
  }

  console.log('\nAll downloads complete!');
}

run().catch(console.error);
