# 🎵 MediaServer 音乐 CLI 与 Navidrome 扩展代理

[English](./README.md) | **简体中文**

功能强大的 Node.js 全局命令行工具与 Subsonic 反向代理套件：支持免登录导入 Spotify 歌单与单曲、将 YouTube Music 云端曲库无缝挂载至 Navidrome（统一搜索、HTTP 206 边播边下载沉淀至本地库）、全自动注入全套音乐元数据（ID3/FLAC 标签、超清封面、真实作曲家），并内置中英混合标准双语歌词引擎（网易云官方翻译 + Google 翻译兜底）。

---

## ✨ 核心特性

- **Spotify 歌单/单曲免登录抓取**：
  - 无需 Spotify 开发者付费账户或 Token，直接解析公开歌单、专辑或单曲链接（支持 URL、URI 与 ID）。
  - 支持抓取曲目、歌手、专辑、原始时长、音轨位置及发行年份。
- **YouTube Music 虚拟曲库挂载与即时串流代理**：
  - **统一聚合搜索**：作为 Subsonic 反向代理层部署在 Navidrome 前端，拦截 Subsonic 接口（支持 Symfonium、Feishin、音流、DSub 等）及 Navidrome WebUI 原生搜索，同时聚合展示本地歌曲与 YouTube Music 歌曲（标注 `[YTM]` 标签）。
  - **HTTP 206 边播边下**：点击未入库的 YTM 歌曲即刻通过 HTTP 206 Range 分片实时串流播放，秒开无需缓冲等待。
  - **后台自动沉淀入库**：在播放串流的同时，后台自动调用 `yt-dlp` 下载最佳音质文件，抓取 iTunes/Deezer 超清封面与双语歌词，自动打标后存入永久媒体库（如 Google Drive 挂载目录），并通知 Navidrome 扫描入库。
- **中英混合标准双语歌词引擎 (YouTube Music 风格)**：
  - 生成严格同时间戳中英双语歌词（`[mm:ss.xx] 英文原词\n[mm:ss.xx] 简体中文翻译`），适配各类手机客户端与网页端播放器。
  - **第一优先级（网易云音乐）**：自动匹配网易云官方翻译歌词（`tlyric`），按时间戳与原文精确对齐。
  - **第二优先级（Google 翻译兜底）**：若无官方翻译或曲目未收录，自动调用 Google 翻译引擎批量逐句机翻为简体中文（`zh-CN` / `sc`）。
  - **即时动态补全与持久化回写**：客户端打开歌词时动态即时下发双语歌词，同时异步将双语歌词回写至本地 `.lrc` 文件与 Navidrome SQLite 数据库。
  - **全库历史歌词批量升级**：内置 `media-server translate` 命令，一键将音乐库中现有的全部历史单语歌词批量升级为中英双语歌词。
- **免 VIP / 跨平台高品质音源检索**：
  - **YouTube Music / YouTube**：利用 `yt-dlp` 与 `ffmpeg` 提取官方音频流，支持复用 Cookie 文件绕过验证。
  - **网易云音乐**：集成网易云检索，支持优先下载 320k / 无损音质，遇到 VIP 限制自动回退备选源。
  - **SoundCloud**：多重自动容灾音源兜底。
- **全套元数据无损注入**：
  - 自动打标：歌曲标题（Title）、艺术家（Artist）、专辑名（Album）、专辑艺术家（Album Artist）、真实作曲人（Composer）、发行年份（Year）、音轨号（Track Number）、分碟号（Disc Number）、曲风（Genre）、国际标准音像制品编码（ISRC）。
  - 印刷级超清封面：通过 Apple iTunes 及 Deezer API 补全最高 `1200×1200` 前封面。
  - 同步歌词：转换写入 ID3 `SYLT` 与 `USLT` 内嵌标签，并同目录输出标准 `.lrc` 文件与 `cover.jpg`。
- **Navidrome 实时同步联动**：
  - 下载完成后，自动向 Navidrome 容器发送扫描指令，即刻在 WebUI 与手机客户端刷新展示。
  - 支持直接将工作目录映射为 Google Drive（通过 rclone 挂载）。
- **多种运行模式**：
  - 交互式终端图形菜单（TUI）：直观的可视化选择与进度条展示。
  - 命令行子命令模式：方便脚本批处理、定时任务（cron）与管道自动化。

---

## 🚀 环境准备与安装

运行环境需支持 Node.js (>= 18)、Python 3、FFmpeg 以及 yt-dlp。

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

---

### 2. 常用命令行子命令

#### 导入并下载 Spotify 歌单或专辑
```bash
# 下载歌单中的全部歌曲
media-server playlist https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M

# 仅下载前 5 首歌曲
media-server playlist 37i9dQZF1DXcBWIGoYBM5M --limit 5

# 指定自定义下载输出目录
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

#### 批量将音乐库歌词升级为双语歌词（网易云翻译 -> Google 翻译兜底）
```bash
media-server translate
# 或者
media-server translate-lyrics
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

## 🌐 Navidrome Subsonic 代理服务与 YTM 串流

项目包含内置的反向代理与扩展服务（[`src/server/proxy.js`](file:///home/suki/project/media_server/src/server/proxy.js)），监听在 `127.0.0.1:4534`，上游对接 Navidrome（`127.0.0.1:4533`），由 Nginx 反向代理对外暴露。

### 主要功能：
1. **聚合搜索**：客户端搜索时，本地歌曲与 YouTube Music 歌曲（`[YTM]` 标签）合并返回。
2. **实时串流与沉淀**：点击 `[YTM]` 歌曲，服务端以 HTTP 206 实时边播边下载，自动打入标签与双语歌词并入库。
3. **双语歌词下发**：拦截客户端歌词请求，动态生成并下发中英双语歌词，同时持久化写入本地磁盘。

服务管理：
```bash
sudo systemctl status navidrome-proxy.service
sudo systemctl restart navidrome-proxy.service
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

# （可选）配置 yt-dlp cookie 文件（解决数据中心 IP 遇到 YouTube 机器人验证问题）
media-server config cookieFile "/path/to/cookies.txt"
```

---

## 🧪 自动化测试

项目内置完整的单元测试与端到端集成测试套件：

```bash
# 核心元数据与下载单元测试
npm test

# YouTube Music 搜索串流与双语歌词集成测试
node test/ytm_and_lyrics.test.js
```

---

## 📄 开源许可证

本项目基于 **GNU General Public License v3.0 (GPL-3.0)** 许可证开源。详细信息请参阅 [LICENSE](./LICENSE) 文件。
