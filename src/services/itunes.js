/**
 * iTunes Search API service
 * Free, keyless metadata enricher for global music catalog
 */

/**
 * Search iTunes Store for music metadata
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<any | null>}
 */
export async function searchItunes(title, artist) {
  if (!title) return null;

  // Clean title for search
  const cleanTitle = title
    .replace(/\s*\(?(?:feat\.|ft\.)[^)]*\)?/gi, '')
    .replace(/\s*\[?(?:official\s*(?:video|audio|music video|lyric video|visualizer))\]?/gi, '')
    .trim();

  const term = `${artist || ''} ${cleanTitle}`.trim();

  // Try global search first, then country-specific if CJK
  const countries = ['US'];
  const hasCJK = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(term);
  if (hasCJK) {
    countries.unshift('TW', 'CN', 'JP');
  }

  for (const country of countries) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5&country=${country}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'MediaServerCLI/1.0 (https://github.com/suki/media-server)'
        }
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (data.results && data.results.length > 0) {
        // Find best match
        const match = data.results[0];

        // Format high resolution artwork (replace 100x100bb with 1200x1200bb)
        let highResArtwork = match.artworkUrl100 || '';
        if (highResArtwork) {
          highResArtwork = highResArtwork.replace(/\/\d+x\d+bb\./, '/1200x1200bb.');
        }

        const releaseYear = match.releaseDate
          ? new Date(match.releaseDate).getFullYear()
          : null;

        return {
          title: match.trackName,
          artist: match.artistName,
          album: match.collectionName,
          albumArtist: match.artistName,
          composer: match.composerName || '',
          trackNumber: match.trackNumber || 1,
          trackCount: match.trackCount || 1,
          discNumber: match.discNumber || 1,
          releaseDate: match.releaseDate,
          year: releaseYear,
          genre: match.primaryGenreName,
          artworkUrl: highResArtwork,
          previewUrl: match.previewUrl
        };
      }
    } catch (_) {
      // Ignore network errors and continue to next country fallback
    }
  }

  return null;
}
