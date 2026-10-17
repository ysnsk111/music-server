/**
 * Deezer API Service
 * Free, tokenless catalog enricher providing ISRC, album info,
 * track numbers, disc numbers, contributors (composers), and 1000x1000 cover art.
 */

/**
 * Clean query string for better search matches
 * @param {string} str
 * @returns {string}
 */
function cleanQuery(str) {
  if (!str) return '';
  return str
    .replace(/\s*\(?(?:feat\.|ft\.)[^)]*\)?/gi, '')
    .replace(/\s*\[?(?:official\s*(?:video|audio|music video|lyric video|visualizer))\]?/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search Deezer catalog for track metadata and ISRC
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<any | null>}
 */
export async function searchDeezer(title, artist = '') {
  if (!title) return null;

  const cleanedTitle = cleanQuery(title);
  const cleanedArtist = cleanQuery(artist);
  const q = cleanedArtist ? `${cleanedArtist} ${cleanedTitle}` : cleanedTitle;

  try {
    const searchUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'MediaServerCLI/1.0' },
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data || data.data.length === 0) return null;

    // Pick best match
    const track = data.data[0];

    // Fetch full track details for ISRC and contributors
    let fullTrack = track;
    try {
      const detailRes = await fetch(`https://api.deezer.com/track/${track.id}`, {
        headers: { 'User-Agent': 'MediaServerCLI/1.0' },
        signal: AbortSignal.timeout(6000)
      });
      if (detailRes.ok) {
        fullTrack = await detailRes.json();
      }
    } catch (_) {}

    // Extract composer from contributors if available
    let composer = '';
    if (Array.isArray(fullTrack.contributors)) {
      const compList = fullTrack.contributors
        .filter(c => c.role === 'Composer' || c.role === 'Author' || c.role === 'Writer')
        .map(c => c.name);
      if (compList.length > 0) {
        composer = [...new Set(compList)].join(', ');
      }
    }

    const year = fullTrack.release_date
      ? parseInt(fullTrack.release_date.slice(0, 4), 10)
      : null;

    return {
      title: fullTrack.title || track.title,
      artist: fullTrack.artist?.name || track.artist?.name,
      album: fullTrack.album?.title || track.album?.title,
      albumArtist: fullTrack.artist?.name || track.artist?.name,
      isrc: fullTrack.isrc || '',
      trackNumber: fullTrack.track_position || 1,
      discNumber: fullTrack.disk_number || 1,
      releaseDate: fullTrack.release_date || '',
      year,
      composer,
      artworkUrl: fullTrack.album?.cover_xl || fullTrack.album?.cover_big || track.album?.cover_big || '',
      previewUrl: fullTrack.preview || track.preview || '',
      duration: fullTrack.duration || track.duration || 0,
      bpm: fullTrack.bpm || 0
    };
  } catch (_) {
    return null;
  }
}
