# 🎵 MediaServer Music CLI & Navidrome Proxy

**English** | [简体中文](./README_ZH.md)

A powerful Node.js global CLI tool and Subsonic reverse proxy that seamlessly integrates YouTube Music with Navidrome. It imports Spotify playlists/tracks, provides unified search across local media and YouTube Music catalogs, enables instant HTTP 206 on-demand streaming with background library caching, embeds complete lossless metadata, and features a multi-tier bilingual lyrics engine (NetEase official translations + Google Translate fallback) generating standard YouTube Music style dual-language lyrics.

---

## ✨ Features

- **Spotify Playlist & Track Importer**: Directly parses Spotify playlist URLs, track URLs, album URLs, Spotify URIs, or IDs without requiring any paid Spotify API developer account.
- **YouTube Music Mount & On-Demand Streaming Proxy**:
  - **Unified Search**: Transparently intercepts Subsonic/OpenSubsonic searches (Symfonium, Feishin, 音流, DSub, etc.) and Navidrome Web UI searches. Displays local tracks alongside YouTube Music online tracks (annotated with `[YTM]`).
  - **Stream On-The-Fly with HTTP 206**: Instant playback response via HTTP 206 Partial Content range streaming without buffering delays.
  - **Auto-Caching & Library Persistence**: While streaming, automatically downloads the high-quality audio in the background, enriches metadata, embeds covers and bilingual lyrics, writes to the permanent music library (`~/gdrive/Music Library`), and triggers Navidrome to scan.
- **Bilingual Lyrics Engine (YouTube Music Style)**:
  - Generates synchronized bilingual lyrics (`[mm:ss.xx] Original\n[mm:ss.xx] 简体中文`) for both local and online tracks.
  - **Priority 1 (NetEase)**: Fetches official translated lyrics (`tlyric`) and aligns timestamps with the original lyrics.
  - **Priority 2 (Google Translate Fallback)**: If no official translation exists, uses Google Translate to machine-translate lines into Simplified Chinese (`zh-CN` / `sc`).
  - **Dynamic Injection & Real-Time Sync**: Injects bilingual lyrics on the fly when requested by Subsonic clients, and asynchronously writes them back to local `.lrc` files and the Navidrome SQLite database.
  - **Batch Migration**: One-command migration tool (`media-server translate`) to upgrade existing music libraries to bilingual lyrics.
- **Multi-Source Audio Resolution**:
  - **YouTube Music / YouTube**: High-quality audio extraction (lossless FLAC or up to 320kbps MP3) via `yt-dlp` and `ffmpeg`, using session cookies to bypass challenges.
  - **Netease Cloud Music**: Alternative high-quality source via `NeteaseCloudMusicApi` with automatic fallback on VIP limits.
  - **SoundCloud**: Built-in automatic fallback audio provider.
- **Complete Lossless Metadata Embedding**:
  - Track Title, Artist, Album, Album Artist, Composer, Year/Date, Track Number, Total Tracks, Disc Number, Genre, and ISRC.
  - Embedded Front Cover Art (JPEG/PNG up to 1200×1200 resolution via Apple iTunes & Deezer APIs).
  - Embedded Unsynchronized Lyrics (`USLT` tag) & Synchronized Lyrics (`SYLT` millisecond tag).
  - Sidecar `.lrc` Synchronized Lyrics and folder `cover.jpg` artwork.
- **Navidrome Integration**:
  - Configurable file naming template (defaults to `{albumArtist}/{album}/{track} - {title}`).
  - Works directly with local storage or mounted Google Drive (`~/gdrive/Music Library`).
  - Automatically triggers rootless Podman/Docker Navidrome rescans.
- **Interactive & Headless Modes**:
  - Interactive Terminal UI powered by `inquirer` with colored output and status spinners.
  - Full CLI command-line support for scripts, automation, and cron jobs.

---

## 🚀 Installation

Ensure `Node.js` (>= 18), `python3`, `ffmpeg`, and `yt-dlp` are installed on your system.

```bash
cd /home/suki/project/media_server
npm install
sudo npm install -g .
```

