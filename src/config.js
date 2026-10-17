import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'media-server');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  downloadPath: '/home/suki/gdrive/Music Library',
  namingFormat: '{albumArtist}/{album}/{track} - {title}', // {artist}, {albumArtist}, {album}, {track}, {title}, {year}
  audioQuality: '0', // '0' (lossless/best) or 320k, 256k, 192k
  audioFormat: 'flac',   // flac, mp3
  preferredSource: 'auto', // auto, ytm, netease
  embedLyrics: true,
  saveLrcFile: true,
  embedCover: true,
  saveCoverFile: true,
  cookieFile: '',
  cookiesFromBrowser: '',
  neteaseCookie: '',
  navidromeAutoScan: true,
  navidromeContainer: 'navidrome',
  navidromeDataFolder: '/data',
  navidromeMusicFolder: '/music'
};

/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Get current configuration merged with defaults
 * @returns {typeof DEFAULT_CONFIG}
 */
export function getConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration object to disk
 * @param {object} config
 */
export function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Update single key in configuration
 * @param {string} key
 * @param {any} value
 */
export function updateConfig(key, value) {
  const current = getConfig();
  current[key] = value;
  saveConfig(current);
  return current;
}

/**
 * Reset config to defaults
 */
export function resetConfig() {
  saveConfig(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export { CONFIG_FILE, DEFAULT_CONFIG };
