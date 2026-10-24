import http from 'http';
import https from 'https';
import url from 'url';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { processTrack } from '../services/downloader.js';
import { logger } from '../utils/logger.js';
import { getMusicStats, renderStatsHtml } from './stats.js';
import { searchYtmSongs, resolveYtmStreamUrl } from '../services/ytm.js';
import { generateBilingualLyrics, parseLrc, hasChineseText } from '../services/lyrics_translator.js';

const NAVIS_UPSTREAM_PORT = 4533;
const PROXY_PORT = 4534;
const CACHE_DIR = '/home/suki/project/media_server/cache/online';
const ROOT_COVER = '/home/suki/gdrive/Music Library/cover.jpg';
const MUSIC_DIR = '/home/suki/gdrive/Music Library';
const DB_PATH = '/home/suki/project/navidrome/data/navidrome.db';
const WRAPPED_DIR = '/home/suki/project/navidrome-wrapped';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getReadOnlyDb() {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch (_) {
    return null;
  }
}

function getWritableDb() {
  try {
    return new Database(DB_PATH);
  } catch (_) {
    return null;
  }
}

// In-memory metadata cache for fast retrieval of online songs
const songMetaCache = new Map();

function getForwardHeaders(req) {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'music.veyino.xyz';
  return {
    ...req.headers,
    host,
    'x-forwarded-host': host,
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
  };
}

function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

/**
 * Handle Subsonic Search (search2, search2.view, search3, search3.view)
 */