This registers the global commands `media-server` and `ms-music`.

---

## 💻 Usage

### 1. Interactive Menu Mode
Run without arguments to launch the interactive UI:

```bash
media-server
# or
ms-music
```

Interactive options:
1. `📥 1. Parse & Download Spotify Playlist`: Enter a playlist URL or ID, preview tracks, and download.
2. `🎵 2. Parse & Download Spotify Track`: Enter a track URL or ID to download.
3. `🔍 3. Search & Download Song by Keyword`: Search by song title or artist.
4. `🌐 4. Translate Library Lyrics`: Batch translate existing library lyrics to bilingual format.
5. `⚙️  5. Configuration & Settings`: View and change download path, audio format (FLAC/MP3), quality, lyrics options, naming format, etc.
6. `🔄 6. Trigger Navidrome Library Scan`: Manually force Navidrome to rescan the library.
7. `🩺 7. System Diagnostics & Health Check`: Check Node, FFmpeg, yt-dlp, and Navidrome health.
8. `🚪 8. Exit`: Quit.

---

### 2. Command-Line Direct Subcommands

#### Download a Spotify Playlist or Album
```bash
# Download all songs in a playlist
media-server playlist https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M

# Download only the first 5 songs
media-server playlist 37i9dQZF1DXcBWIGoYBM5M --limit 5

# Download to a specific custom directory
media-server playlist 37i9dQZF1DXcBWIGoYBM5M --out "/home/suki/gdrive/Music Library"
```

#### Download a Single Spotify Track
```bash
media-server track https://open.spotify.com/track/3XmwAZpIMNpTJy8faw3ajD
```

#### Search and Download by Keyword
```bash
media-server search "The Weeknd Blinding Lights"
media-server search "周杰伦 晴天"
```

#### Batch Convert Existing Lyrics to Bilingual (NetEase -> Google Fallback)
```bash
# Translates existing library lyrics to YouTube Music style bilingual LRC
media-server translate
# or
media-server translate-lyrics
```

#### Trigger Navidrome Library Rescan
```bash
media-server scan
```

#### System Diagnostics
```bash
media-server doctor
```

---

## 🌐 Navidrome Subsonic Proxy & YTM Integration

The media server includes a built-in reverse proxy (`src/server/proxy.js`) that sits in front of Navidrome (listening on `127.0.0.1:4534`, upstream Navidrome on `127.0.0.1:4533`).

### Features:
1. **Unified Search**: When searching in Subsonic clients (e.g. Symfonium) or Navidrome Web UI, local media results and YouTube Music results are displayed together.
2. **On-Demand Streaming & Background Ingestion**: Clicking a `[YTM]` track streams immediately via HTTP 206 range requests, and simultaneously downloads, tags, and stores the track in your permanent library.
3. **Bilingual Lyrics**: Intercepts `/rest/getLyrics` and `/rest/getLyricsBySongId` to serve timestamped bilingual lyrics.

Service management:
```bash
sudo systemctl status navidrome-proxy.service
sudo systemctl restart navidrome-proxy.service
```

---

## ⚙️ Configuration

Settings are saved in `~/.config/media-server/config.json`.

View current configuration:
```bash
media-server config
```

Update individual settings:
```bash
# Set download path to Google Drive
media-server config downloadPath "/home/suki/gdrive/Music Library"

# Change audio format ('flac' or 'mp3')
media-server config audioFormat flac

# Change audio quality ('0' for best/lossless, or '320k', '256k')
media-server config audioQuality 0

# Change folder and file naming template
media-server config namingFormat "{albumArtist}/{album}/{track} - {title}"

# Set preferred source ('auto', 'ytm', 'netease')
media-server config preferredSource auto

# Optional: set cookie file for yt-dlp if datacenter IP encounters YouTube bot challenges
media-server config cookieFile "/path/to/cookies.txt"
```

---

## 🧪 Testing

To run the automated test suites:

```bash
# Standard metadata and download unit tests
npm test

# YouTube Music integration & bilingual lyrics test
node test/ytm_and_lyrics.test.js
```

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See the [LICENSE](./LICENSE) file for details.
