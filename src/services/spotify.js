import spotifyUrlInfoFactory from 'spotify-url-info';
import { searchDeezer } from './deezer.js';

const spotifyInfo = spotifyUrlInfoFactory(globalThis.fetch);

/**
 * Identify and normalize Spotify URL or ID
 * @param {string} input
 * @returns {{ type: 'playlist' | 'track' | 'album' | 'unknown', id: string, url: string }}
 */
export function parseSpotifyInput(input) {
  if (!input || typeof input !== 'string') {
    return { type: 'unknown', id: '', url: '' };
  }

  const trimmed = input.trim();

  // Match spotify:type:id
  const uriMatch = trimmed.match(/^spotify:(playlist|track|album):([a-zA-Z0-9]{22})/);
  if (uriMatch) {
    return {
      type: uriMatch[1],
      id: uriMatch[2],
      url: `https://open.spotify.com/${uriMatch[1]}/${uriMatch[2]}`
    };
  }

  // Match https://open.spotify.com/type/id...
  const urlMatch = trimmed.match(/open\.spotify\.com\/(playlist|track|album)\/([a-zA-Z0-9]{22})/);
  if (urlMatch) {
    return {
      type: urlMatch[1],
      id: urlMatch[2],
      url: `https://open.spotify.com/${urlMatch[1]}/${urlMatch[2]}`
    };
  }

  // Raw 22-character ID (default assume playlist unless specified)
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return {
      type: 'playlist',
      id: trimmed,
      url: `https://open.spotify.com/playlist/${trimmed}`
    };
  }

  return { type: 'unknown', id: '', url: trimmed };
}

/**
 * Scrape direct Spotify embed HTML if needed as fallback
 * @param {string} type 'playlist' | 'track' | 'album'
 * @param {string} id
 * @returns {Promise<any>}
 */