async function handleSubsonicSearch(req, res, parsedUrl) {
  const queryParam = (parsedUrl.query.query || parsedUrl.query.q || parsedUrl.query.any || '').trim();
  const isJson = parsedUrl.query.f === 'json';

  // 1. Fetch upstream Navidrome response
  const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
  let naviBody = '';
  let naviStatus = 200;
  let naviHeaders = {};

  await new Promise((resolve) => {
    const upReq = http.request(upstreamUrl, {
      method: req.method,
      headers: getForwardHeaders(req)
    }, (upRes) => {
      naviStatus = upRes.statusCode;
      naviHeaders = upRes.headers;
      upRes.on('data', chunk => naviBody += chunk);
      upRes.on('end', resolve);
    });
    upReq.on('error', () => resolve());
    if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(upReq);
    else upReq.end();
  });

  // 2. Query YouTube Music in parallel with 5s timeout
  let onlineSongs = [];
  if (queryParam) {
    try {
      const onlinePromise = searchYtmSongs(queryParam, 10);
      const timeoutPromise = new Promise(r => setTimeout(() => r([]), 5000));
      onlineSongs = await Promise.race([onlinePromise, timeoutPromise]);
      for (const s of onlineSongs) {
        songMetaCache.set(s.id, s);
        songMetaCache.set(s.coverArt, s.coverUrl);
      }
    } catch (_) {}
  }

  // 3. Handle JSON response
  if (isJson && naviBody) {
    try {
      const json = JSON.parse(naviBody);
      const root = json['subsonic-response'] || {};
      const isSearch3 = parsedUrl.pathname.includes('search3');
      const searchKey = isSearch3 ? 'searchResult3' : 'searchResult2';

      if (!root[searchKey]) {
        root[searchKey] = {};
      }
      const searchResult = root[searchKey];
      const localSongs = searchResult.song || [];

      for (const s of localSongs) {
        s.isLocal = true;
      }

      const localTitles = new Set(localSongs.map(s => (s.title || '').toLowerCase().trim()));
      const virtualSongs = [];

      for (const os of onlineSongs) {
        if (localTitles.has(os.rawTitle.toLowerCase().trim())) {
          continue;
        }

        virtualSongs.push({
          id: os.id,
          parent: os.id,
          albumId: `online_al_${os.rawId}`,
          artistId: `online_ar_${os.rawId}`,
          isDir: false,
          title: `[YTM] ${os.rawTitle}`,
          album: os.album || 'YouTube Music',
          artist: os.artist || 'Unknown Artist',
          track: 1,
          year: os.year || new Date().getFullYear(),
          genre: 'YouTube Music',
          coverArt: os.coverArt,
          size: Math.round(os.duration * 320000 / 8),
          contentType: 'audio/mpeg',
          suffix: 'mp3',
          duration: os.duration,
          bitRate: 320,
          path: `[YTM] ${os.artist} - ${os.rawTitle}.mp3`,
          discNumber: 1,
          created: new Date().toISOString(),
          type: 'music',
          mediaType: 'song',
          artists: [{ id: `online_ar_${os.rawId}`, name: os.artist }],
          albumArtists: [{ id: `online_ar_${os.rawId}`, name: os.artist }],
          isOnline: true,
          isLocal: false
        });
      }

      searchResult.song = [...localSongs, ...virtualSongs];

      const modifiedOutput = JSON.stringify(json);
      res.writeHead(naviStatus, {
        ...naviHeaders,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(modifiedOutput)
      });
      res.end(modifiedOutput);
      return;
    } catch (_) {}
  }

  // 4. Handle XML response (when f != json or default format)
  if (!isJson && naviBody) {
    try {
      const isSearch3 = parsedUrl.pathname.includes('search3');
      const tag = isSearch3 ? 'searchResult3' : 'searchResult2';
      let xmlVirtualSongs = '';

      for (const os of onlineSongs) {
        xmlVirtualSongs += `<song id="${os.id}" parent="${os.id}" albumId="online_al_${os.rawId}" artistId="online_ar_${os.rawId}" isDir="false" title="[YTM] ${escapeXml(os.rawTitle)}" album="${escapeXml(os.album)}" artist="${escapeXml(os.artist)}" track="1" year="${os.year}" genre="YouTube Music" coverArt="${os.coverArt}" size="${Math.round(os.duration * 320000 / 8)}" contentType="audio/mpeg" suffix="mp3" duration="${os.duration}" bitRate="320" path="[YTM] ${escapeXml(os.rawTitle)}.mp3" created="${new Date().toISOString()}" type="music"/>`;
      }

      let modifiedXml = naviBody;
      if (naviBody.includes(`<${tag}/>`)) {
        modifiedXml = naviBody.replace(`<${tag}/>`, `<${tag}>${xmlVirtualSongs}</${tag}>`);
      } else if (naviBody.includes(`</${tag}>`)) {
        modifiedXml = naviBody.replace(`</${tag}>`, `${xmlVirtualSongs}</${tag}>`);
      }

      res.writeHead(naviStatus, {
        ...naviHeaders,
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(modifiedXml)
      });
      res.end(modifiedXml);
      return;
    } catch (_) {}
  }

  // Fallback: return raw upstream response
  res.writeHead(naviStatus, naviHeaders);
  res.end(naviBody);
}

/**
 * Handle Navidrome Web UI native search (/api/song with query parameter)
 */
async function handleNavidromeApiSongSearch(req, res, parsedUrl) {
  const queryParam = (parsedUrl.query.q || parsedUrl.query.title || '').trim();
  const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
  let naviBody = '';
  let naviStatus = 200;
  let naviHeaders = {};

  await new Promise((resolve) => {
    const upReq = http.request(upstreamUrl, {
      method: req.method,
      headers: getForwardHeaders(req)
    }, (upRes) => {
      naviStatus = upRes.statusCode;
      naviHeaders = upRes.headers;
      upRes.on('data', chunk => naviBody += chunk);
      upRes.on('end', resolve);
    });
    upReq.on('error', () => resolve());
    if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(upReq);
    else upReq.end();
  });

  if (!queryParam) {
    res.writeHead(naviStatus, naviHeaders);
    return res.end(naviBody);
  }

  let onlineSongs = [];
  try {
    const onlinePromise = searchYtmSongs(queryParam, 10);
    const timeoutPromise = new Promise(r => setTimeout(() => r([]), 5000));
    onlineSongs = await Promise.race([onlinePromise, timeoutPromise]);
    for (const s of onlineSongs) {
      songMetaCache.set(s.id, s);
      songMetaCache.set(s.coverArt, s.coverUrl);
    }
  } catch (_) {}

  try {
    const songsList = JSON.parse(naviBody);
    if (Array.isArray(songsList)) {
      const localTitles = new Set(songsList.map(s => (s.title || '').toLowerCase().trim()));

      for (const os of onlineSongs) {
        if (localTitles.has(os.rawTitle.toLowerCase().trim())) continue;
        songsList.push({
          id: os.id,
          title: `[YTM] ${os.rawTitle}`,
          artist: os.artist,
          album: os.album,
          duration: os.duration,
          year: os.year,
          trackNumber: 1,
          genre: 'YouTube Music',
          hasCoverArt: true
        });
      }

      const totalCount = parseInt(naviHeaders['x-total-count'] || String(songsList.length), 10) + onlineSongs.length;
      const modifiedOutput = JSON.stringify(songsList);
      res.writeHead(naviStatus, {
        ...naviHeaders,
        'x-total-count': String(totalCount),
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(modifiedOutput)
      });
      return res.end(modifiedOutput);
    }
  } catch (_) {}

  res.writeHead(naviStatus, naviHeaders);
  res.end(naviBody);
}

