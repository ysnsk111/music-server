import { createRequire } from 'module';
import { cleanTitleForLyrics, stripLrcTimestamps } from './lyrics.js';

const require = createRequire(import.meta.url);
let neteaseCloud = null;
try {
  neteaseCloud = require('NeteaseCloudMusicApi');
} catch (_) {}

/**
 * Check if text contains substantial Chinese characters (at least 25% of lines)
 * @param {string} text
 * @returns {boolean}
 */
export function hasChineseText(text) {
  if (!text) return false;
  // If JSON format from Navidrome DB
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const lines = Array.isArray(parsed) ? (parsed[0]?.line || []) : (parsed.line || []);
      if (lines.length > 0) {
        const chineseCount = lines.filter(l => /[\u4e00-\u9fa5]/.test(l.value || '')).length;
        return (chineseCount / lines.length) >= 0.25;
      }
    } catch (_) {}
  }
  // If plain LRC string
  const lines = text.split('\n')
    .map(l => l.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim())
    .filter(l => l && !l.startsWith('['));
  if (lines.length === 0) return false;
  const chineseCount = lines.filter(l => /[\u4e00-\u9fa5]/.test(l)).length;
  return (chineseCount / lines.length) >= 0.25;
}

/**
 * Translate text via Google Translate free GTX endpoint
 * @param {string} text
 * @param {string} [targetLang='zh-CN']
 * @returns {Promise<string>}
 */
export async function translateWithGoogle(text, targetLang = 'zh-CN') {
  if (!text || !text.trim()) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map(item => item[0]).join('');
    }
  } catch (err) {
    console.error(`[Google Translate Error] ${err.message}`);
  }
  return '';
}

/**
 * Parse an LRC string into array of timestamped lines
 * @param {string} lrc
 * @returns {Array<{ tag?: string, timeMs?: number, timeStr?: string, text: string }>}
 */
export function parseLrc(lrc) {
  if (!lrc) return [];
  const lines = lrc.split('\n');
  const result = [];
  const timeRegex = /^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(timeRegex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      let ms = 0;
      if (match[3]) {
        ms = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
      }
      const timeMs = min * 60000 + sec * 1000 + ms;
      const timeStr = `[${match[1]}:${match[2]}.${match[3] || '00'}]`;
      const text = match[4].trim();

      result.push({
        timeMs,
        timeStr,
        text
      });
    } else {
      result.push({
        tag: line,
        text: ''
      });
    }
  }
  return result;
}

/**
 * Fetch translated lyrics from NetEase Cloud Music
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ originalLrc: string, translatedLrc: string } | null>}
 */
export async function fetchNeteaseLyricsWithTranslation(title, artist) {
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
      const originalLrc = lyrRes.body?.lrc?.lyric || '';
      const translatedLrc = lyrRes.body?.tlyric?.lyric || '';
      return { originalLrc, translatedLrc };
    }
  } catch (_) {}
  return null;
}

/**
 * Align NetEase translated lyrics with original lines
 * @param {Array<{ timeMs?: number, timeStr?: string, text: string }>} origParsed
 * @param {string} tlyricStr
 * @returns {Array<{ timeStr: string, orig: string, trans: string }>}
 */
function alignNeteaseTranslations(origParsed, tlyricStr) {
  const transParsed = parseLrc(tlyricStr).filter(p => p.timeMs !== undefined && p.text);
  const aligned = [];

  for (const item of origParsed) {
    if (!item.timeStr) continue;
    if (!item.text) {
      aligned.push({ timeStr: item.timeStr, orig: '', trans: '' });
      continue;
    }

    // Match translation within 1.5 second tolerance
    let matchedTrans = '';
    const match = transParsed.find(t => Math.abs(t.timeMs - item.timeMs) <= 1500);
    if (match) {
      matchedTrans = match.text;
    }

    aligned.push({
      timeStr: item.timeStr,
      timeMs: item.timeMs,
      orig: item.text,
      trans: matchedTrans
    });
  }
  return aligned;
}

