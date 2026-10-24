#!/usr/bin/env node

import { Command } from 'commander';
import { launchInteractive } from '../src/interactive.js';
import { getPlaylist, getTrack } from '../src/services/spotify.js';
import { processTrack, processTrackList } from '../src/services/downloader.js';
import { triggerNavidromeScan, isNavidromeRunning } from '../src/services/navidrome.js';
import { getConfig, saveConfig, resetConfig, updateConfig } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { execSync } from 'child_process';
import chalk from 'chalk';
import fs from 'fs';

const program = new Command();

program
  .name('media-server')
  .description('🎵 MediaServer Music CLI: Spotify playlist parser, hi-res audio downloader & full metadata tagger for Navidrome')
  .version('1.0.0');

// Subcommand: playlist
program
  .command('playlist <url-or-id>')
  .alias('album')
  .description('Import and download a Spotify playlist or album')
  .option('-l, --limit <number>', 'Limit number of tracks to download')
  .option('-o, --out <path>', 'Override destination music directory')
  .option('-f, --format <format>', 'Override audio format (mp3, flac)')
  .option('-s, --source <source>', 'Override preferred music source (auto, ytm, netease)')
  .action(async (input, options) => {
    logger.banner();
    const config = getConfig();
    if (options.out) config.downloadPath = options.out;
    if (options.format) config.audioFormat = options.format;
    if (options.source) config.preferredSource = options.source;

    const spinner = logger.spinner('Parsing Spotify playlist...').start();
    let pl;
    try {
      pl = await getPlaylist(input);
      spinner.succeed(`Playlist: "${pl.title}" (${pl.tracks.length} tracks)`);
    } catch (err) {
      spinner.fail(`Failed to parse playlist: ${err.message}`);
      process.exit(1);
    }

    let tracks = pl.tracks;
    if (options.limit && !isNaN(parseInt(options.limit, 10))) {
      const limit = parseInt(options.limit, 10);
      tracks = tracks.slice(0, limit);
      logger.info(`Downloading first ${limit} tracks...`);
    }

    let trackSpinner = null;
    const result = await processTrackList(tracks, {
      onProgress: (current, total, track, stage, detail) => {
        const prefix = `[${current}/${total}] "${track.title}"`;
        if (!trackSpinner) {
          trackSpinner = logger.spinner(`${prefix}: ${detail}`).start();
        } else {
          trackSpinner.text = `${prefix}: ${detail}`;
        }
      },
      onTrackComplete: (current, total, track, res) => {
        if (trackSpinner) {
          if (res.success) {
            trackSpinner.succeed(`[${current}/${total}] Downloaded: "${track.title}"`);
          } else {
            trackSpinner.fail(`[${current}/${total}] Failed: "${track.title}" (${res.error})`);
          }
          trackSpinner = null;
        }
      }
    });

    console.log('\n' + chalk.bold.green('═════════════ Download Summary ═════════════'));
    console.log(chalk.green(` ✔ Succeeded: ${result.successful.length}`));
    if (result.failed.length > 0) {
      console.log(chalk.red(` ✖ Failed:    ${result.failed.length}`));
    }
    if (result.navidromeScan) {
      console.log(chalk.cyan(` 🔄 Navidrome Rescan: ${result.navidromeScan.success ? 'Complete' : 'Failed'} (${result.navidromeScan.tracksImported} imported)`));
    }
  });

// Subcommand: track
program
  .command('track <url-or-id>')
  .description('Download a single Spotify track with full metadata')
  .option('-o, --out <path>', 'Override destination music directory')
  .option('-f, --format <format>', 'Override audio format (mp3, flac)')
  .option('-s, --source <source>', 'Override preferred music source (auto, ytm, netease)')
  .action(async (input, options) => {
    logger.banner();
    const config = getConfig();
    if (options.out) config.downloadPath = options.out;
    if (options.format) config.audioFormat = options.format;
    if (options.source) config.preferredSource = options.source;

    const spinner = logger.spinner('Fetching Spotify track info...').start();
    let trackInfo;
    try {
      trackInfo = await getTrack(input);
      spinner.succeed(`Found track: "${trackInfo.title}" by ${trackInfo.artist}`);
    } catch (err) {
      spinner.fail(`Failed to fetch track: ${err.message}`);
      process.exit(1);
    }

    const dlSpinner = logger.spinner('Downloading audio and embedding metadata...').start();
    const res = await processTrack(trackInfo, {
      onStatus: (stage, detail) => {
        dlSpinner.text = `${stage}: ${detail}`;
      }
    });

    if (res.success) {
      dlSpinner.succeed(`Downloaded: ${chalk.bold.green(res.track.title)}`);
      logger.info(`File: ${res.filePath}`);
      if (res.lrcPath) logger.info(`Lyrics: ${res.lrcPath}`);

      if (config.navidromeAutoScan) {
        const scanSpinner = logger.spinner('Scanning Navidrome...').start();
        const scanRes = await triggerNavidromeScan(true);
        if (scanRes.success) {
          scanSpinner.succeed(`Navidrome rescan finished (imported ${scanRes.tracksImported} track)`);
        } else {
          scanSpinner.warn('Navidrome rescan finished with warnings');
        }
      }
    } else {
      dlSpinner.fail(`Failed: ${res.error}`);
      process.exit(1);
    }
  });

