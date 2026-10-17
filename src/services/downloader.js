import fs from 'fs';
import path from 'path';
import { getConfig } from '../config.js';
import { searchItunes } from './itunes.js';
import { searchDeezer } from './deezer.js';
import { fetchLyrics, extractComposerFromLyrics } from './lyrics.js';
import { downloadWithYtDlp } from './ytdlp.js';
import { downloadWithNetease } from './netease.js';
import { embedMetadata, fetchCoverBuffer, saveLrcSidecar, saveFolderCover } from './tagger.js';
import { triggerNavidromeScan, queryTrackInNavidromeDb } from './navidrome.js';
import { sanitizeFilename, resolveNamingFormat } from '../utils/formatters.js';
import { logger } from '../utils/logger.js';

/**
 * Download and process a single track
 * @param {object} trackInput
 * @param {string} trackInput.title
 * @param {string} trackInput.artist
 * @param {string} [trackInput.album]
 * @param {string} [trackInput.composer]
 * @param {string} [trackInput.isrc]
 * @param {string} [trackInput.coverArt]
 * @param {string} [trackInput.playlistCoverArt]
 * @param {number|string} [trackInput.trackNumber]
 * @param {number|string} [trackInput.index]
 * @param {number|string} [trackInput.trackCount]
 * @param {number|string} [trackInput.discNumber]
 * @param {number|string} [trackInput.year]
 * @param {object} [options]
 * @param {(stage: string, detail?: string) => void} [options.onStatus]
 * @returns {Promise<{ success: boolean, track: any, filePath?: string, lrcPath?: string, error?: string }>}
 */