import { spawn } from 'child_process';
const COOKIE_FILE = '/home/suki/project/media_server/youtube_cookies.txt';

function streamLocalAudio(cachedFile, req, res) {
  const stat = fs.statSync(cachedFile);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = (end - start) + 1;
    const fileStream = fs.createReadStream(cachedFile, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg'
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(cachedFile).pipe(res);
  }
}

function streamAndCacheYtmTrack(videoId, cachedFile, req, res, songId) {
  const tempCache = `${cachedFile}.part`;
  const fileOut = fs.createWriteStream(tempCache);

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'none',
    'Transfer-Encoding': 'chunked'
  });

  const ytArgs = [
    '--cookies', COOKIE_FILE,
    '-o', '-',
    '-f', 'ba/b',
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  const ytProc = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-f', 'mp3',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  ytProc.stdout.pipe(ffmpeg.stdin);

  ffmpeg.stdout.on('data', (chunk) => {
    try {
      res.write(chunk);
      fileOut.write(chunk);
    } catch (_) {}
  });

  ffmpeg.stdout.on('end', () => {
    try {
      res.end();
      fileOut.end();
      if (fs.existsSync(tempCache) && fs.statSync(tempCache).size > 100000) {
        fs.renameSync(tempCache, cachedFile);
      }
    } catch (_) {}

    // In background, trigger async download to permanent music library
    const cachedMeta = songMetaCache.get(songId);
    if (cachedMeta) {
      setTimeout(async () => {
        try {
          await processTrack({
            title: cachedMeta.rawTitle,
            artist: cachedMeta.artist,
            album: cachedMeta.album,
            coverArt: cachedMeta.coverUrl
          });
        } catch (_) {}
      }, 1000);
    }
  });

  ytProc.on('error', () => {
    try { res.end(); fileOut.end(); } catch (_) {}
  });
  ffmpeg.on('error', () => {
    try { res.end(); fileOut.end(); } catch (_) {}
  });
}

/**
 * Handle Audio Stream (Subsonic /rest/stream and Web UI /api/song/:id/stream)
 */