// Subcommand: search
program
  .command('search <keywords...>')
  .description('Search and download song by keywords')
  .action(async (keywords) => {
    logger.banner();
    const query = keywords.join(' ');
    const spinner = logger.spinner(`Searching and downloading "${query}"...`).start();

    const res = await processTrack({ title: query, artist: '' }, {
      onStatus: (stage, detail) => {
        spinner.text = `${stage}: ${detail}`;
      }
    });

    if (res.success) {
      spinner.succeed(`Downloaded: ${chalk.bold.green(res.track.title)} by ${res.track.artist}`);
      logger.info(`Location: ${res.filePath}`);
      if (res.lrcPath) logger.info(`Lyrics:   ${res.lrcPath}`);

      const config = getConfig();
      if (config.navidromeAutoScan) {
        const scanSpinner = logger.spinner('Scanning Navidrome...').start();
        const scanRes = await triggerNavidromeScan(true);
        if (scanRes.success) {
          scanSpinner.succeed(`Navidrome rescan finished (imported ${scanRes.tracksImported} track)`);
        } else {
          scanSpinner.warn('Navidrome rescan finished with warnings');
        }
      }
    } else {
      spinner.fail(`Failed: ${res.error}`);
      process.exit(1);
    }
  });

// Subcommand: scan
program
  .command('scan')
  .description('Trigger Navidrome library scan')
  .option('-f, --full', 'Force full rescan ignoring timestamps', true)
  .action(async (options) => {
    logger.banner();
    const spinner = logger.spinner('Triggering Navidrome scan...').start();
    const res = await triggerNavidromeScan(options.full);
    if (res.success) {
      spinner.succeed(`Scan complete! Total tracks imported: ${res.tracksImported}`);
    } else {
      spinner.fail(`Scan error: ${res.output}`);
    }
  });

// Subcommand: config
program
  .command('config [key] [value]')
  .description('Get or set configuration options')
  .action((key, value) => {
    if (!key) {
      const cfg = getConfig();
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }

    if (value === undefined) {
      const cfg = getConfig();
      if (key in cfg) {
        console.log(cfg[key]);
      } else {
        logger.error(`Unknown config key: ${key}`);
      }
      return;
    }

    // Convert booleans / numbers if needed
    let parsedVal = value;
    if (value === 'true') parsedVal = true;
    else if (value === 'false') parsedVal = false;
    else if (!isNaN(Number(value))) parsedVal = Number(value);

    updateConfig(key, parsedVal);
    logger.success(`Updated config "${key}" to: ${parsedVal}`);
  });

// Subcommand: doctor
program
  .command('doctor')
  .description('Check dependencies, tools, and Navidrome connection')
  .action(async () => {
    logger.banner();
    logger.title('🩺 System Diagnostics');

    console.log(chalk.cyan('Node.js: ') + process.version);

    try {
      const ff = execSync('ffmpeg -version', { encoding: 'utf-8' }).split('\n')[0];
      logger.success(`FFmpeg: ${ff}`);
    } catch (_) {
      logger.error('FFmpeg: NOT installed');
    }

    try {
      const yt = execSync('yt-dlp --version', { encoding: 'utf-8' }).trim();
      logger.success(`yt-dlp: ${yt}`);
    } catch (_) {
      logger.error('yt-dlp: NOT installed');
    }

    const navRunning = await isNavidromeRunning();
    if (navRunning) {
      logger.success('Navidrome Container: Running on 127.0.0.1:4533');
    } else {
      logger.warn('Navidrome Container: Not responding on 127.0.0.1:4533');
    }

    const cfg = getConfig();
    if (fs.existsSync(cfg.downloadPath)) {
      logger.success(`Music Library Path: ${cfg.downloadPath} (exists)`);
    } else {
      logger.warn(`Music Library Path: ${cfg.downloadPath} (missing)`);
    }
  });

// Subcommand: translate
program
  .command('translate')
  .alias('translate-lyrics')
  .description('Batch convert existing lyrics in music library to bilingual (NetEase -> Google fallback)')
  .action(async () => {
    await import('../src/scripts/upgrade_bilingual_lyrics.js');
  });

// If no arguments passed, launch interactive menu
if (process.argv.length <= 2) {
  launchInteractive().catch((err) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
