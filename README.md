# 🎵 MediaServer Music CLI

**English** | [简体中文](./README_ZH.md)

A powerful Node.js global CLI tool to import Spotify playlists and tracks, resolve and download high-quality audio streams from free third-party sources (YouTube Music, SoundCloud, Netease Cloud Music), embed complete music metadata (ID3 tags, FLAC Vorbis comments, synchronized LRC/SYLT lyrics, ultra-high-resolution 1200×1200 cover art, ISRC codes, real composer credits), and automatically trigger Navidrome library updates.

---

## ✨ Features

- **Spotify Playlist & Track Importer**: Directly parses Spotify playlist URLs, track URLs, album URLs, Spotify URIs, or IDs without requiring any paid Spotify API developer account.
- **Multi-Source Audio Resolution**:
  - **YouTube Music / YouTube**: High-quality audio extraction (lossless FLAC or up to 320kbps MP3) via `yt-dlp` and `ffmpeg`, bypassing paywalls.
  - **Netease Cloud Music**: Alternative high-quality source via `NeteaseCloudMusicApi` with automatic fallback on VIP limits.
  - **SoundCloud**: Built-in automatic fallback audio provider.
- **Complete Lossless Metadata Embedding**:
  - Track Title, Artist, Album, Album Artist, Composer, Year/Date, Track Number, Total Tracks, Disc Number, Genre, and ISRC.
  - Embedded Front Cover Art (JPEG/PNG up to 1200×1200 resolution via Apple iTunes & Deezer APIs).
  - Embedded Unsynchronized Lyrics (`USLT` tag) & Synchronized Lyrics (`SYLT` millisecond tag).
  - Sidecar `.lrc` Synchronized Lyrics (standard timestamps `[mm:ss.xx]`).
  - Folder `cover.jpg` artwork for native media server indexing.
- **Navidrome Integration**:
  - Configurable file naming template (defaults to `{albumArtist}/{album}/{track} - {title}`).
  - Works directly with local storage or mounted Google Drive (`~/gdrive/Music Library`).
  - Automatically triggers rootless Podman/Docker Navidrome rescans.
  - Generates synchronized lyrics recognized by Navidrome's web player and Subsonic clients.
- **Interactive & Headless Modes**:
  - Interactive Terminal UI powered by `inquirer` with colored output and status spinners.
  - Full CLI command-line support for scripts, automation, and cron jobs.

---

## 🚀 Installation

Ensure `Node.js` (>= 18), `ffmpeg`, and `yt-dlp` are installed on your system.

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
4. `⚙️  4. Configuration & Settings`: View and change download path, audio format (FLAC/MP3), quality, lyrics options, naming format, etc.
5. `🔄 5. Trigger Navidrome Library Scan`: Manually force Navidrome to rescan the library.
6. `🩺 6. System Diagnostics & Health Check`: Check Node, FFmpeg, yt-dlp, and Navidrome health.
7. `🚪 7. Exit`: Quit.

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

#### Trigger Navidrome Library Rescan
```bash
media-server scan
```

#### System Diagnostics
```bash
media-server doctor
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

To run the automated test suite:

```bash
npm test
```

Test coverage includes:
- Spotify URL parsing & tracklist/album extraction
- Deezer ISRC code retrieval & catalog matching
- Apple iTunes 1200×1200 artwork and metadata enrichment
- Kugou & Netease LRC lyrics fetching and timestamp stripping
- ID3v2 (USLT / SYLT synced lyrics, cover art, ISRC) and FLAC tagging
- End-to-end download, tagging, and live Navidrome SQLite database verification

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See the [LICENSE](./LICENSE) file for details.
