import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { getConfig } from '../config.js';

const require = createRequire(import.meta.url);
let neteaseCloud = null;
try {
  neteaseCloud = require('NeteaseCloudMusicApi');
} catch (_) {}

/**
 * Search and download audio from Netease Cloud Music with fallback candidates
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

    // Iterate through top search candidates until a playable stream is found
    for (const song of songs) {
      try {
        const level = format === 'flac' ? 'lossless' : 'exhigh';
        const urlRes = await neteaseCloud.song_url_v1({
          id: song.id,
          level,
          cookie
        });

        const url = urlRes.body?.data?.[0]?.url;
        if (url) {
          targetUrl = url;
          selectedSong = song;
          break;
        }

        // Secondary fallback: song_url with bitrate
        const legacyRes = await neteaseCloud.song_url({
          id: song.id,
          br: 320000,
          cookie
        });
        const legacyUrl = legacyRes.body?.data?.[0]?.url;
        if (legacyUrl) {
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

    return {
      filePath: finalFile,
      title: selectedSong.name,
      duration: selectedSong.dt || 0
    };
  } catch (_) {
    return null;
  }
}
