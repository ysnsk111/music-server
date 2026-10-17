import inquirer from 'inquirer';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getConfig, saveConfig, resetConfig } from './config.js';
import { getPlaylist, getTrack } from './services/spotify.js';
import { processTrack, processTrackList } from './services/downloader.js';
import { triggerNavidromeScan, isNavidromeRunning, queryTrackInNavidromeDb } from './services/navidrome.js';
import { formatDuration } from './utils/formatters.js';
import { logger } from './utils/logger.js';
import { execSync } from 'child_process';
import fs from 'fs';

/**
 * Launch interactive CLI main loop
 */
export async function launchInteractive() {
  while (true) {
    console.clear();
    logger.banner();

    const config = getConfig();
    console.log(chalk.gray(` Library Path: `) + chalk.cyan(config.downloadPath));
    console.log(chalk.gray(` Audio Format: `) + chalk.yellow(`${config.audioFormat.toUpperCase()} (${config.audioQuality})`) + chalk.gray(` | Preferred Source: `) + chalk.green(config.preferredSource));
    console.log('');

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Select an operation:',
        pageSize: 10,
        choices: [
          { name: '📥 1. Parse & Download Spotify Playlist', value: 'playlist' },
          { name: '🎵 2. Parse & Download Spotify Track', value: 'track' },
          { name: '🔍 3. Search & Download Song by Keyword', value: 'search' },
          { name: '⚙️  4. Configuration & Settings', value: 'config' },
          { name: '🔄 5. Trigger Navidrome Library Scan', value: 'scan' },
          { name: '🩺 6. System Diagnostics & Health Check', value: 'doctor' },
          new inquirer.Separator(),
          { name: '🚪 7. Exit', value: 'exit' }
        ]
      }
    ]);

    if (action === 'exit') {
      console.log(chalk.cyan('\nGoodbye! 👋\n'));
      process.exit(0);
    }

    try {
      if (action === 'playlist') {
        await handlePlaylistFlow();
      } else if (action === 'track') {
        await handleTrackFlow();
      } else if (action === 'search') {
        await handleSearchFlow();
      } else if (action === 'config') {
        await handleConfigFlow();
      } else if (action === 'scan') {
        await handleScanFlow();
      } else if (action === 'doctor') {
        await handleDoctorFlow();
      }
    } catch (err) {
      logger.error(`Error: ${err.message}`);
    }

    console.log('');
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: 'Press [ENTER] to return to the main menu...'
      }
    ]);
  }
}

/**
 * Spotify Playlist flow
 */
