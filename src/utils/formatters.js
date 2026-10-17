/**
 * Formatters and string sanitization utilities
 */

/**
 * Sanitize strings for safe filenames and folder paths across Linux, Windows, macOS
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (!name) return 'unknown';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // remove leading dots
    .slice(0, 180); // avoid OS length limit
}

/**
 * Format milliseconds into mm:ss
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format bytes into human-readable size
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Clean up title for search matching
 * e.g. "Song Name (feat. Artist)" -> "Song Name"
 * @param {string} title
 * @returns {string}
 */
export function cleanSearchTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*\(?(?:feat\.|ft\.)[^)]*\)?/gi, '')
    .replace(/\s*\[?(?:official\s*(?:video|audio|music video|lyric video|visualizer))\]?/gi, '')
    .replace(/\s*\(?(?:official\s*(?:video|audio|music video|lyric video|visualizer))\)?/gi, '')
    .trim();
}

/**
 * Resolve configurable naming template to a sanitized relative file path
 * @param {string} formatTemplate e.g. "{albumArtist}/{album}/{track} - {title}"
 * @param {object} data
 * @returns {string} relative path without extension
 */
export function resolveNamingFormat(formatTemplate, {
  artist,
  albumArtist,
  album,
  track,
  title,
  year
} = {}) {
  const safeArtist = sanitizeFilename(artist || 'Unknown Artist');
  const safeAlbumArtist = sanitizeFilename(albumArtist || safeArtist);
  const safeAlbum = sanitizeFilename(album || 'Unknown Album');
  const safeTitle = sanitizeFilename(title || 'Unknown Title');
  const trackNum = parseInt(track, 10);
  const trackPrefix = (!isNaN(trackNum) && trackNum > 0) ? String(trackNum).padStart(2, '0') : '01';
  const yearStr = year ? String(year) : '';

  let resolved = formatTemplate || '{albumArtist}/{album}/{track} - {title}';
  resolved = resolved
    .replace(/\{albumArtist\}/g, safeAlbumArtist)
    .replace(/\{artist\}/g, safeArtist)
    .replace(/\{album\}/g, safeAlbum)
    .replace(/\{track\}/g, trackPrefix)
    .replace(/\{title\}/g, safeTitle)
    .replace(/\{year\}/g, yearStr);

  return resolved.replace(/[\\/]+/g, '/').replace(/^\/+/, '');
}

