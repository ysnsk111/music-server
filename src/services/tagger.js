import NodeID3 from 'node-id3';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { sanitizeFilename } from '../utils/formatters.js';

/**
 * Download cover image to buffer
 * @param {string} url
 * @returns {Promise<Buffer | null>}
 */
export async function fetchCoverBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 100 ? buf : null;
  } catch (_) {
    return null;
  }
}

/**
 * Parse LRC text into NodeID3 synchronisedLyrics format
 * @param {string} lrc
 * @returns {Array<any> | null}
 */
export function parseLrcToSylt(lrc) {
  if (!lrc || typeof lrc !== 'string') return null;
  const lines = lrc.split('\n');
  const synchronisedText = [];
  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const text = line.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!text) continue;
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      let ms = 0;
      if (m[3]) {
        ms = parseInt(m[3].padEnd(3, '0').slice(0, 3), 10);
      }
      const timeStamp = (min * 60 + sec) * 1000 + ms;
      synchronisedText.push({ text, timeStamp });
    }
  }
  synchronisedText.sort((a, b) => a.timeStamp - b.timeStamp);
  if (!synchronisedText.length) return null;
  return [{
    language: 'eng',
    timeStampFormat: NodeID3.TagConstants.TimeStampFormat.MILLISECONDS,
    contentType: NodeID3.TagConstants.SynchronisedLyrics.ContentType.LYRICS,
    shortText: 'Lyrics',
    synchronisedText
  }];
}

/**
 * Apply full metadata to audio file (MP3 or FLAC)
 * @param {object} params
 * @param {string} params.filePath Path to audio file
 * @param {object} params.metadata Metadata object
 * @param {string} params.metadata.title
 * @param {string} params.metadata.artist
 * @param {string} [params.metadata.album]
 * @param {string} [params.metadata.albumArtist]
 * @param {string} [params.metadata.composer]
 * @param {number|string} [params.metadata.year]
 * @param {string} [params.metadata.date]
 * @param {number|string} [params.metadata.trackNumber]
 * @param {number|string} [params.metadata.trackCount]
 * @param {number|string} [params.metadata.discNumber]
 * @param {string} [params.metadata.genre]
 * @param {string} [params.coverUrl]
 * @param {Buffer} [params.coverBuffer]
 * @param {string} [params.syncedLyrics]
 * @param {string} [params.plainLyrics]
 * @returns {Promise<boolean>}
 */