export async function processTrack(trackInput, options = {}) {
  const config = getConfig();
  const onStatus = options.onStatus || (() => {});

  const baseTitle = trackInput.title || 'Unknown Title';
  const baseArtist = trackInput.artist || '';

  try {
    // 1. Enrich Metadata with Deezer & iTunes
    onStatus('enriching', 'Fetching global music catalog metadata...');
    const [itunesData, deezerData] = await Promise.all([
      searchItunes(baseTitle, baseArtist).catch(() => null),
      searchDeezer(baseTitle, baseArtist).catch(() => null)
    ]);

    const title = itunesData?.title || deezerData?.title || baseTitle;
    const artist = itunesData?.artist || deezerData?.artist || baseArtist || 'Unknown Artist';
    const album = trackInput.album || itunesData?.album || deezerData?.album || title;
    const albumArtist = itunesData?.albumArtist || deezerData?.albumArtist || artist;
    const isrc = trackInput.isrc || deezerData?.isrc || '';
    const trackNumber = trackInput.trackNumber || trackInput.index || deezerData?.trackNumber || itunesData?.trackNumber || 1;
    const trackCount = trackInput.trackCount || itunesData?.trackCount || 1;
    const discNumber = trackInput.discNumber || deezerData?.discNumber || itunesData?.discNumber || 1;
    const year = itunesData?.year || deezerData?.year || trackInput.year || new Date().getFullYear();
    const genre = itunesData?.genre || 'Pop';
    const coverUrl = itunesData?.artworkUrl || deezerData?.artworkUrl || trackInput.coverArt || trackInput.playlistCoverArt;

    // 2. Fetch Lyrics (Kugou / Netease)
    onStatus('lyrics', 'Searching synchronized lyrics...');
    let lyricsData = { syncedLyrics: '', plainLyrics: '', source: 'none' };
    if (config.embedLyrics || config.saveLrcFile) {
      lyricsData = await fetchLyrics(title, artist);
    }

    // 3. Resolve Accurate Composer
    // Order: explicit input -> lyrics header -> Deezer contributors -> iTunes -> artist fallback
    const composerFromLyrics = extractComposerFromLyrics(lyricsData.syncedLyrics || lyricsData.plainLyrics);
    const composer = trackInput.composer ||
                     composerFromLyrics ||
                     deezerData?.composer ||
                     itunesData?.composer ||
                     artist;

    // 4. Download Audio Stream
    onStatus('downloading', `Searching audio stream (${config.preferredSource})...`);
    let downloadedAudio = null;
    const audioQuery = artist ? `${artist} - ${title}` : title;

    if (config.preferredSource === 'netease') {
      downloadedAudio = await downloadWithNetease(title, artist, config.audioFormat);
      if (!downloadedAudio) {
        downloadedAudio = await downloadWithYtDlp({
          query: audioQuery,
          format: config.audioFormat,
          quality: config.audioQuality
        });
      }
    } else {
      // Auto or YTM
      try {
        downloadedAudio = await downloadWithYtDlp({
          query: audioQuery,
          format: config.audioFormat,
          quality: config.audioQuality
        });
      } catch (err) {
        // Fallback to Netease
        downloadedAudio = await downloadWithNetease(title, artist, config.audioFormat);
        if (!downloadedAudio) throw err;
      }
    }

    if (!downloadedAudio || !downloadedAudio.filePath) {
      throw new Error('Failed to obtain audio stream from third-party sources');
    }

    // 5. Download Cover Art Buffer
    onStatus('cover', 'Downloading high-resolution cover artwork...');
    const coverBuffer = await fetchCoverBuffer(coverUrl);

    // 6. Embed Complete Metadata
    onStatus('tagging', 'Embedding metadata, cover art & lyrics...');
    await embedMetadata({
      filePath: downloadedAudio.filePath,
      metadata: {
        title,
        artist,
        album,
        albumArtist,
        composer,
        year,
        trackNumber,
        trackCount,
        discNumber,
        isrc,
        genre
      },
      coverBuffer,
      syncedLyrics: lyricsData.syncedLyrics,
      plainLyrics: lyricsData.plainLyrics
    });

    // 7. Organize Files according to namingFormat
    onStatus('organizing', 'Organizing files into music library...');
    const ext = path.extname(downloadedAudio.filePath);
    const formattedRelative = resolveNamingFormat(config.namingFormat, {
      artist,
      albumArtist,
      album,
      track: trackNumber,
      title,
      year
    });

    const fullRelativePath = `${formattedRelative}${ext}`;
    const targetDir = path.join(config.downloadPath, path.dirname(fullRelativePath));
    const finalFilePath = path.join(config.downloadPath, fullRelativePath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Move audio file
    fs.copyFileSync(downloadedAudio.filePath, finalFilePath);
    try { fs.unlinkSync(downloadedAudio.filePath); } catch (_) {}

    // Save sidecar .lrc file if enabled
    let lrcPath = null;
    if (config.saveLrcFile && lyricsData.syncedLyrics) {
      lrcPath = saveLrcSidecar(finalFilePath, lyricsData.syncedLyrics);
    }

    // Save folder cover.jpg if enabled
    if (config.saveCoverFile && coverBuffer) {
      saveFolderCover(targetDir, coverBuffer);
    }

    onStatus('done', 'Completed successfully');

    return {
      success: true,
      track: {
        title,
        artist,
        album,
        albumArtist,
        composer,
        isrc,
        year,
        trackNumber,
        discNumber,
        genre,
        hasCover: !!coverBuffer,
        hasLyrics: !!lyricsData.syncedLyrics
      },
      filePath: finalFilePath,
      lrcPath
    };
  } catch (err) {
    return {
      success: false,
      track: trackInput,
      error: err.message
    };
  }
}

/**
 * Process a batch of tracks (e.g. from Spotify playlist)
 * @param {Array<any>} tracks
 * @param {object} [options]
 * @param {(current: number, total: number, track: any, res: any) => void} [options.onTrackComplete]
 * @returns {Promise<{ successful: Array<any>, failed: Array<any>, navidromeScan?: any }>}
 */
export async function processTrackList(tracks, options = {}) {
  const config = getConfig();
  const successful = [];
  const failed = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const res = await processTrack(track, {
      onStatus: (stage, detail) => {
        if (options.onProgress) {
          options.onProgress(i + 1, tracks.length, track, stage, detail);
        }
      }
    });

    if (res.success) {
      successful.push(res);
    } else {
      failed.push(res);
    }

    if (options.onTrackComplete) {
      options.onTrackComplete(i + 1, tracks.length, track, res);
    }
  }

  // Trigger Navidrome scan if enabled
  let navidromeScan = null;
  if (config.navidromeAutoScan && successful.length > 0) {
    navidromeScan = await triggerNavidromeScan(true);
  }

  return {
    successful,
    failed,
    navidromeScan
  };
}