async function handleSubsonicStream(req, res, parsedUrl) {
  let songId = parsedUrl.query.id || '';
  if (!songId && req.url.includes('/api/song/')) {
    const match = req.url.match(/\/api\/song\/([^/?]+)\/stream/);
    if (match) songId = match[1];
  }

  // If local track, transparently forward to Navidrome
  if (!songId.startsWith('online_ytm_') && !songId.startsWith('online_ne_')) {
    const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
    const upReq = http.request(upstreamUrl, {
      method: req.method,
      headers: getForwardHeaders(req)
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    upReq.on('error', (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    req.pipe(upReq);
    return;
  }

  // Handle online YouTube Music track streaming
  const videoId = songId.replace('online_ytm_', '').replace('online_ne_', '');
  const cachedFile = path.join(CACHE_DIR, `ytm_${videoId}.mp3`);

  // 1. If file already in disk cache, stream directly with HTTP 206 support
  if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 100000) {
    return streamLocalAudio(cachedFile, req, res);
  }

  // 2. Stream on the fly via yt-dlp + ffmpeg and save to cache & library
  streamAndCacheYtmTrack(videoId, cachedFile, req, res, songId);
}

/**
 * Handle Subsonic Cover Art (getCoverArt, getCoverArt.view)
 */
async function handleSubsonicCover(req, res, parsedUrl) {
  const coverId = parsedUrl.query.id || '';

  if (coverId === 'Music Library' && fs.existsSync(ROOT_COVER)) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
    return fs.createReadStream(ROOT_COVER).pipe(res);
  }

  // Online album cover (YTM or NetEase)
  if (coverId.startsWith('online_cover_')) {
    const coverUrl = songMetaCache.get(coverId);
    if (coverUrl) {
      const clientProtocol = coverUrl.startsWith('https') ? https : http;
      clientProtocol.get(coverUrl, (remoteRes) => {
        res.writeHead(200, {
          'Content-Type': remoteRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=604800'
        });
        remoteRes.pipe(res);
      }).on('error', () => {
        if (fs.existsSync(ROOT_COVER)) fs.createReadStream(ROOT_COVER).pipe(res);
        else res.writeHead(404).end();
      });
      return;
    }
  }

  // Forward to Navidrome
  const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
  const upReq = http.request(upstreamUrl, {
    method: req.method,
    headers: getForwardHeaders(req)
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on('error', () => res.writeHead(404).end());
  req.pipe(upReq);
}

/**
 * Handle Subsonic getSong (getSong, getSong.view)
 */
async function handleSubsonicGetSong(req, res, parsedUrl) {
  const songId = parsedUrl.query.id || '';
  const isJson = parsedUrl.query.f === 'json';

  if (songId.startsWith('online_ytm_') && isJson) {
    const meta = songMetaCache.get(songId) || {
      id: songId,
      rawTitle: 'YouTube Music Track',
      artist: 'YouTube Music Artist',
      album: 'YouTube Music',
      duration: 240,
      coverArt: `online_cover_${songId}`,
      year: new Date().getFullYear(),
      genre: 'YouTube Music'
    };

    const responseObj = {
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        song: {
          id: meta.id,
          parent: meta.id,
          albumId: `online_al_${meta.id}`,
          artistId: `online_ar_${meta.id}`,
          isDir: false,
          title: `[YTM] ${meta.rawTitle}`,
          album: meta.album,
          artist: meta.artist,
          track: 1,
          year: meta.year,
          genre: meta.genre,
          coverArt: meta.coverArt,
          size: Math.round(meta.duration * 320000 / 8),
          contentType: 'audio/mpeg',
          suffix: 'mp3',
          duration: meta.duration,
          bitRate: 320,
          path: `[YTM] ${meta.artist} - ${meta.rawTitle}.mp3`,
          discNumber: 1,
          created: new Date().toISOString(),
          type: 'music',
          mediaType: 'song',
          artists: [{ id: `online_ar_${meta.id}`, name: meta.artist }],
          albumArtists: [{ id: `online_ar_${meta.id}`, name: meta.artist }]
        }
      }
    };

    const jsonText = JSON.stringify(responseObj);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(jsonText)
    });
    return res.end(jsonText);
  }

  // Forward to Navidrome
  const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
  const upReq = http.request(upstreamUrl, {
    method: req.method,
    headers: getForwardHeaders(req)
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on('error', () => res.writeHead(404).end());
  req.pipe(upReq);
}

function sendStructuredLinesResponse(res, structuredLines, isGetBySongId, isJson, title, artist) {
  if (isGetBySongId) {
    if (isJson) {
      const resp = {
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'navidrome',
          serverVersion: '0.64.2',
          openSubsonic: true,
          lyricsList: {
            structuredLyrics: [
              {
                lang: 'zh-Hans',
                synced: true,
                line: structuredLines
              }
            ]
          }
        }
      };
      const jsonText = JSON.stringify(resp);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(jsonText)
      });
      return res.end(jsonText);
    } else {
      let xmlLines = '';
      for (const l of structuredLines) {
        xmlLines += `<line start="${l.start}" value="${escapeXml(l.value)}"/>`;
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="navidrome" serverVersion="0.64.2" openSubsonic="true">
  <lyricsList>
    <structuredLyrics lang="zh-Hans" synced="true">
      ${xmlLines}
    </structuredLyrics>
  </lyricsList>
</subsonic-response>`;
      res.writeHead(200, {
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(xml)
      });
      return res.end(xml);
    }
  } else {
    // getLyrics
    const lrcText = structuredLines.map(l => {
      const min = Math.floor(l.start / 60000);
      const sec = Math.floor((l.start % 60000) / 1000);
      const ms = Math.floor((l.start % 1000) / 10);
      return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${l.value}`;
    }).join('\n');

    if (isJson) {
      const resp = {
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'navidrome',
          serverVersion: '0.64.2',
          openSubsonic: true,
          lyrics: {
            artist: artist,
            title: title,
            value: lrcText
          }
        }
      };
      const jsonText = JSON.stringify(resp);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(jsonText)
      });
      return res.end(jsonText);
    } else {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="navidrome" serverVersion="0.64.2" openSubsonic="true">
  <lyrics artist="${escapeXml(artist)}" title="${escapeXml(title)}">${escapeXml(lrcText)}</lyrics>
</subsonic-response>`;
      res.writeHead(200, {
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(xml)
      });
      return res.end(xml);
    }
  }
}

/**
 * Handle Subsonic Lyrics (getLyrics, getLyricsBySongId)
 */
async function handleSubsonicLyrics(req, res, parsedUrl) {
  const isJson = parsedUrl.query.f === 'json';
  const songId = parsedUrl.query.id || '';
  const titleParam = parsedUrl.query.title || '';
  const artistParam = parsedUrl.query.artist || '';
  const isGetBySongId = parsedUrl.pathname.includes('getLyricsBySongId');

  // Case 1: Online YTM track
  if (songId.startsWith('online_ytm_')) {
    const meta = songMetaCache.get(songId) || { rawTitle: titleParam || 'Track', artist: artistParam || 'Artist' };
    const bilingual = await generateBilingualLyrics(meta.rawTitle, meta.artist);
    return sendLyricsResponse(res, bilingual, isGetBySongId, isJson, meta.rawTitle, meta.artist);
  }

  // Case 2: Local track
  const db = getReadOnlyDb();
  let localSong = null;
  if (db) {
    try {
      if (songId) {
        localSong = db.prepare('SELECT id, title, artist, path, lyrics FROM media_file WHERE id = ?').get(songId);
      } else if (titleParam) {
        localSong = db.prepare('SELECT id, title, artist, path, lyrics FROM media_file WHERE title LIKE ? LIMIT 1').get(`%${titleParam}%`);
      }
    } catch (_) {}
  }

  if (localSong) {
    let parsedLyrics = [];
    try {
      parsedLyrics = JSON.parse(localSong.lyrics || '[]');
    } catch (_) {}

    const hasChinese = (localSong.lyrics && hasChineseText(localSong.lyrics));
    if (hasChinese && parsedLyrics.length > 0) {
      const synced = parsedLyrics.find(g => g.synced && Array.isArray(g.line));
      const lrcLines = (synced || parsedLyrics[0])?.line || [];
      const structuredLines = lrcLines.map(l => ({ start: l.start || 0, value: l.value }));
      return sendStructuredLinesResponse(res, structuredLines, isGetBySongId, isJson, localSong.title, localSong.artist);
    }

    // Extract existing English text/LRC
    let existingLrc = '';
    const syncedGroup = parsedLyrics.find(g => g.synced && Array.isArray(g.line));
    if (syncedGroup) {
      existingLrc = syncedGroup.line.map(l => {
        const min = Math.floor(l.start / 60000);
        const sec = Math.floor((l.start % 60000) / 1000);
        const ms = Math.floor((l.start % 1000) / 10);
        const timeStr = `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}]`;
        return `${timeStr}${l.value}`;
      }).join('\n');
    } else if (parsedLyrics[0]?.line) {
      existingLrc = parsedLyrics[0].line.map(l => l.value).join('\n');
    }

    // Generate bilingual lyrics (NetEase official -> Google Translate fallback)
    const bilingual = await generateBilingualLyrics(localSong.title, localSong.artist, existingLrc);
    if (bilingual && bilingual.bilingualLrc) {
      // Save bilingual lyrics to disk & SQLite in background
      saveBilingualToLocal(localSong, bilingual.bilingualLrc);
      return sendLyricsResponse(res, bilingual, isGetBySongId, isJson, localSong.title, localSong.artist);
    }
  }

  // Forward to Navidrome
  return forwardToNavidrome(req, res);
}

function saveBilingualToLocal(localSong, bilingualLrc) {
  setTimeout(() => {
    try {
      // 1. Write .lrc sidecar file
      const lrcRelative = localSong.path.replace(/\.[^.]+$/, '.lrc');
      const lrcFull = path.join(MUSIC_DIR, lrcRelative);
      fs.writeFileSync(lrcFull, bilingualLrc, 'utf-8');

      // 2. Write to Navidrome SQLite DB
      const writableDb = getWritableDb();
      if (writableDb) {
        const parsed = parseLrc(bilingualLrc).filter(p => p.timeMs !== undefined && p.text);
        const lines = parsed.map(p => ({ start: p.timeMs, value: p.text }));
        const dbLyrics = JSON.stringify([
          { lang: 'zh-Hans', synced: true, line: lines }
        ]);
        writableDb.prepare('UPDATE media_file SET lyrics = ? WHERE id = ?').run(dbLyrics, localSong.id);
      }
    } catch (e) {
      logger.warn(`Failed to save bilingual lyrics to local: ${e.message}`);
    }
  }, 100);
}

function sendLyricsResponse(res, bilingual, isGetBySongId, isJson, title, artist) {
  const parsed = parseLrc(bilingual.bilingualLrc).filter(p => p.timeMs !== undefined && p.text);
  const structuredLines = parsed.map(p => ({ start: p.timeMs, value: p.text }));

  if (isGetBySongId) {
    if (isJson) {
      const resp = {
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'navidrome',
          serverVersion: '0.64.2',
          openSubsonic: true,
          lyricsList: {
            structuredLyrics: [
              {
                lang: 'zh-Hans',
                synced: structuredLines.length > 0,
                line: structuredLines
              }
            ]
          }
        }
      };
      const jsonText = JSON.stringify(resp);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(jsonText)
      });
      return res.end(jsonText);
    } else {
      let xmlLines = '';
      for (const l of structuredLines) {
        xmlLines += `<line start="${l.start}" value="${escapeXml(l.value)}"/>`;
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="navidrome" serverVersion="0.64.2" openSubsonic="true">
  <lyricsList>
    <structuredLyrics lang="zh-Hans" synced="${structuredLines.length > 0}">
      ${xmlLines}
    </structuredLyrics>
  </lyricsList>
</subsonic-response>`;
      res.writeHead(200, {
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(xml)
      });
      return res.end(xml);
    }
  } else {
    // getLyrics
    if (isJson) {
      const resp = {
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'navidrome',
          serverVersion: '0.64.2',
          openSubsonic: true,
          lyrics: {
            artist: artist,
            title: title,
            value: bilingual.bilingualLrc
          }
        }
      };
      const jsonText = JSON.stringify(resp);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(jsonText)
      });
      return res.end(jsonText);
    } else {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="navidrome" serverVersion="0.64.2" openSubsonic="true">
  <lyrics artist="${escapeXml(artist)}" title="${escapeXml(title)}">${escapeXml(bilingual.bilingualLrc)}</lyrics>
</subsonic-response>`;
      res.writeHead(200, {
        'content-type': 'text/xml; charset=utf-8',
        'content-length': Buffer.byteLength(xml)
      });
      return res.end(xml);
    }
  }
}

function forwardToNavidrome(req, res) {
  const upstreamUrl = `http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`;
  const upReq = http.request(upstreamUrl, {
    method: req.method,
    headers: getForwardHeaders(req)
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on('error', (err) => {
    res.writeHead(502);
    res.end(err.message);
  });
  req.pipe(upReq);
}

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function serveWrappedStatic(req, res, pathname) {
  if (pathname === '/wrapped') {
    res.writeHead(301, { Location: '/wrapped/' });
    return res.end();
  }

  let relPath = pathname.replace(/^\/wrapped\/?/, '');
  if (!relPath || relPath === '/') {
    relPath = 'index.html';
  }

  const filePath = path.resolve(WRAPPED_DIR, relPath);
  if (!filePath.startsWith(WRAPPED_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': stats.size,
      'cache-control': 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * Main HTTP Server
 */
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '';

  // 1. Listening Statistics & Report Dashboard
  if (pathname === '/stats' || pathname === '/report') {
    const user = parsedUrl.query.user || 'jake';
    const html = renderStatsHtml(user);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // 2. Music Stats JSON API
  if (pathname === '/api/stats') {
    const user = parsedUrl.query.user || 'jake';
    const days = parseInt(parsedUrl.query.days || '0', 10);
    const data = getMusicStats(user, days);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(data));
  }

  // 3. Navidrome Wrapped Static App
  if (pathname === '/wrapped' || pathname.startsWith('/wrapped/')) {
    return serveWrappedStatic(req, res, pathname);
  }

  // 4. Subsonic Lyrics
  if (pathname.endsWith('/rest/getLyricsBySongId.view') || pathname.endsWith('/rest/getLyricsBySongId') ||
      pathname.endsWith('/rest/getLyrics.view') || pathname.endsWith('/rest/getLyrics')) {
    return handleSubsonicLyrics(req, res, parsedUrl);
  }

  // 5. Subsonic Search
  if (pathname.endsWith('/rest/search3.view') || pathname.endsWith('/rest/search3') ||
      pathname.endsWith('/rest/search2.view') || pathname.endsWith('/rest/search2') ||
      pathname.endsWith('/rest/search.view') || pathname.endsWith('/rest/search')) {
    return handleSubsonicSearch(req, res, parsedUrl);
  }

  // 6. Navidrome Web UI native search (/api/song)
  if (pathname === '/api/song' && (parsedUrl.query.q || parsedUrl.query.title)) {
    return handleNavidromeApiSongSearch(req, res, parsedUrl);
  }

  // 7. Audio Stream
  if (pathname.endsWith('/rest/stream.view') || pathname.endsWith('/rest/stream') ||
      pathname.match(/\/api\/song\/online_.*\/stream/)) {
    return handleSubsonicStream(req, res, parsedUrl);
  }

  // 8. Subsonic Cover Art
  if (pathname.endsWith('/rest/getCoverArt.view') || pathname.endsWith('/rest/getCoverArt')) {
    return handleSubsonicCover(req, res, parsedUrl);
  }

  // 9. Subsonic getSong
  if (pathname.endsWith('/rest/getSong.view') || pathname.endsWith('/rest/getSong')) {
    return handleSubsonicGetSong(req, res, parsedUrl);
  }

  // 10. Transparent proxy to Navidrome
  return forwardToNavidrome(req, res);
});

// Support WebSocket Upgrade (for Navidrome real-time updates)
server.on('upgrade', (req, socket, head) => {
  const upReq = http.request(`http://127.0.0.1:${NAVIS_UPSTREAM_PORT}${req.url}`, {
    method: req.method,
    headers: getForwardHeaders(req)
  });

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n`);
    for (const h of Object.keys(upRes.headers)) {
      socket.write(`${h}: ${upRes.headers[h]}\r\n`);
    }
    socket.write('\r\n');
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  upReq.on('error', () => socket.destroy());
  upReq.end();
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[Music Server Proxy] Running on http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[Music Server Proxy] Forwarding to Navidrome at http://127.0.0.1:${NAVIS_UPSTREAM_PORT}`);
});
