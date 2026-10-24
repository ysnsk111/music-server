import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, 'ytm_bridge.py');

// Cache stream URLs for 2 hours to provide instant playback on repeat/seek
const streamUrlCache = new Map();

/**
 * Search YouTube Music songs
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Array<any>>}
 */
export function searchYtmSongs(query, limit = 10) {
  return new Promise((resolve) => {
    if (!query || !query.trim()) return resolve([]);
    
    const proc = spawn('python3', [BRIDGE_SCRIPT, 'search', query.trim(), String(limit)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => stdout += chunk);
    proc.stderr.on('data', chunk => stderr += chunk);

    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        if (stderr) console.error(`[YTM Search Error] ${stderr.trim()}`);
        return resolve([]);
      }
      try {
        const results = JSON.parse(stdout);
        resolve(Array.isArray(results) ? results : []);
      } catch (e) {
        console.error(`[YTM Search Parse Error] ${e.message}`);
        resolve([]);
      }
    });

    proc.on('error', (err) => {
      console.error(`[YTM Search Spawn Error] ${err.message}`);
      resolve([]);
    });
  });
}

/**
 * Resolve direct audio stream URL for a YouTube Music video
 * @param {string} videoId
 * @returns {Promise<string|null>}
 */
export function resolveYtmStreamUrl(videoId) {
  if (!videoId) return Promise.resolve(null);

  // Check in-memory cache
  const cached = streamUrlCache.get(videoId);
  if (cached && (Date.now() - cached.time < 7200000)) {
    return Promise.resolve(cached.url);
  }

  return new Promise((resolve) => {
    const proc = spawn('python3', [BRIDGE_SCRIPT, 'stream', videoId], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => stdout += chunk);
    proc.stderr.on('data', chunk => stderr += chunk);

    proc.on('close', (code) => {
      const url = stdout.trim();
      if (code === 0 && url.startsWith('http')) {
        streamUrlCache.set(videoId, { url, time: Date.now() });
        return resolve(url);
      }
      if (stderr) console.error(`[YTM Stream Error] ${stderr.trim()}`);
      resolve(null);
    });

    proc.on('error', (err) => {
      console.error(`[YTM Stream Spawn Error] ${err.message}`);
      resolve(null);
    });
  });
}
