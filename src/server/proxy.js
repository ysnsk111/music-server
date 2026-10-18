import http from 'http';
import https from 'https';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { processTrack } from '../services/downloader.js';
import { logger } from '../utils/logger.js';
import { getMusicStats, renderStatsHtml } from './stats.js';

const require = createRequire(import.meta.url);
const WRAPPED_DIR = '/home/suki/project/navidrome-wrapped';
let neteaseCloud = null;
let unmMatch = null;

try {
  neteaseCloud = require('NeteaseCloudMusicApi');
} catch (_) {}

try {
  unmMatch = require('@unblockneteasemusic/server');
} catch (_) {}

const NAVIS_UPSTREAM_PORT = 4533;
const PROXY_PORT = 4534;
const CACHE_DIR = '/home/suki/project/media_server/cache/online';
const ROOT_COVER = '/home/suki/gdrive/Music Library/cover.jpg';

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// In-memory metadata cache for fast retrieval
const songMetaCache = new Map();

/**
 * Perform online search via NetEase Cloud Music
 * @param {string} keyword
 * @param {number} limit
 * @returns {Promise<Array<any>>}
 */
async function searchOnlineSongs(keyword, limit = 10) {
  if (!neteaseCloud || !keyword.trim()) return [];
  try {
    const res = await neteaseCloud.cloudsearch({
      keywords: keyword.trim(),
      type: 1,
      limit
    });
    const songs = res.body?.result?.songs || [];
    return songs.map(s => {
      const songObj = {
        id: `online_ne_${s.id}`,
        rawId: s.id,
        title: `[网易云] ${s.name}`,
        rawTitle: s.name,
        artist: s.ar?.map(a => a.name).join(' / ') || 'Unknown Artist',
        album: s.al?.name || 'Online Stream',
        duration: Math.round((s.dt || 240000) / 1000),
        coverUrl: s.al?.picUrl || '',
        coverArt: `online_cover_ne_${s.id}`,
        year: s.publishTime ? new Date(s.publishTime).getFullYear() : new Date().getFullYear(),
        genre: 'Online'
      };
      songMetaCache.set(songObj.id, songObj);
      songMetaCache.set(songObj.coverArt, songObj.coverUrl);
      return songObj;
    });
  } catch (err) {
    logger.warn(`Online search failed: ${err.message}`);
    return [];
  }
}

/**
 * Resolve direct audio stream URL for an online track
 * @param {number|string} neteaseId
 * @returns {Promise<string|null>}
 */
async function resolveAudioStreamUrl(neteaseId) {
  // 1. Try UNM match
  if (unmMatch) {
    try {
      const matchRes = await unmMatch(neteaseId, ['pyncmd', 'bilibili', 'kugou', 'bodian']);
      if (matchRes && matchRes.url && matchRes.size > 100000) {
        return matchRes.url;
      }
    } catch (_) {}
  }

  // 2. Try native song_url_v1
  if (neteaseCloud) {
    try {
      const urlRes = await neteaseCloud.song_url_v1({ id: neteaseId, level: 'exhigh' });
      const url = urlRes.body?.data?.[0]?.url;
      const size = urlRes.body?.data?.[0]?.size || 0;
      if (url && size > 100000) return url;
    } catch (_) {}

    // 3. Try legacy song_url
    try {
      const legRes = await neteaseCloud.song_url({ id: neteaseId, br: 320000 });
      const url = legRes.body?.data?.[0]?.url;
      const size = legRes.body?.data?.[0]?.size || 0;
      if (url && size > 100000) return url;
    } catch (_) {}
  }

  return null;
}

function getForwardHeaders(req) {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'music.veyino.xyz';
  return {
    ...req.headers,
    host,
    'x-forwarded-host': host,
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
  };
}

/**
 * Handle Subsonic Search (search2, search3)
 */
