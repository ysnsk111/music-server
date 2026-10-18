import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { getConfig } from '../config.js';

const require = createRequire(import.meta.url);
let neteaseCloud = null;
let unmMatch = null;

try {
  neteaseCloud = require('NeteaseCloudMusicApi');
} catch (_) {}

try {
  unmMatch = require('@unblockneteasemusic/server');
} catch (_) {}

/**
 * Get duration of audio file using ffprobe
 * @param {string} filePath
 * @returns {Promise<number>}
 */
export async function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      if (code === 0 && out.trim()) {
        resolve(parseFloat(out.trim()) || 0);
      } else {
        resolve(0);
      }
    });
    proc.on('error', () => resolve(0));
  });
}

/**
 * Search and download audio from Netease Cloud Music with UNM resolution and duration verification
 * @param {string} title
 * @param {string} artist
 * @param {string} format 'mp3' | 'flac'
 * @returns {Promise<{ filePath: string, title: string, duration: number } | null>}
 */
export async function downloadWithNetease(title, artist, format = 'mp3') {
  if (!neteaseCloud) return null;
  const config = getConfig();

  try {
    const query = `${artist || ''} ${title}`.trim();
    const cookie = config.neteaseCookie || '';

    const searchRes = await neteaseCloud.cloudsearch({
      keywords: query,
      type: 1,
      limit: 6,
      cookie
    });

    const songs = searchRes.body?.result?.songs;
    if (!songs || songs.length === 0) return null;

    let targetUrl = null;
    let selectedSong = null;

    for (const song of songs) {
      try {
        // 1. Try UNM match first (pyncmd, bilibili, kugou) for full 320k/lossless tracks
        if (unmMatch) {
          try {
            const matched = await unmMatch(song.id, ['pyncmd', 'bilibili', 'kugou', 'bodian']);
            if (matched && matched.url && matched.size > 100000) {
              targetUrl = matched.url;
              selectedSong = song;
              break;
            }
          } catch (_) {}
        }

        // 2. Try native song_url_v1
        const level = format === 'flac' ? 'lossless' : 'exhigh';
        const urlRes = await neteaseCloud.song_url_v1({
          id: song.id,
          level,
          cookie
        });

        const url = urlRes.body?.data?.[0]?.url;
        const size = urlRes.body?.data?.[0]?.size || 0;
        if (url && size > 100000) {
          targetUrl = url;
          selectedSong = song;
          break;
        }

        // 3. Fallback to legacy song_url
        const legacyRes = await neteaseCloud.song_url({
          id: song.id,
          br: 320000,
          cookie
        });
        const legacyUrl = legacyRes.body?.data?.[0]?.url;
        const legacySize = legacyRes.body?.data?.[0]?.size || 0;
        if (legacyUrl && legacySize > 100000) {
          targetUrl = legacyUrl;
          selectedSong = song;
          break;
        }
      } catch (_) {}
    }

    if (!targetUrl || !selectedSong) return null;

    const tmpPrefix = `ms_ne_${Date.now()}_${selectedSong.id}`;
    const rawFile = path.join(os.tmpdir(), `${tmpPrefix}.tmp`);
    const finalFile = path.join(os.tmpdir(), `${tmpPrefix}.${format}`);

    // Download stream
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return null;

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength < 100000) {
      // File too small to be a full song
      return null;
    }

    fs.writeFileSync(rawFile, Buffer.from(arrayBuf));

    // Convert to target format via ffmpeg
    const ffmpegArgs = ['-y', '-i', rawFile];
    if (format === 'flac') {
      ffmpegArgs.push('-c:a', 'flac', finalFile);
    } else {
      ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', '320k', finalFile);
    }

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      proc.on('close', (code) => {
        try { fs.unlinkSync(rawFile); } catch (_) {}
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    // Verify duration with ffprobe: must be >= 60s
    const dur = await getAudioDuration(finalFile);
    if (dur < 60) {
      try { fs.unlinkSync(finalFile); } catch (_) {}
      return null;
    }

    return {
      filePath: finalFile,
      title: selectedSong.name,
      duration: dur
    };
  } catch (_) {
    return null;
  }
}
