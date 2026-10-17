import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getConfig } from '../config.js';

/**
 * Run yt-dlp process with given arguments
 * @param {string[]} args
 * @param {string} outputDir
 * @param {string} tmpPrefix
 * @param {string} format
 * @param {(progressText: string) => void} [onProgress]
 * @returns {Promise<string>} returns downloaded file path
 */
function runYtDlp(args, outputDir, tmpPrefix, format, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutData = '';
    let stderrData = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutData += text;
      if (onProgress) {
        const match = text.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) onProgress(`${match[1]}%`);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrData += text;
      if (onProgress) {
        const match = text.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) onProgress(`${match[1]}%`);
      }
    });

    proc.on('close', () => {
      const expectedExt = format === 'flac' ? '.flac' : '.mp3';
      const expectedFile = path.join(outputDir, `${tmpPrefix}${expectedExt}`);

      if (fs.existsSync(expectedFile)) {
        return resolve(expectedFile);
      }

      // Check if any matching file was created with tmpPrefix
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith(tmpPrefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (files.length > 0) {
        return resolve(path.join(outputDir, files[0]));
      }

      reject(new Error(`yt-dlp download failed: ${stderrData || stdoutData}`));
    });

    proc.on('error', reject);
  });
}

/**
 * Execute yt-dlp search and download
 * @param {object} params
 * @param {string} params.query Search string (e.g. "Taylor Swift Style")
 * @param {string} [params.format="mp3"] "mp3" or "flac"
 * @param {string} [params.quality="320k"] "320k" or "0"
 * @param {string} [params.outputDir] Directory to save temporary file
 * @param {(progressText: string) => void} [params.onProgress]
 * @returns {Promise<{ filePath: string, title: string, duration: number }>}
 */
export async function downloadWithYtDlp({
  query,
  format = 'mp3',
  quality = '320k',
  outputDir = os.tmpdir(),
  onProgress
}) {
  const config = getConfig();
  const tmpPrefix = `ms_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(outputDir, `${tmpPrefix}.%(ext)s`);

  const cleanQuery = query.replace(/^\s*-\s*/, '').trim();

  const commonArgs = [
    '--no-playlist',
    '--max-downloads', '1',
    '--ignore-errors',
    '--socket-timeout', '20',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', quality || '0',
    '-o', outputTemplate
  ];

  if (config.cookieFile && fs.existsSync(config.cookieFile)) {
    commonArgs.push('--cookies', config.cookieFile);
  } else if (config.cookiesFromBrowser) {
    commonArgs.push('--cookies-from-browser', config.cookiesFromBrowser);
  }

  // 1. Try YouTube / YouTube Music search with node JS runtime
  const ytQuery = cleanQuery.startsWith('http')
    ? cleanQuery
    : `ytsearch5:${cleanQuery} audio`;

  const ytArgs = [
    ...commonArgs,
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web_embedded',
    ytQuery
  ];

  try {
    const downloadedFile = await runYtDlp(ytArgs, outputDir, tmpPrefix, format, onProgress);
    return {
      filePath: downloadedFile,
      title: query,
      duration: 0
    };
  } catch (ytErr) {
    // If not a direct URL, fall back to SoundCloud
    if (!query.startsWith('http')) {
      if (onProgress) onProgress('Trying alternative audio source (SoundCloud)...');
      const scQuery = `scsearch5:${query}`;
      const scArgs = [
        ...commonArgs,
        scQuery
      ];

      try {
        const downloadedFile = await runYtDlp(scArgs, outputDir, tmpPrefix, format, onProgress);
        return {
          filePath: downloadedFile,
          title: query,
          duration: 0
        };
      } catch (scErr) {
        throw new Error(`All audio sources failed. YouTube: ${ytErr.message} | SoundCloud: ${scErr.message}`);
      }
    }

    throw ytErr;
  }
}