async function handleSubsonicSearch(req, res, parsedUrl) {
  const queryParam = parsedUrl.query.query || '';
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

  // 2. Query online sources in parallel with 2.5s timeout (only if needed)
  let onlineSongs = [];
  if (queryParam) {
    try {
      const onlinePromise = searchOnlineSongs(queryParam, 8);
      const timeoutPromise = new Promise(r => setTimeout(() => r([]), 2500));
      onlineSongs = await Promise.race([onlinePromise, timeoutPromise]);
    } catch (_) {}
  }

  // 3. Modify JSON response
  if (isJson && naviBody) {
    try {
      const json = JSON.parse(naviBody);
      const root = json['subsonic-response'] || {};
      const searchResult = root.searchResult3 || root.searchResult2;

      if (searchResult) {
        const localSongs = searchResult.song || [];

        // Mark local songs without mutating title so client prefix/fuzzy match works!
        for (const s of localSongs) {
          s.isLocal = true;
        }

        // Build virtual song items conforming to full Subsonic specification
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
            title: `[在线] ${os.rawTitle}`,
            album: os.album || 'Online Stream',
            artist: os.artist || 'Unknown Artist',
            track: 1,
            year: os.year || new Date().getFullYear(),
            genre: 'Online',
            coverArt: os.coverArt,
            size: Math.round(os.duration * 320000 / 8),
            contentType: 'audio/mpeg',
            suffix: 'mp3',
            duration: os.duration,
            bitRate: 320,
            path: `[在线解析] ${os.artist} - ${os.rawTitle}.mp3`,
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

        // Local songs ALWAYS at the top, followed by online songs
        searchResult.song = [...localSongs, ...virtualSongs];
      }

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

  // 4. Handle XML response (when f != json)
  if (!isJson && naviBody && (naviBody.includes('</searchResult3>') || naviBody.includes('</searchResult2>'))) {
    try {
      const tag = naviBody.includes('</searchResult3>') ? '</searchResult3>' : '</searchResult2>';
      let xmlVirtualSongs = '';
      for (const os of onlineSongs) {
        xmlVirtualSongs += `<song id="${os.id}" parent="${os.id}" albumId="online_al_${os.rawId}" artistId="online_ar_${os.rawId}" isDir="false" title="[在线] ${escapeXml(os.rawTitle)}" album="${escapeXml(os.album)}" artist="${escapeXml(os.artist)}" track="1" year="${os.year}" genre="Online" coverArt="${os.coverArt}" size="${Math.round(os.duration * 320000 / 8)}" contentType="audio/mpeg" suffix="mp3" duration="${os.duration}" bitRate="320" path="[在线解析] ${escapeXml(os.rawTitle)}.mp3" created="${new Date().toISOString()}" type="music"/>`;
      }
      const modifiedXml = naviBody.replace(tag, `${xmlVirtualSongs}${tag}`);
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
 * Handle Navidrome Web UI native search (/api/search)
 */
async function handleNavidromeApiSearch(req, res, parsedUrl) {
  const queryParam = parsedUrl.query.q || '';
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

  let onlineSongs = [];
  if (queryParam) {
    try {
      const onlinePromise = searchOnlineSongs(queryParam, 10);
      const timeoutPromise = new Promise(r => setTimeout(() => r([]), 2500));
      onlineSongs = await Promise.race([onlinePromise, timeoutPromise]);
    } catch (_) {}
  }

  try {
    const json = JSON.parse(naviBody);
    if (Array.isArray(json.songs)) {
      for (const os of onlineSongs) {
        json.songs.push({
          id: os.id,
          title: `[在线] ${os.rawTitle}`,
          artist: os.artist,
          album: os.album,
          duration: os.duration,
          year: os.year,
          trackNumber: 1,
          genre: 'Online'
        });
      }
    }
    const modifiedOutput = JSON.stringify(json);
    res.writeHead(naviStatus, {
      ...naviHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(modifiedOutput)
    });
    res.end(modifiedOutput);
    return;
  } catch (_) {
    res.writeHead(naviStatus, naviHeaders);
    res.end(naviBody);
  }
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
  if (!songId.startsWith('online_ne_')) {
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

  // Handle online track streaming
  const neteaseId = songId.replace('online_ne_', '');
  const cachedFile = path.join(CACHE_DIR, `${neteaseId}.mp3`);

  // If file already in disk cache, stream directly with HTTP 206 support
  if (fs.existsSync(cachedFile)) {
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
    return;
  }

  // Not in cache: resolve stream URL
  const streamUrl = await resolveAudioStreamUrl(neteaseId);
  if (!streamUrl) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Audio stream not found');
    return;
  }

  // Pipe remote audio stream to client & cache in background
  const clientProtocol = streamUrl.startsWith('https') ? https : http;
  const remoteReq = clientProtocol.get(streamUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(req.headers.range ? { range: req.headers.range } : {})
    }
  }, (remoteRes) => {
    res.writeHead(remoteRes.statusCode, {
      ...remoteRes.headers,
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes'
    });

    remoteRes.pipe(res);

    // If full stream request (200), save to cache in background
    if (remoteRes.statusCode === 200) {
      const writeStream = fs.createWriteStream(cachedFile);
      remoteRes.pipe(writeStream);

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
    }
  });

  remoteReq.on('error', (err) => {
    res.writeHead(502);
    res.end(err.message);
  });
}

/**
 * Handle Subsonic Cover Art (getCoverArt, getCoverArt.view)
 */
async function handleSubsonicCover(req, res, parsedUrl) {
  const coverId = parsedUrl.query.id || '';

  // Fix root Music Library artwork not found
  if (coverId === 'Music Library' && fs.existsSync(ROOT_COVER)) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(ROOT_COVER).pipe(res);
    return;
  }

  // Online album cover
  if (coverId.startsWith('online_cover_ne_')) {
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

  if (songId.startsWith('online_ne_') && isJson) {
    const meta = songMetaCache.get(songId) || {
      id: songId,
      rawTitle: 'Online Track',
      artist: 'Online Artist',
      album: 'Online Stream',
      duration: 240,
      coverArt: `online_cover_${songId}`,
      year: new Date().getFullYear(),
      genre: 'Online'
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
          title: `[在线] ${meta.rawTitle}`,
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
          path: `[在线解析] ${meta.artist} - ${meta.rawTitle}.mp3`,
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
    res.end(jsonText);
    return;
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

  // 4. Subsonic Search
  if (pathname.endsWith('/rest/search3.view') || pathname.endsWith('/rest/search3') ||
      pathname.endsWith('/rest/search2.view') || pathname.endsWith('/rest/search2')) {
    return handleSubsonicSearch(req, res, parsedUrl);
  }

  // 5. Navidrome Web UI native search
  if (pathname === '/api/search') {
    return handleNavidromeApiSearch(req, res, parsedUrl);
  }

  // 6. Audio Stream
  if (pathname.endsWith('/rest/stream.view') || pathname.endsWith('/rest/stream') ||
      pathname.match(/\/api\/song\/online_ne_.*\/stream/)) {
    return handleSubsonicStream(req, res, parsedUrl);
  }

  // 7. Subsonic Cover Art
  if (pathname.endsWith('/rest/getCoverArt.view') || pathname.endsWith('/rest/getCoverArt')) {
    return handleSubsonicCover(req, res, parsedUrl);
  }

  // 8. Subsonic getSong
  if (pathname.endsWith('/rest/getSong.view') || pathname.endsWith('/rest/getSong')) {
    return handleSubsonicGetSong(req, res, parsedUrl);
  }

  // 9. All other requests: transparent upstream proxy to Navidrome
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
    res.end(`Navidrome proxy error: ${err.message}`);
  });

  req.pipe(upReq);
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