/**
 * Generate YouTube Music style bilingual synced lyrics
 * 1. Tries NetEase tlyric first
 * 2. Falls back to Google Translate
 * @param {string} title
 * @param {string} artist
 * @param {string} [existingLrc='']
 * @returns {Promise<{ bilingualLrc: string, plainLyrics: string, source: string }>}
 */
export async function generateBilingualLyrics(title, artist, existingLrc = '') {
  let baseLrc = existingLrc.trim();

  // If already bilingual with Chinese, return directly
  if (baseLrc && hasChineseText(baseLrc)) {
    return {
      bilingualLrc: baseLrc,
      plainLyrics: stripLrcTimestamps(baseLrc),
      source: 'existing'
    };
  }

  const hasTimestamps = /\[\d{2}:\d{2}/.test(baseLrc);

  // 1. Try NetEase for official translation
  const neResult = await fetchNeteaseLyricsWithTranslation(title, artist);
  if (neResult) {
    // If existing lrc has no timestamps, prefer NetEase original synced lrc
    if ((!baseLrc || !hasTimestamps) && neResult.originalLrc) {
      baseLrc = neResult.originalLrc;
    }

    if (neResult.translatedLrc && hasChineseText(neResult.translatedLrc)) {
      const origParsed = parseLrc(baseLrc);
      const aligned = alignNeteaseTranslations(origParsed, neResult.translatedLrc);

      const validLines = aligned.filter(a => a.orig);
      const translatedCount = validLines.filter(a => a.trans).length;

      if (validLines.length > 0 && (translatedCount / validLines.length >= 0.3)) {
        const lrcOutput = [];
        for (const line of aligned) {
          if (!line.orig) continue;
          lrcOutput.push(`${line.timeStr}${line.orig}`);
          if (line.trans) {
            lrcOutput.push(`${line.timeStr}${line.trans}`);
          }
        }
        const fullBilingual = lrcOutput.join('\n');
        return {
          bilingualLrc: fullBilingual,
          plainLyrics: stripLrcTimestamps(fullBilingual),
          source: 'netease'
        };
      }
    }
  }

  // 2. If NetEase has no translation, fallback to Google Translate machine translation
  if (baseLrc) {
    const isSynced = /\[\d{2}:\d{2}/.test(baseLrc);
    if (isSynced) {
      const origParsed = parseLrc(baseLrc).filter(p => p.timeStr && p.text);
      if (origParsed.length > 0) {
        const textToTranslate = origParsed.map(p => p.text).join('\n');
        const translatedBlock = await translateWithGoogle(textToTranslate, 'zh-CN');
        const translatedLines = translatedBlock.split('\n');

        const lrcOutput = [];
        for (let i = 0; i < origParsed.length; i++) {
          const item = origParsed[i];
          const trans = (translatedLines[i] || '').trim();
          lrcOutput.push(`${item.timeStr}${item.text}`);
          if (trans && trans !== item.text) {
            lrcOutput.push(`${item.timeStr}${trans}`);
          }
        }

        const fullBilingual = lrcOutput.join('\n');
        return {
          bilingualLrc: fullBilingual,
          plainLyrics: stripLrcTimestamps(fullBilingual),
          source: 'google'
        };
      }
    } else {
      // Plain text translation fallback
      const lines = baseLrc.split('\n').map(l => l.trim()).filter(Boolean);
      const textToTranslate = lines.join('\n');
      const translatedBlock = await translateWithGoogle(textToTranslate, 'zh-CN');
      const translatedLines = translatedBlock.split('\n');

      const output = [];
      for (let i = 0; i < lines.length; i++) {
        output.push(lines[i]);
        if (translatedLines[i] && translatedLines[i] !== lines[i]) {
          output.push(translatedLines[i]);
        }
      }
      const fullBilingual = output.join('\n');
      return {
        bilingualLrc: fullBilingual,
        plainLyrics: fullBilingual,
        source: 'google'
      };
    }
  }

  return {
    bilingualLrc: baseLrc || '',
    plainLyrics: stripLrcTimestamps(baseLrc || ''),
    source: 'none'
  };
}