async function handlePlaylistFlow() {
  logger.title('📥 Parse & Download Spotify Playlist');

  const { input } = await inquirer.prompt([
    {
      type: 'input',
      name: 'input',
      message: 'Enter Spotify Playlist URL, URI, or ID:',
      validate: (v) => v.trim().length > 0 || 'Please enter a valid Spotify playlist URL or ID.'
    }
  ]);

  const spinner = logger.spinner('Fetching playlist information from Spotify...').start();
  let pl;
  try {
    pl = await getPlaylist(input);
    spinner.succeed(`Loaded playlist: "${chalk.bold.green(pl.title)}" (${pl.tracks.length} tracks)`);
  } catch (err) {
    spinner.fail(`Failed to load playlist: ${err.message}`);
    return;
  }

  // Preview tracks in a table
  const table = new Table({
    head: [chalk.cyan('#'), chalk.cyan('Title'), chalk.cyan('Artist'), chalk.cyan('Duration')],
    colWidths: [5, 35, 25, 10]
  });

  const previewTracks = pl.tracks.slice(0, 10);
  previewTracks.forEach((t) => {
    table.push([
      t.index,
      t.title.slice(0, 32),
      t.artist.slice(0, 22),
      formatDuration(t.duration)
    ]);
  });

  console.log('\n' + table.toString());
  if (pl.tracks.length > 10) {
    console.log(chalk.gray(`... and ${pl.tracks.length - 10} more tracks`));
  }

  const { downloadScope } = await inquirer.prompt([
    {
      type: 'list',
      name: 'downloadScope',
      message: 'Choose download range:',
      choices: [
        { name: `Download All Tracks (${pl.tracks.length} songs)`, value: 'all' },
        { name: 'Download First N Tracks', value: 'first_n' },
        { name: 'Cancel', value: 'cancel' }
      ]
    }
  ]);

  if (downloadScope === 'cancel') return;

  let targetTracks = pl.tracks;
  if (downloadScope === 'first_n') {
    const { count } = await inquirer.prompt([
      {
        type: 'number',
        name: 'count',
        message: `How many tracks to download (1 - ${pl.tracks.length})?`,
        default: Math.min(5, pl.tracks.length),
        validate: (v) => (v >= 1 && v <= pl.tracks.length) || `Enter a number between 1 and ${pl.tracks.length}`
      }
    ]);
    targetTracks = pl.tracks.slice(0, count);
  }

  console.log(chalk.cyan(`\nStarting download of ${targetTracks.length} tracks...\n`));

  let trackSpinner = null;
  const result = await processTrackList(targetTracks, {
    onProgress: (current, total, track, stage, detail) => {
      const prefix = `[${current}/${total}] "${track.artist} - ${track.title}"`;
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
          trackSpinner.fail(`[${current}/${total}] Failed "${track.title}": ${res.error}`);
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
    console.log(chalk.cyan(` 🔄 Navidrome Rescan: ${result.navidromeScan.success ? 'Complete' : 'Failed'}`));
    console.log(chalk.gray(`    Tracks imported: ${result.navidromeScan.tracksImported}`));
  }
}

/**
 * Single Spotify Track flow
 */
async function handleTrackFlow() {
  logger.title('🎵 Parse & Download Spotify Track');

  const { input } = await inquirer.prompt([
    {
      type: 'input',
      name: 'input',
      message: 'Enter Spotify Track URL, URI, or ID:',
      validate: (v) => v.trim().length > 0 || 'Please enter a valid Spotify track URL or ID.'
    }
  ]);

  const spinner = logger.spinner('Fetching track metadata from Spotify...').start();
  let trackInfo;
  try {
    trackInfo = await getTrack(input);
    spinner.succeed(`Loaded track: "${chalk.bold.green(trackInfo.title)}" by ${trackInfo.artist}`);
  } catch (err) {
    spinner.fail(`Failed to fetch track: ${err.message}`);
    return;
  }

  const dlSpinner = logger.spinner('Searching and downloading audio...').start();
  const res = await processTrack(trackInfo, {
    onStatus: (stage, detail) => {
      dlSpinner.text = `${stage}: ${detail}`;
    }
  });

  if (res.success) {
    dlSpinner.succeed(`Successfully downloaded: ${chalk.bold.green(res.track.title)}`);
    console.log(chalk.gray(` Location: ${res.filePath}`));
    if (res.lrcPath) console.log(chalk.gray(` Lyrics:   ${res.lrcPath}`));

    const config = getConfig();
    if (config.navidromeAutoScan) {
      const scanSpinner = logger.spinner('Triggering Navidrome library scan...').start();
      const scanRes = await triggerNavidromeScan(true);
      if (scanRes.success) {
        scanSpinner.succeed(`Navidrome rescan finished (imported ${scanRes.tracksImported} track)`);
      } else {
        scanSpinner.warn('Navidrome rescan finished with warnings');
      }
    }
  } else {
    dlSpinner.fail(`Download failed: ${res.error}`);
  }
}

/**
 * Search flow
 */
async function handleSearchFlow() {
  logger.title('🔍 Search & Download Song by Keyword');

  const { query } = await inquirer.prompt([
    {
      type: 'input',
      name: 'query',
      message: 'Enter Song Title and/or Artist to search:',
      validate: (v) => v.trim().length > 0 || 'Please enter keywords to search.'
    }
  ]);

  const dlSpinner = logger.spinner(`Searching and processing "${query}"...`).start();
  const res = await processTrack({ title: query, artist: '' }, {
    onStatus: (stage, detail) => {
      dlSpinner.text = `${stage}: ${detail}`;
    }
  });

  if (res.success) {
    dlSpinner.succeed(`Successfully downloaded: ${chalk.bold.green(res.track.title)} (${res.track.artist})`);
    console.log(chalk.gray(` Album:    ${res.track.album}`));
    console.log(chalk.gray(` Location: ${res.filePath}`));
    if (res.lrcPath) console.log(chalk.gray(` Lyrics:   ${res.lrcPath}`));

    const config = getConfig();
    if (config.navidromeAutoScan) {
      const scanSpinner = logger.spinner('Triggering Navidrome library scan...').start();
      const scanRes = await triggerNavidromeScan(true);
      if (scanRes.success) {
        scanSpinner.succeed(`Navidrome rescan finished (imported ${scanRes.tracksImported} track)`);
      } else {
        scanSpinner.warn('Navidrome rescan finished with warnings');
      }
    }
  } else {
    dlSpinner.fail(`Failed to download: ${res.error}`);
  }
}

/**
 * Settings configuration flow
 */
async function handleConfigFlow() {
  while (true) {
    logger.title('⚙️  Media Server Configuration');
    const current = getConfig();

    const table = new Table({
      head: [chalk.cyan('Option'), chalk.cyan('Current Value')],
      colWidths: [26, 45]
    });

    table.push(
      ['Download Path', current.downloadPath],
      ['Naming Format', current.namingFormat],
      ['Audio Format', current.audioFormat.toUpperCase()],
      ['Audio Quality', current.audioQuality],
      ['Preferred Source', current.preferredSource],
      ['Embed Lyrics', current.embedLyrics ? 'Enabled' : 'Disabled'],
      ['Save .lrc Sidecar', current.saveLrcFile ? 'Enabled' : 'Disabled'],
      ['Embed Cover Art', current.embedCover ? 'Enabled' : 'Disabled'],
      ['Save Cover Image', current.saveCoverFile ? 'Enabled' : 'Disabled'],
      ['Navidrome Auto Scan', current.navidromeAutoScan ? 'Enabled' : 'Disabled'],
      ['Navidrome Container', current.navidromeContainer]
    );

    console.log(table.toString() + '\n');

    const { option } = await inquirer.prompt([
      {
        type: 'list',
        name: 'option',
        message: 'Select setting to modify:',
        choices: [
          { name: '📁 Change Download Directory', value: 'downloadPath' },
          { name: '📂 Change Naming & Folder Format', value: 'namingFormat' },
          { name: '🎵 Change Audio Format (MP3 / FLAC)', value: 'audioFormat' },
          { name: '🎧 Change Audio Quality (320k / 256k / 192k)', value: 'audioQuality' },
          { name: '🌐 Change Preferred Source (Auto / YTM / Netease)', value: 'preferredSource' },
          { name: '📝 Toggle Lyrics Options (Embed / .lrc sidecar)', value: 'lyrics' },
          { name: '🔄 Toggle Navidrome Auto-Scan', value: 'autoScan' },
          { name: '↺ Reset All to Defaults', value: 'reset' },
          new inquirer.Separator(),
          { name: '↩ Back to Main Menu', value: 'back' }
        ]
      }
    ]);

    if (option === 'back') break;

    if (option === 'reset') {
      resetConfig();
      logger.success('Configuration reset to defaults.');
      continue;
    }

    if (option === 'downloadPath') {
      const { newPath } = await inquirer.prompt([
        {
          type: 'input',
          name: 'newPath',
          message: 'Enter new download directory path:',
          default: current.downloadPath,
          validate: (p) => p.trim().length > 0 || 'Path cannot be empty.'
        }
      ]);
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      current.downloadPath = newPath;
      saveConfig(current);
      logger.success(`Download path updated to: ${newPath}`);
    } else if (option === 'namingFormat') {
      const { formatChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'formatChoice',
          message: 'Choose naming and folder structure template:',
          choices: [
            { name: '{albumArtist}/{album}/{track} - {title} (Navidrome Standard)', value: '{albumArtist}/{album}/{track} - {title}' },
            { name: '{artist}/{album}/{track} - {title}', value: '{artist}/{album}/{track} - {title}' },
            { name: '{albumArtist}/{album} ({year})/{track} - {title}', value: '{albumArtist}/{album} ({year})/{track} - {title}' },
            { name: '{artist} - {title} (Flat structure)', value: '{artist} - {title}' },
            { name: 'Custom template string...', value: 'custom' }
          ]
        }
      ]);

      let finalTemplate = formatChoice;
      if (formatChoice === 'custom') {
        const { customTpl } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customTpl',
            message: 'Enter custom format template (tokens: {artist}, {albumArtist}, {album}, {track}, {title}, {year}):',
            default: current.namingFormat,
            validate: (v) => v.trim().length > 0 || 'Template cannot be empty.'
          }
        ]);
        finalTemplate = customTpl.trim();
      }

      current.namingFormat = finalTemplate;
      saveConfig(current);
      logger.success(`Naming format set to: ${finalTemplate}`);
    } else if (option === 'audioFormat') {
      const { format } = await inquirer.prompt([
        {
          type: 'list',
          name: 'format',
          message: 'Choose audio format:',
          choices: ['mp3', 'flac']
        }
      ]);
      current.audioFormat = format;
      saveConfig(current);
      logger.success(`Audio format set to: ${format.toUpperCase()}`);
    } else if (option === 'audioQuality') {
      const { quality } = await inquirer.prompt([
        {
          type: 'list',
          name: 'quality',
          message: 'Choose MP3 bitrate / quality:',
          choices: ['320k', '256k', '192k']
        }
      ]);
      current.audioQuality = quality;
      saveConfig(current);
      logger.success(`Audio quality set to: ${quality}`);
    } else if (option === 'preferredSource') {
      const { src } = await inquirer.prompt([
        {
          type: 'list',
          name: 'src',
          message: 'Choose preferred music source:',
          choices: [
            { name: 'Auto (YouTube Music / YouTube with Netease fallback)', value: 'auto' },
            { name: 'YouTube Music / YouTube only', value: 'ytm' },
            { name: 'Netease Cloud Music only', value: 'netease' }
          ]
        }
      ]);
      current.preferredSource = src;
      saveConfig(current);
      logger.success(`Preferred source set to: ${src}`);
    } else if (option === 'lyrics') {
      const { lrcSidecar, embed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'embed',
          message: 'Embed lyrics into ID3 / Vorbis tags?',
          default: current.embedLyrics
        },
        {
          type: 'confirm',
          name: 'lrcSidecar',
          message: 'Save sidecar .lrc files (for Navidrome synchronized lyrics)?',
          default: current.saveLrcFile
        }
      ]);
      current.embedLyrics = embed;
      current.saveLrcFile = lrcSidecar;
      saveConfig(current);
      logger.success('Lyrics settings saved.');
    } else if (option === 'autoScan') {
      const { autoScan } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'autoScan',
          message: 'Automatically trigger Navidrome scan after downloading?',
          default: current.navidromeAutoScan
        }
      ]);
      current.navidromeAutoScan = autoScan;
      saveConfig(current);
      logger.success(`Navidrome auto-scan set to: ${autoScan ? 'Enabled' : 'Disabled'}`);
    }
  }
}