async function fetchEmbedData(type, id) {
  const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Spotify embed returned status ${res.status}`);
  }

  const html = await res.text();
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const parsed = JSON.parse(nextMatch[1]);
      return parsed.props?.pageProps?.state?.data?.entity;
    } catch (_) {}
  }

  const initialMatch = html.match(/<script id="initial-state" type="text\/plain">([\s\S]*?)<\/script>/);
  if (initialMatch) {
    try {
      const decoded = Buffer.from(initialMatch[1], 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      return parsed.data?.entity;
    } catch (_) {}
  }

  return null;
}

/**
 * Fetch Spotify playlist or album details and tracklist
 * @param {string} input URL, URI, or ID
 * @returns {Promise<{ type: string, id: string, title: string, description: string, coverArt: string, tracks: Array<any> }>}
 */
export async function getPlaylist(input) {
  const parsed = parseSpotifyInput(input);
  const targetUrl = parsed.url || input;
  const isAlbum = parsed.type === 'album';

  let tracks = [];
  let title = isAlbum ? 'Spotify Album' : 'Spotify Playlist';
  let coverArt = '';
  let description = '';

  // 1. Try spotify-url-info first
  try {
    const data = await spotifyInfo.getData(targetUrl);
    if (data) {
      title = data.name || data.title || title;
      description = data.description || '';
      coverArt = data.coverArt?.sources?.[0]?.url ||
                 data.visualIdentity?.image?.find(i => i.maxWidth >= 600)?.url ||
                 data.visualIdentity?.image?.[0]?.url || '';

      if (Array.isArray(data.trackList)) {
        tracks = data.trackList.map((t, idx) => ({
          index: idx + 1,
          trackNumber: idx + 1,
          id: t.uri?.replace('spotify:track:', '') || String(idx + 1),
          title: t.title || t.name,
          artist: t.subtitle || (Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist'),
          album: isAlbum ? title : (t.album?.name || ''),
          coverArt: isAlbum ? coverArt : (t.coverArt?.sources?.[0]?.url || coverArt || ''),
          playlistTitle: title,
          playlistCoverArt: coverArt,
          duration: t.duration || 0,
          previewUrl: t.isPlayable ? t.audioPreview?.url : null,
          uri: t.uri
        }));
      }
    }
  } catch (err) {
    // Fallback to direct embed
  }

  // 2. Direct embed fallback if tracks is empty
  if (tracks.length === 0 && parsed.id) {
    const embedType = parsed.type === 'album' ? 'album' : 'playlist';
    const embedEntity = await fetchEmbedData(embedType, parsed.id);
    if (embedEntity) {
      title = embedEntity.title || embedEntity.name || title;
      coverArt = embedEntity.visualIdentity?.image?.find(i => i.maxWidth >= 600)?.url ||
                 embedEntity.visualIdentity?.image?.[0]?.url || coverArt;
      if (Array.isArray(embedEntity.trackList)) {
        tracks = embedEntity.trackList.map((t, idx) => ({
          index: idx + 1,
          trackNumber: idx + 1,
          id: t.uri?.replace('spotify:track:', '') || String(idx + 1),
          title: t.title || t.name,
          artist: t.subtitle || (Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist'),
          album: isAlbum ? title : '',
          coverArt: isAlbum ? coverArt : coverArt,
          playlistTitle: title,
          playlistCoverArt: coverArt,
          duration: t.duration || 0,
          previewUrl: t.isPlayable ? t.audioPreview?.url : null,
          uri: t.uri
        }));
      }
    }
  }

  if (tracks.length === 0) {
    throw new Error(`Unable to find tracks for Spotify ${parsed.type || 'playlist'}: ${input}`);
  }

  return {
    type: parsed.type || 'playlist',
    id: parsed.id,
    title,
    description,
    coverArt,
    tracks
  };
}

/**
 * Fetch Spotify single track details enriched with Deezer ISRC & album
 * @param {string} input URL, URI, or ID
 * @returns {Promise<any>}
 */
export async function getTrack(input) {
  const parsed = parseSpotifyInput(input);
  const targetUrl = parsed.url || input;

  let title = '';
  let artist = '';
  let artists = [];
  let album = '';
  let releaseDate = '';
  let duration = 0;
  let coverArt = '';

  try {
    const preview = await spotifyInfo.getPreview(targetUrl);
    const data = await spotifyInfo.getData(targetUrl).catch(() => null);

    artists = data?.artists?.map(a => a.name) || (preview.artist ? [preview.artist] : ['Unknown Artist']);
    artist = artists.join(', ');
    title = preview.title || preview.track;
    album = data?.album?.name || '';
    releaseDate = preview.date || data?.releaseDate?.isoString || '';
    duration = data?.duration || 0;
    coverArt = preview.image || data?.visualIdentity?.image?.[0]?.url || '';
  } catch (err) {
    // Embed fallback
    if (parsed.id) {
      const entity = await fetchEmbedData('track', parsed.id);
      if (entity) {
        artists = entity.artists?.map(a => a.name) || [entity.subtitle || 'Unknown Artist'];
        artist = artists.join(', ');
        title = entity.title || entity.name;
        releaseDate = entity.releaseDate?.isoString || '';
        duration = entity.duration || 0;
        const images = entity.visualIdentity?.image || [];
        const bestImage = images.find(img => img.maxWidth >= 600) || images[0];
        coverArt = bestImage?.url || '';
      }
    }
  }

  if (!title) {
    throw new Error(`Unable to fetch Spotify track: ${input}`);
  }

  // Enrich with Deezer for ISRC and album if needed
  let isrc = '';
  let composer = '';
  try {
    const deezer = await searchDeezer(title, artist);
    if (deezer) {
      isrc = deezer.isrc || '';
      album = album || deezer.album || '';
      composer = deezer.composer || '';
      if (!coverArt && deezer.artworkUrl) coverArt = deezer.artworkUrl;
      if (!releaseDate && deezer.releaseDate) releaseDate = deezer.releaseDate;
    }
  } catch (_) {}

  return {
    type: 'track',
    id: parsed.id,
    title,
    artist,
    artists,
    album,
    composer,
    isrc,
    releaseDate,
    duration,
    coverArt,
    uri: `spotify:track:${parsed.id}`
  };
}