export async function embedMetadata({
  filePath,
  metadata,
  coverUrl,
  coverBuffer,
  syncedLyrics,
  plainLyrics
}) {
  const ext = path.extname(filePath).toLowerCase();

  // Ensure cover buffer is ready
  let imageBuf = coverBuffer;
  if (!imageBuf && coverUrl) {
    imageBuf = await fetchCoverBuffer(coverUrl);
  }

  const title = metadata.title || 'Unknown Title';
  const artist = metadata.artist || 'Unknown Artist';
  const album = metadata.album || title;
  const albumArtist = metadata.albumArtist || artist;
  const composer = metadata.composer || artist;
  const yearStr = metadata.year ? String(metadata.year) : (metadata.date ? String(new Date(metadata.date).getFullYear()) : '');
  const trackNumStr = metadata.trackNumber
    ? (metadata.trackCount ? `${metadata.trackNumber}/${metadata.trackCount}` : String(metadata.trackNumber))
    : '1';
  const discStr = metadata.discNumber ? String(metadata.discNumber) : '1';
  const genre = metadata.genre || 'Pop';
  const isrc = metadata.isrc || '';

  if (ext === '.mp3') {
    const id3Tags = {
      title,
      artist,
      album,
      performerInfo: albumArtist, // TPE2: Album Artist
      composer,
      year: yearStr,
      date: metadata.date || yearStr,
      trackNumber: trackNumStr,
      partOfSet: discStr,
      genre
    };

    if (isrc) {
      id3Tags.ISRC = isrc;
    }

    if (plainLyrics) {
      id3Tags.unsynchronisedLyrics = {
        language: 'eng',
        text: plainLyrics
      };
    }

    if (syncedLyrics) {
      const sylt = parseLrcToSylt(syncedLyrics);
      if (sylt) {
        id3Tags.synchronisedLyrics = sylt;
      }
    }

    if (imageBuf) {
      const isPng = imageBuf.length > 4 && imageBuf[0] === 0x89 && imageBuf[1] === 0x50 && imageBuf[2] === 0x4e && imageBuf[3] === 0x47;
      id3Tags.image = {
        mime: isPng ? 'image/png' : 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: imageBuf
      };
    }

    // Write tags using NodeID3
    const success = NodeID3.write(id3Tags, filePath);
    return !!success;
  } else if (ext === '.flac') {
    // FLAC tagging via ffmpeg
    const tempFlac = `${filePath}.temp.flac`;
    let tempCover = null;
    const ffmpegArgs = ['-y', '-i', filePath];

    if (imageBuf) {
      const isPng = imageBuf.length > 4 && imageBuf[0] === 0x89 && imageBuf[1] === 0x50 && imageBuf[2] === 0x4e && imageBuf[3] === 0x47;
      tempCover = isPng ? `${filePath}.cover.png` : `${filePath}.cover.jpg`;
      fs.writeFileSync(tempCover, imageBuf);
      ffmpegArgs.push('-i', tempCover, '-map', '0:a', '-map', '1:0', '-c', 'copy', '-disposition:v:0', 'attached_pic');
    } else {
      ffmpegArgs.push('-c', 'copy');
    }

    ffmpegArgs.push(
      '-metadata', `TITLE=${title}`,
      '-metadata', `ARTIST=${artist}`,
      '-metadata', `ALBUM=${album}`,
      '-metadata', `ALBUMARTIST=${albumArtist}`,
      '-metadata', `COMPOSER=${composer}`,
      '-metadata', `DATE=${yearStr}`,
      '-metadata', `TRACKNUMBER=${trackNumStr}`,
      '-metadata', `DISCNUMBER=${discStr}`,
      '-metadata', `GENRE=${genre}`
    );

    if (isrc) {
      ffmpegArgs.push('-metadata', `ISRC=${isrc}`);
    }

    if (plainLyrics) {
      ffmpegArgs.push('-metadata', `LYRICS=${plainLyrics}`);
    }

    if (syncedLyrics) {
      ffmpegArgs.push('-metadata', `SYNCEDLYRICS=${syncedLyrics}`);
    }

    ffmpegArgs.push(tempFlac);

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      proc.on('close', (code) => {
        if (tempCover) {
          try { fs.unlinkSync(tempCover); } catch (_) {}
        }
        if (code === 0) {
          fs.renameSync(tempFlac, filePath);
          resolve();
        } else {
          try { fs.unlinkSync(tempFlac); } catch (_) {}
          reject(new Error(`ffmpeg failed to tag FLAC: exit ${code}`));
        }
      });
      proc.on('error', reject);
    });

    return true;
  }

  return false;
}

/**
 * Save sidecar .lrc file alongside the music file
 * @param {string} audioFilePath
 * @param {string} lrcContent
 */
export function saveLrcSidecar(audioFilePath, lrcContent) {
  if (!lrcContent || !lrcContent.trim()) return null;
  const lrcPath = audioFilePath.replace(/\.[^/.]+$/, '.lrc');
  fs.writeFileSync(lrcPath, lrcContent.trim(), 'utf-8');
  return lrcPath;
}

/**
 * Save folder cover art (cover.jpg)
 * @param {string} targetDir
 * @param {Buffer} coverBuffer
 */
export function saveFolderCover(targetDir, coverBuffer) {
  if (!coverBuffer || coverBuffer.length === 0) return null;
  const coverPath = path.join(targetDir, 'cover.jpg');
  if (!fs.existsSync(coverPath)) {
    fs.writeFileSync(coverPath, coverBuffer);
    return coverPath;
  }
  return coverPath;
}
