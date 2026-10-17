# 🎵 MediaServer 音乐 CLI 工具

[English](./README.md) | **简体中文**

功能强大的 Node.js 全局命令行工具：支持免登录导入 Spotify 歌单与单曲、免 VIP 解析第三方优质音源（YouTube Music、网易云音乐、SoundCloud 等）、自动抓取全套音乐元数据（ID3/FLAC Vorbis 标签、超清 1200×1200 专辑封面、同步动态 LRC/SYLT 歌词、ISRC 编码、真实作曲家），并全自动联动触发 Navidrome 媒体库实时入库。

---

## ✨ 核心特性

- **Spotify 歌单/单曲免登录抓取**：
  - 无需 Spotify 开发者付费账户或 Token，直接解析公开歌单、专辑或单曲链接（支持 URL、URI 与 ID）。
  - 支持抓取曲目、歌手、专辑、原始时长、音轨位置及发行年份。
- **免 VIP / 跨平台高品质音源检索**：
  - **YouTube Music / YouTube**：利用 `yt-dlp` 智能提取官方原版音频流，自动绕过国内平台 VIP 限制。
  - **网易云音乐**：集成网易云检索，支持优先下载 320k / 无损音质，遇到 VIP 限制自动秒级回退至备选源。
  - **SoundCloud**：多重自动容灾音源兜底。
- **全套元数据无损注入**：
  - 自动打标：歌曲标题（Title）、艺术家（Artist）、专辑名（Album）、专辑艺术家（Album Artist）、真实作曲人（Composer）、发行年份（Year）、音轨号（Track Number）、分碟号（Disc Number）、曲风（Genre）、国际标准音像制品编码（ISRC）。
  - 印刷级超清封面：通过 Apple iTunes 及 Deezer API 补全最高 `1200×1200` 甚至更高画质的前封面。
  - 同步歌词：调用酷狗及网易云开放接口，下载带毫秒级时间戳的动态歌词，自动转换为 ID3 `SYLT` 与 `USLT` 内嵌标签，并同目录输出标准 `.lrc` 文件。
  - 独立封面文件：同目录额外输出 `cover.jpg`，方便各媒体服务器本地扫描。
- **Navidrome 实时同步联动**：
  - 下载完成后，自动向 Navidrome 容器发送扫描指令，即刻在 WebUI 与手机客户端（Substreamer、Amplefin、Feishin 等）刷新展示。
  - 支持直接将工作目录映射为 Google Drive（通过 rclone 挂载）。
- **多种运行模式**：
  - 交互式终端图形菜单（TUI）：直观的可视化选择与进度条展示。
  - 命令行子命令模式：方便脚本批处理、定时任务（cron）与管道自动化。

---

## 🚀 环境准备与安装

运行环境需支持 Node.js (>= 18)、FFmpeg 以及 yt-dlp。

### 全局安装

```bash
cd /home/suki/project/media_server
npm install
sudo npm install -g .
```

安装完成后，系统将注册两个全局命令：
* **`media-server`**
* **`ms-music`**（简写）

---

## 💻 快速使用

### 1. 交互式菜单模式

在任意终端直接输入命令启动交互式 TUI：

```bash
media-server
# 或者
ms-music
```

菜单功能：
1. `📥 1. Parse & Download Spotify Playlist`：输入歌单链接或 ID，预览曲目列表并开始批量下载。
2. `🎵 2. Parse & Download Spotify Track`：输入单曲链接直接下载。
3. `🔍 3. Search & Download Song by Keyword`：按歌手或歌名进行搜索与下载。
4. `⚙️  4. Configuration & Settings`：配置下载工作目录、音频格式（flac/mp3）、音质、歌词等。
5. `🔄 5. Trigger Navidrome Library Scan`：主动命令 Navidrome 扫描新入库的音乐。
6. `🩺 6. System Diagnostics & Health Check`：环境健康检查（Node、FFmpeg、yt-dlp、Navidrome 连通性）。
7. `🚪 7. Exit`：退出。

---

### 2. 命令行直接调用（Subcommands）

#### 下载 Spotify 歌单 / 专辑
```bash
# 下载指定歌单内所有曲目
media-server playlist https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M

# 仅下载前 5 首测试
media-server playlist 37i9dQZF1DXcBWIGoYBM5M --limit 5

# 指定自定义输出目录
media-server playlist 37i9dQZF1DXcBWIGoYBM5M --out "/home/suki/gdrive/Music Library"
```

#### 下载单首 Spotify 曲目
```bash
media-server track https://open.spotify.com/track/3XmwAZpIMNpTJy8faw3ajD
```

#### 关键词免链接搜索下载
```bash
media-server search "The Weeknd Blinding Lights"
media-server search "周杰伦 晴天"
```

#### 手动触发 Navidrome 刷新扫描
```bash
media-server scan
```

#### 系统自检
```bash
media-server doctor
```

---

## ⚙️ 配置说明

配置文件持久化保存在用户家目录：`~/.config/media-server/config.json`。

### 查看当前配置
```bash
media-server config
```

### 修改配置示例
```bash
# 修改默认下载/工作路径（例如设为 Google Drive 挂载路径）
media-server config downloadPath "/home/suki/gdrive/Music Library"

# 设置音频格式为无损 FLAC（可选：flac 或 mp3）
media-server config audioFormat flac

# 设置音质参数（0 为最高无损/最佳质量，或 320k/256k）
media-server config audioQuality 0

# 修改目录与文件命名模板（默认：{albumArtist}/{album}/{track} - {title}）
media-server config namingFormat "{albumArtist}/{album}/{track} - {title}"

# 设置优先音源（可选：auto、ytm、netease）
media-server config preferredSource auto

# （可选）配置 yt-dlp cookie 文件（解决个别数据中心 IP 遇到 YouTube 机器人验证问题）
media-server config cookieFile "/path/to/cookies.txt"
```

---

## 🧪 自动化测试

项目内置完整的单元测试与端到端集成测试套件：

```bash
npm test
```

测试覆盖范围：
- Spotify URL 解析及歌单/专辑/单曲提取
- Deezer ISRC 编码检索与专辑位置关联
- Apple iTunes 1200×1200 超清封面与多国元数据获取
- 酷狗/网易云 LRC 歌词解析、时间戳清洗与作曲家提取
- ID3v2 标签写入（USLT / SYLT 毫秒级同步歌词、封面及 ISRC）
- FLAC Vorbis Comment 标签写入与测试
- 完整下载、打标与 Navidrome 容器内部 SQLite 数据库索引端到端实测

---

## 📄 开源许可证

本项目基于 **GNU General Public License v3.0 (GPL-3.0)** 许可证开源。详细信息请参阅 [LICENSE](./LICENSE) 文件。