/**
 * Scan flow
 */
async function handleScanFlow() {
  logger.title('🔄 Trigger Navidrome Library Scan');
  const spinner = logger.spinner('Executing Navidrome scan command...').start();
  const res = await triggerNavidromeScan(true);
  if (res.success) {
    spinner.succeed(`Scan completed! Tracks imported: ${res.tracksImported}`);
    console.log('\n' + chalk.gray(res.output));
  } else {
    spinner.fail(`Scan failed: ${res.output}`);
  }
}

/**
 * Health check flow
 */
async function handleDoctorFlow() {
  logger.title('🩺 System Diagnostics & Health Check');

  // Check Node
  console.log(chalk.cyan('Node.js: ') + process.version);

  // Check FFmpeg
  try {
    const ffOut = execSync('ffmpeg -version', { encoding: 'utf-8' }).split('\n')[0];
    logger.success(`FFmpeg: ${ffOut}`);
  } catch (e) {
    logger.error('FFmpeg: NOT found');
  }

  // Check yt-dlp
  try {
    const ytOut = execSync('yt-dlp --version', { encoding: 'utf-8' }).trim();
    logger.success(`yt-dlp: ${ytOut}`);
  } catch (e) {
    logger.error('yt-dlp: NOT found');
  }

  // Check Navidrome
  const navRunning = await isNavidromeRunning();
  if (navRunning) {
    logger.success('Navidrome Container: Running on 127.0.0.1:4533');
  } else {
    logger.warn('Navidrome Container: Not responding on 127.0.0.1:4533');
  }

  // Check Music Library Folder
  const config = getConfig();
  if (fs.existsSync(config.downloadPath)) {
    try {
      fs.accessSync(config.downloadPath, fs.constants.W_OK);
      logger.success(`Music Library Directory (${config.downloadPath}): Writable`);
    } catch (_) {
      logger.error(`Music Library Directory (${config.downloadPath}): NOT writable`);
    }
  } else {
    logger.warn(`Music Library Directory (${config.downloadPath}): Directory does not exist`);
  }
}
