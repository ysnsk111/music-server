import { execSync, execFileSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getConfig } from '../config.js';

/**
 * Check if Navidrome container is running
 * @returns {Promise<boolean>}
 */
export async function isNavidromeRunning() {
  const config = getConfig();
  try {
    const res = await fetch('http://127.0.0.1:4533/ping', { signal: AbortSignal.timeout(2000) });
    if (res.ok) return true;
  } catch (_) {}

  try {
    const out = execSync(`podman ps --filter name=${config.navidromeContainer} --format "{{.Names}}"`, { encoding: 'utf-8' });
    return out.includes(config.navidromeContainer);
  } catch (_) {
    return false;
  }
}

/**
 * Trigger Navidrome music library rescan
 * @param {boolean} [fullScan=false]
 * @returns {Promise<{ success: boolean, output: string, tracksImported: number }>}
 */
export async function triggerNavidromeScan(fullScan = false) {
  const config = getConfig();
  const flag = fullScan ? '-f' : '';
  const cmd = `podman exec ${config.navidromeContainer} /app/navidrome scan ${flag} --datafolder ${config.navidromeDataFolder} --musicfolder ${config.navidromeMusicFolder}`;

  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';

    const proc = spawn('bash', ['-c', cmd]);

    proc.stdout.on('data', (c) => { stdoutData += c.toString(); });
    proc.stderr.on('data', (c) => { stderrData += c.toString(); });

    proc.on('close', (code) => {
      const fullLog = stdoutData + '\n' + stderrData;
      let tracksImported = 0;

      // Extract tracksImported from logs e.g. tracksImported=1
      const matches = fullLog.matchAll(/tracksImported=(\d+)/g);
      for (const m of matches) {
        tracksImported += parseInt(m[1], 10);
      }

      resolve({
        success: code === 0,
        output: fullLog.trim(),
        tracksImported
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: err.message,
        tracksImported: 0
      });
    });
  });
}

/**
 * Verify a track in Navidrome SQLite database
 * @param {string} title
 * @param {string} [artist]
 * @returns {object | null}
 */
export function queryTrackInNavidromeDb(title, artist) {
  const dbPath = '/home/suki/project/navidrome/data/navidrome.db';
  if (!fs.existsSync(dbPath)) return null;

  try {
    const pyScript = `import sqlite3, json, sys
dbPath = sys.argv[1]
title = sys.argv[2]
con = sqlite3.connect(dbPath)
cur = con.cursor()
query = "SELECT title, artist, album, album_artist, track_number, year, has_cover_art, lyrics, participants FROM media_file WHERE title LIKE ? LIMIT 1;"
cur.execute(query, ('%' + title + '%',))
row = cur.fetchone()
if row:
    composer = ""
    try:
        if row[8]:
            p = json.loads(row[8])
            if "composer" in p and p["composer"]:
                composer = ", ".join([c.get("name", "") for c in p["composer"] if "name" in c])
    except Exception:
        pass
    print(json.dumps({
        "title": row[0],
        "artist": row[1],
        "album": row[2],
        "album_artist": row[3],
        "track_number": row[4],
        "year": row[5],
        "has_cover_art": bool(row[6]),
        "has_lyrics": bool(row[7]),
        "composer": composer
    }))
else:
    print(json.dumps(None))
`;
    const out = execFileSync('python3', ['-c', pyScript, dbPath, title], { encoding: 'utf-8' }).trim();
    if (out && out !== 'null') {
      return JSON.parse(out);
    }
  } catch (_) {}
  return null;
}
