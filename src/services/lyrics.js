import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let neteaseCloud = null;
try {
  neteaseCloud = require('NeteaseCloudMusicApi');
} catch (_) {}

/**
 * Clean LRC timestamps from synced lyrics to produce plain text lyrics
 * Strips bracket metadata headers ([ti:], [ar:], [al:], etc.) and all timestamps
 * @param {string} lrc
 * @returns {string}
 */
export function stripLrcTimestamps(lrc) {
  if (!lrc) return '';
  return lrc
    .split('\n')
    // Remove metadata bracket headers like [ti:Title], [ar:Artist], [al:Album], [offset:0], etc.
    .filter(line => !/^\s*\[(ti|ar|al|by|offset|re|ve|length|hash|id):/i.test(line))
    // Remove all timestamp brackets [00:12.34], [00:12.345], [00:12] globally
    .map(line => line.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim())
    // Filter empty lines or leftover solitary brackets
    .filter(line => line.length > 0 && !/^\[.*?\]$/.test(line))
    .join('\n')
    .trim();
}

/**
 * Extract composer from lyrics header (common in Kugou, Netease, QQ Music LRC)
 * e.g. "[00:01.00] 作曲 : Stock Aitken Waterman" or "Composed by: ..."
 * @param {string} lrc
 * @returns {string | null}
 */
export function extractComposerFromLyrics(lrc) {
  if (!lrc) return null;
  const lines = lrc.split('\n');
  for (const rawLine of lines) {
    const clean = rawLine.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    const match = clean.match(/^(?:作曲|Composed\s*by|Composer|Music\s*by)\s*[:：]\s*(.+)$/i);
    if (match) {
      const comp = match[1].trim();
      if (comp && comp !== '无' && comp !== 'None' && comp !== '未知') {
        return comp.replace(/\//g, ', ');
      }
    }
  }
  return null;
}

/**
 * Clean version noise from title for accurate lyrics retrieval
 * @param {string} title
 * @returns {string}
 */
export function cleanTitleForLyrics(title) {
  if (!title) return '';
  return title
    .replace(/\s*[\(\[][^\)\]]*(?:remaster|deluxe|edition|anniversary|radio edit|original mix|single|version|bonus|live|acoustic)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*(?:remaster|radio edit|deluxe|anniversary|single).*/gi, '')
    .trim() || title;
}

/**
 * Fetch lyrics from Kugou Open API
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<string | null>}
 */
export async function getKugouLyrics(title, artist) {
  try {
    const cleanTitle = cleanTitleForLyrics(title);
    const query = `${artist || ''} ${cleanTitle}`.trim();
    const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(query)}&page=1&pagesize=5&showtype=1`;
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.data?.info?.length) return null;

    const song = data.data.info[0];
    const lyrSearchUrl = `http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${song.hash}&album_audio_id=`;
    const lyrRes = await fetch(lyrSearchUrl, { signal: AbortSignal.timeout(5000) });
    if (!lyrRes.ok) return null;

    const lyrData = await lyrRes.json();
    if (!lyrData.candidates?.length) return null;

    const cand = lyrData.candidates[0];
    const dlUrl = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`;
    const dlRes = await fetch(dlUrl, { signal: AbortSignal.timeout(5000) });
    if (!dlRes.ok) return null;

    const dlData = await dlRes.json();
    if (dlData.content) {
      return Buffer.from(dlData.content, 'base64').toString('utf-8');
    }
  } catch (_) {}
  return null;
}

/**
 * Fetch lyrics from Netease Cloud Music
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<string | null>}
 */
export async function getNeteaseLyrics(title, artist) {
  if (!neteaseCloud) return null;
  try {
    const cleanTitle = cleanTitleForLyrics(title);
    const query = `${artist || ''} ${cleanTitle}`.trim();
    const searchRes = await neteaseCloud.cloudsearch({
      keywords: query,
      type: 1,
      limit: 3
    });

    const songs = searchRes.body?.result?.songs;
    if (songs && songs.length > 0) {
      const songId = songs[0].id;
      const lyrRes = await neteaseCloud.lyric({ id: songId });
      const lrc = lyrRes.body?.lrc?.lyric;
      if (lrc && lrc.trim().length > 0) {
        return lrc;
      }
    }
  } catch (_) {}
  return null;
}

import { generateBilingualLyrics } from './lyrics_translator.js';

/**
 * Main lyrics searcher: queries Kugou/Netease, generates bilingual lyrics via Netease/Google
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ syncedLyrics: string, plainLyrics: string, source: string }>}
 */
export async function fetchLyrics(title, artist) {
  // 1. Try Kugou first
  let lrc = await getKugouLyrics(title, artist);
  let source = 'kugou';

  // 2. Fallback to Netease
  if (!lrc) {
    lrc = await getNeteaseLyrics(title, artist);
    source = 'netease';
  }

  // 3. Process into bilingual lyrics (NetEase translation -> Google Translate fallback)
  try {
    const bilingualRes = await generateBilingualLyrics(title, artist, lrc || '');
    if (bilingualRes.bilingualLrc) {
      return {
        syncedLyrics: bilingualRes.bilingualLrc,
        plainLyrics: bilingualRes.plainLyrics,
        source: bilingualRes.source
      };
    }
  } catch (_) {}

  if (!lrc) {
    return {
      syncedLyrics: '',
      plainLyrics: '',
      source: 'none'
    };
  }

  const plainLyrics = stripLrcTimestamps(lrc);
  return {
    syncedLyrics: lrc,
    plainLyrics,
    source
  };
}
