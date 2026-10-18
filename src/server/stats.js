import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = '/home/suki/project/navidrome/data/navidrome.db';

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

/**
 * Format duration in seconds to human readable string (e.g. "12小时 34分钟" or "45分钟")
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0 分钟';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) {
    return `${hrs} 小时 ${mins} 分钟`;
  }
  return `${mins} 分钟`;
}

/**
 * Fetch comprehensive listening statistics for a user
 * @param {string} [targetUserName]
 * @param {number} [days] Filter by recent days (0 = all time)
 */
export function getMusicStats(targetUserName = 'jake', days = 0) {
  let db;
  try {
    db = getDb();
  } catch (err) {
    return { error: `Failed to open database: ${err.message}` };
  }

  try {
    // 1. Get user
    const users = db.prepare('SELECT id, user_name, name, is_admin FROM user').all();
    let user = users.find(u => u.user_name.toLowerCase() === targetUserName.toLowerCase()) || users[0];

    if (!user) {
      return { error: 'No users found in database' };
    }

    const userId = user.id;

    // Filter timestamp
    let timeFilterSql = '';
    let timeParams = [userId];
    if (days > 0) {
      const minTimestamp = Math.floor(Date.now() / 1000) - (days * 86400);
      timeFilterSql = 'AND s.submission_time >= ?';
      timeParams.push(minTimestamp);
    }

    // 2. Total Scrobbles
    const totalScrobbles = db.prepare(`
      SELECT count(*) as count
      FROM scrobbles s
      WHERE s.user_id = ? ${timeFilterSql}
    `).get(...timeParams)?.count || 0;

    // 3. Total Playtime & Uniques from Scrobbles
    const totals = db.prepare(`
      SELECT sum(mf.duration) as total_duration,
             count(DISTINCT mf.id) as unique_songs,
             count(DISTINCT mf.artist) as unique_artists,
             count(DISTINCT mf.album) as unique_albums
      FROM scrobbles s
      JOIN media_file mf ON s.media_file_id = mf.id
      WHERE s.user_id = ? ${timeFilterSql}
    `).get(...timeParams) || {};

    const totalDurationSecs = Math.round(totals.total_duration || 0);

    // 4. Top Tracks (from scrobbles during filter period, fallback to annotation if 0)
    let topTracks = [];
    if (days > 0 || totalScrobbles > 0) {
      topTracks = db.prepare(`
        SELECT mf.id, mf.title, mf.artist, mf.album, mf.album_id, mf.duration,
               count(s.id) as plays, max(s.submission_time) as last_scrobble
        FROM scrobbles s
        JOIN media_file mf ON s.media_file_id = mf.id
        WHERE s.user_id = ? ${timeFilterSql}
        GROUP BY mf.id
        ORDER BY plays DESC, last_scrobble DESC
        LIMIT 20
      `).all(...timeParams);
    }

    if (topTracks.length === 0 && days === 0) {
      topTracks = db.prepare(`
        SELECT mf.id, mf.title, mf.artist, mf.album, mf.album_id, mf.duration,
               max(a.play_count, 1) as plays, a.play_date
        FROM annotation a
        JOIN media_file mf ON a.item_id = mf.id
        WHERE a.item_type = 'media_file' AND a.user_id = ?
        ORDER BY plays DESC, a.play_date DESC
        LIMIT 20
      `).all(userId);
    }

    // 5. Top Artists
    const topArtists = db.prepare(`
      SELECT mf.artist as name, mf.artist_id as id, count(s.id) as plays
      FROM scrobbles s
      JOIN media_file mf ON s.media_file_id = mf.id
      WHERE s.user_id = ? ${timeFilterSql}
      GROUP BY mf.artist
      ORDER BY plays DESC
      LIMIT 10
    `).all(...timeParams);

    // 6. Top Albums
    const topAlbums = db.prepare(`
      SELECT mf.album as name, mf.album_artist as artist, mf.album_id as id, count(s.id) as plays
      FROM scrobbles s
      JOIN media_file mf ON s.media_file_id = mf.id
      WHERE s.user_id = ? ${timeFilterSql}
      GROUP BY mf.album
      ORDER BY plays DESC
      LIMIT 10
    `).all(...timeParams);

    // 7. Hourly Listening Distribution (24-hour clock)
    const hourlyRows = db.prepare(`
      SELECT strftime('%H', datetime(s.submission_time, 'unixepoch', 'localtime')) as hour, count(*) as count
      FROM scrobbles s
      WHERE s.user_id = ? ${timeFilterSql}
      GROUP BY hour
      ORDER BY hour
    `).all(...timeParams);

    const hourly = {};
    for (let h = 0; h < 24; h++) {
      hourly[String(h).padStart(2, '0')] = 0;
    }
    for (const r of hourlyRows) {
      if (r.hour) hourly[r.hour] = r.count;
    }

    // 8. Day of week distribution
    const weekdayRows = db.prepare(`
      SELECT strftime('%w', datetime(s.submission_time, 'unixepoch', 'localtime')) as day, count(*) as count
      FROM scrobbles s
      WHERE s.user_id = ? ${timeFilterSql}
      GROUP BY day
      ORDER BY day
    `).all(...timeParams);

    const weekdays = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    for (const r of weekdayRows) {
      if (r.day !== null) weekdays[r.day] = r.count;
    }

    // 9. Recent Activity Timeline (Last 20 scrobbles)
    const recent = db.prepare(`
      SELECT s.id as scrobble_id, s.submission_time, mf.id as song_id, mf.album_id, mf.title, mf.artist, mf.album, mf.duration
      FROM scrobbles s
      JOIN media_file mf ON s.media_file_id = mf.id
      WHERE s.user_id = ?
      ORDER BY s.submission_time DESC
      LIMIT 20
    `).all(userId);

    // 10. Starred / Favorites count
    const starredCount = db.prepare(`
      SELECT count(*) as count
      FROM annotation
      WHERE user_id = ? AND item_type = 'media_file' AND starred = 1
    `).get(userId)?.count || 0;

    // 11. Library Totals
    const libTotals = db.prepare(`
      SELECT (SELECT count(*) FROM media_file) as total_files,
             (SELECT count(*) FROM album) as total_albums,
             (SELECT count(*) FROM artist) as total_artists,
             (SELECT count(*) FROM playlist) as total_playlists
    `).get() || {};

    // Determine Listening Persona
    let persona = '音乐探险家';
    let personaDesc = '热爱广泛探索不同曲风与艺术家的音乐爱好者。';
    const topArtistName = topArtists[0]?.name;
    if (totalScrobbles > 50) {
      persona = '全天候高能乐迷';
      personaDesc = '音乐是你不可分割的日常能量源泉。';
    } else if (hourly['22'] + hourly['23'] + hourly['00'] + hourly['01'] > (totalScrobbles * 0.35)) {
      persona = '深夜漫游诗人';
      personaDesc = '擅长在夜深人静时与旋律共鸣，独享夜间纯粹之音。';
    } else if (topArtistName && topArtists[0]?.plays > (totalScrobbles * 0.4)) {
      persona = `${topArtistName} 忠实拥趸`;
      personaDesc = `对 ${topArtistName} 的作品拥有极高偏好度与无限热爱。`;
    }

    return {
      success: true,
      user,
      allUsers: users.map(u => ({ id: u.id, username: u.user_name, name: u.name })),
      filterDays: days,
      stats: {
        totalScrobbles,
        totalDurationSecs,
        totalDurationFormatted: formatDuration(totalDurationSecs),
        uniqueSongs: totals.unique_songs || 0,
        uniqueArtists: totals.unique_artists || 0,
        uniqueAlbums: totals.unique_albums || 0,
        starredCount,
        persona,
        personaDesc
      },
      topTracks,
      topArtists,
      topAlbums,
      hourly,
      weekdays,
      recent,
      library: libTotals
    };
  } finally {
    db.close();
  }
}

/**
 * Render the full interactive Listening Stats & Report Dashboard HTML
 */
export function renderStatsHtml(userName = 'jake') {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Veyino Music 听歌数据统计与报告</title>
  <link rel="icon" href="/favicon.ico">
  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;700;900&display=swap" rel="stylesheet">
  <!-- Chart.js & html2canvas -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <style>
    :root {
      --bg: #0b0d14;
      --card-bg: rgba(22, 27, 46, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-hover: rgba(30, 38, 64, 0.85);
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --accent: #ec4899;
      --accent-glow: rgba(236, 72, 153, 0.35);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --radius: 18px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 85% 85%, rgba(236, 72, 153, 0.12) 0%, transparent 45%),
        radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.05) 0%, transparent 60%);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', 'Noto Sans SC', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 24px 20px 80px 20px;
      line-height: 1.5;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    /* Header Nav */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 8px 24px var(--primary-glow);
    }

    .brand h1 {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(120deg, #fff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 18px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 12px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.25s ease;
      border: 1px solid var(--card-border);
      color: var(--text);
      background: var(--card-bg);
      backdrop-filter: blur(12px);
    }

    .btn:hover {
      background: var(--card-hover);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary), var(--accent));
      border: none;
      box-shadow: 0 4px 18px var(--primary-glow);
    }

    .btn-primary:hover {
      opacity: 0.95;
      box-shadow: 0 6px 24px var(--accent-glow);
      transform: translateY(-2px);
    }

    /* Filters Bar */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .pill-group {
      display: flex;
      background: rgba(15, 23, 42, 0.6);
      padding: 4px;
      border-radius: 14px;
      border: 1px solid var(--card-border);
    }

    .pill {
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
      background: transparent;
      border: none;
    }

    .pill.active {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 2px 10px var(--primary-glow);
    }

    /* Persona Banner */
    .persona-card {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(236, 72, 153, 0.12));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius);
      padding: 24px 28px;
      margin-bottom: 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
      backdrop-filter: blur(16px);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
    }

    .persona-info h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--accent);
      margin-bottom: 6px;
    }

    .persona-title {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }

    .persona-desc {
      color: var(--text-muted);
      font-size: 14px;
      max-width: 600px;
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-bottom: 32px;
    }

    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 22px;
      backdrop-filter: blur(12px);
      transition: transform 0.2s ease, border-color 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .kpi-card:hover {
      transform: translateY(-3px);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .kpi-icon {
      font-size: 24px;
      margin-bottom: 12px;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .kpi-value {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -1px;
      margin-bottom: 4px;
    }

    .kpi-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Main Content Layout */
    .content-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
      margin-bottom: 32px;
    }

    @media (max-width: 900px) {
      .content-grid { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 24px;
      backdrop-filter: blur(12px);
      margin-bottom: 24px;
    }

    .card-title {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Top Songs List */
    .track-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .track-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 12px;
      transition: background 0.2s ease;
    }

    .track-row:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    .track-rank {
      width: 24px;
      font-size: 14px;
      font-weight: 800;
      color: var(--text-muted);
      text-align: center;
    }

    .track-rank.top1 { color: #f59e0b; font-size: 16px; }
    .track-rank.top2 { color: #94a3b8; font-size: 16px; }
    .track-rank.top3 { color: #b45309; font-size: 16px; }

    .track-cover {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      object-fit: cover;
      background: #1e293b;
      flex-shrink: 0;
    }

    .track-details {
      flex: 1;
      min-width: 0;
    }

    .track-title {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }

    .track-artist {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .track-plays {
      font-size: 13px;
      font-weight: 700;
      color: var(--primary);
      padding: 4px 10px;
      background: rgba(99, 102, 241, 0.12);
      border-radius: 20px;
      flex-shrink: 0;
    }

    /* Artist / Album Cards */
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 14px;
    }

    .mini-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 14px;
      padding: 12px;
      text-align: center;
      transition: all 0.2s ease;
    }

    .mini-item:hover {
      background: rgba(255, 255, 255, 0.06);
      transform: translateY(-2px);
    }

    .mini-item img {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      object-fit: cover;
      margin: 0 auto 10px auto;
      display: block;
      background: #1e293b;
    }

    .mini-item.album-item img {
      border-radius: 10px;
    }

    .mini-name {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }

    .mini-sub {
      font-size: 11px;
      color: var(--text-muted);
    }

    /* Recent Scrobble Timeline */
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .timeline-item {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .timeline-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .timeline-time {
      font-size: 11px;
      color: var(--text-muted);
      width: 70px;
      flex-shrink: 0;
    }

    /* Share Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(10px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal-content {
      background: #121626;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 24px;
      max-width: 480px;
      width: 100%;
      overflow: hidden;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
      animation: popIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes popIn {
      from { transform: scale(0.92); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    /* Report Card Design */
    .report-card {
      background: linear-gradient(145deg, #181c33 0%, #0d1020 100%);
      padding: 32px 28px;
      color: #fff;
      position: relative;
      overflow: hidden;
    }

    .report-card::before {
      content: '';
      position: absolute;
      top: -60px;
      right: -60px;
      width: 180px;
      height: 180px;
      background: radial-gradient(circle, var(--accent) 0%, transparent 70%);
      opacity: 0.4;
      pointer-events: none;
    }

    .report-card::after {
      content: '';
      position: absolute;
      bottom: -60px;
      left: -60px;
      width: 180px;
      height: 180px;
      background: radial-gradient(circle, var(--primary) 0%, transparent 70%);
      opacity: 0.4;
      pointer-events: none;
    }

    .card-header-badge {
      display: inline-block;
      padding: 4px 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-bottom: 12px;
      color: #a5b4fc;
    }

    .report-card h3 {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 4px;
    }

    .report-stats-row {
      display: flex;
      gap: 16px;
      margin: 20px 0;
      padding: 14px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 14px;
    }

    .report-stat-col {
      flex: 1;
    }

    .report-stat-num {
      font-size: 22px;
      font-weight: 800;
      color: #38bdf8;
    }

    .report-stat-txt {
      font-size: 11px;
      color: var(--text-muted);
    }

    .report-songs-list {
      margin: 16px 0;
    }

    .report-song-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      margin-bottom: 8px;
    }

    .report-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      color: var(--text-muted);
    }

    .modal-actions {
      padding: 16px 24px;
      background: rgba(0, 0, 0, 0.3);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-logo">📊</div>
        <div>
          <h1>Veyino Music 听歌数据洞察</h1>
          <p>实时播放统计 · 听歌偏好分析 · 专属音乐报告</p>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary" onclick="openShareModal()">
          ✨ 生成专属报告卡片
        </button>
        <a href="/wrapped/" class="btn" target="_blank">
          🎭 Spotify Wrapped 故事
        </a>
        <a href="/" class="btn">
          🎵 进入播放器
        </a>
      </div>
    </header>

    <!-- Filter & Persona -->
    <div class="filter-bar">
      <div class="pill-group" id="timeFilters">
        <button class="pill active" onclick="loadStats(0)">全部时间</button>
        <button class="pill" onclick="loadStats(30)">最近 30 天</button>
        <button class="pill" onclick="loadStats(7)">最近 7 天</button>
        <button class="pill" onclick="loadStats(1)">今天</button>
      </div>
      <div style="font-size: 13px; color: var(--text-muted);" id="userIndicator">
        正在分析用户：<strong>${userName}</strong>
      </div>
    </div>

    <!-- Persona Card -->
    <div class="persona-card" id="personaCard">
      <div class="persona-info">
        <h2>🎵 专属音乐人设</h2>
        <div class="persona-title" id="personaTitle">加载中...</div>
        <div class="persona-desc" id="personaDesc">正在根据你的历史听歌数据计算...</div>
      </div>
      <button class="btn btn-primary" onclick="openShareModal()">
        📸 导出报告海报
      </button>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-icon">🎧</div>
        <div class="kpi-value" id="kpiScrobbles">0</div>
        <div class="kpi-label">累计播放次数 (Scrobbles)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon">⏳</div>
        <div class="kpi-value" id="kpiDuration">0 分钟</div>
        <div class="kpi-label">累计聆听时长</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon">🎶</div>
        <div class="kpi-value" id="kpiSongs">0</div>
        <div class="kpi-label">听过的不同单曲</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon">👨‍🎤</div>
        <div class="kpi-value" id="kpiArtists">0</div>
        <div class="kpi-label">探索的音乐人</div>
      </div>
    </div>

    <!-- Main Content Layout -->
    <div class="content-grid">
      <!-- Left Column: Top Songs & Clock -->
      <div>
        <div class="card">
          <div class="card-title">
            <span>🏆 最常播放单曲榜 (Top Tracks)</span>
            <span style="font-size: 12px; color: var(--text-muted);" id="trackCountLabel">Top 15</span>
          </div>
          <div class="track-list" id="topTracksList">
            <div style="color: var(--text-muted); font-size: 13px;">加载中...</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>🕒 24 小时听歌生物钟 (Listening Clock)</span>
            <span style="font-size: 12px; color: var(--text-muted);">一天中的时间偏好</span>
          </div>
          <div style="height: 220px;">
            <canvas id="clockChart"></canvas>
          </div>
        </div>
      </div>

      <!-- Right Column: Top Artists, Albums & Recent -->
      <div>
        <div class="card">
          <div class="card-title">
            <span>🎤 最爱艺术家 (Top Artists)</span>
          </div>
          <div class="mini-grid" id="topArtistsList">
            <div style="color: var(--text-muted); font-size: 13px;">加载中...</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>💿 最常听专辑 (Top Albums)</span>
          </div>
          <div class="mini-grid" id="topAlbumsList">
            <div style="color: var(--text-muted); font-size: 13px;">加载中...</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>⚡ 最近播放动态 (Recent Activity)</span>
          </div>
          <div class="timeline" id="recentList">
            <div style="color: var(--text-muted); font-size: 13px;">加载中...</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Shareable Report Card Modal -->
  <div class="modal-backdrop" id="shareModal" onclick="closeShareModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div id="captureArea" class="report-card">
        <span class="card-header-badge">VEYINO MUSIC · 听歌年报</span>
        <h3 id="cardUserName">Jake's Music Report</h3>
        <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 12px;" id="cardPersonaDesc">
          深夜漫游诗人 · 沉浸在旋律世界的纯粹之声
        </p>

        <div class="report-stats-row">
          <div class="report-stat-col">
            <div class="report-stat-num" id="cardPlays">0</div>
            <div class="report-stat-txt">总听歌次数</div>
          </div>
          <div class="report-stat-col">
            <div class="report-stat-num" id="cardTime">0h</div>
            <div class="report-stat-txt">总聆听时长</div>
          </div>
          <div class="report-stat-col">
            <div class="report-stat-num" id="cardArtists">0</div>
            <div class="report-stat-txt">相伴歌手</div>
          </div>
        </div>

        <div style="font-size: 12px; font-weight: 700; color: #a5b4fc; margin-bottom: 8px;">
          ✦ 我的年度单曲 TOP 5
        </div>
        <div class="report-songs-list" id="cardTopSongs">
          <!-- Loaded dynamically -->
        </div>

        <div class="report-footer">
          <div>music.veyino.xyz</div>
          <div>生成于 ${new Date().toLocaleDateString('zh-CN')}</div>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn" onclick="closeShareModal()">关闭</button>
        <button class="btn btn-primary" onclick="downloadReportCard()">
          💾 下载海报图片
        </button>
      </div>
    </div>
  </div>

  <script>
    let currentStats = null;
    let clockChartInstance = null;

    async function loadStats(days = 0) {
      // Update pills
      document.querySelectorAll('#timeFilters .pill').forEach((p, idx) => {
        p.classList.remove('active');
        if ((days === 0 && idx === 0) || (days === 30 && idx === 1) || (days === 7 && idx === 2) || (days === 1 && idx === 3)) {
          p.classList.add('active');
        }
      });

      try {
        const res = await fetch('/api/stats?days=' + days);
        const data = await res.json();
        currentStats = data;
        renderDashboard(data);
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
    }

    function renderDashboard(data) {
      if (!data || !data.stats) return;

      // KPIs
      document.getElementById('kpiScrobbles').textContent = data.stats.totalScrobbles.toLocaleString();
      document.getElementById('kpiDuration').textContent = data.stats.totalDurationFormatted;
      document.getElementById('kpiSongs').textContent = data.stats.uniqueSongs.toLocaleString();
      document.getElementById('kpiArtists').textContent = data.stats.uniqueArtists.toLocaleString();

      // Persona
      document.getElementById('personaTitle').textContent = data.stats.persona;
      document.getElementById('personaDesc').textContent = data.stats.personaDesc;

      // Top Tracks
      const trackContainer = document.getElementById('topTracksList');
      if (data.topTracks && data.topTracks.length > 0) {
        trackContainer.innerHTML = data.topTracks.slice(0, 15).map((t, idx) => {
          const rankClass = idx === 0 ? 'top1' : idx === 1 ? 'top2' : idx === 2 ? 'top3' : '';
          const coverUrl = '/rest/getCoverArt?id=al-' + t.album_id + '&size=100';
          return \`
            <div class="track-row">
              <div class="track-rank \${rankClass}">\${idx + 1}</div>
              <img class="track-cover" src="\${coverUrl}" onerror="this.src='/favicon.ico'">
              <div class="track-details">
                <div class="track-title" title="\${t.title}">\${t.title}</div>
                <div class="track-artist">\${t.artist} · \${t.album || ''}</div>
              </div>
              <div class="track-plays">\${t.plays} 次</div>
            </div>
          \`;
        }).join('');
      } else {
        trackContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">所选时间段暂无播放记录</div>';
      }

      // Top Artists
      const artistContainer = document.getElementById('topArtistsList');
      if (data.topArtists && data.topArtists.length > 0) {
        artistContainer.innerHTML = data.topArtists.slice(0, 8).map(a => {
          const artistImg = '/rest/getCoverArt?id=ar-' + a.id + '&size=160';
          return \`
            <div class="mini-item">
              <img src="\${artistImg}" onerror="this.src='/favicon.ico'">
              <div class="mini-name" title="\${a.name}">\${a.name}</div>
              <div class="mini-sub">\${a.plays} 次播放</div>
            </div>
          \`;
        }).join('');
      } else {
        artistContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">暂无数据</div>';
      }

      // Top Albums
      const albumContainer = document.getElementById('topAlbumsList');
      if (data.topAlbums && data.topAlbums.length > 0) {
        albumContainer.innerHTML = data.topAlbums.slice(0, 8).map(al => {
          const albumCover = '/rest/getCoverArt?id=al-' + al.id + '&size=160';
          return \`
            <div class="mini-item album-item">
              <img src="\${albumCover}" onerror="this.src='/favicon.ico'">
              <div class="mini-name" title="\${al.name}">\${al.name}</div>
              <div class="mini-sub">\${al.artist} · \${al.plays} 次</div>
            </div>
          \`;
        }).join('');
      } else {
        albumContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">暂无数据</div>';
      }

      // Recent Activity
      const recentContainer = document.getElementById('recentList');
      if (data.recent && data.recent.length > 0) {
        recentContainer.innerHTML = data.recent.slice(0, 10).map(r => {
          const d = new Date(r.submission_time * 1000);
          const timeStr = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
          return \`
            <div class="timeline-item">
              <div class="timeline-time">\${timeStr}</div>
              <div class="track-details">
                <div class="track-title">\${r.title}</div>
                <div class="track-artist">\${r.artist}</div>
              </div>
            </div>
          \`;
        }).join('');
      } else {
        recentContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">暂无近期动态</div>';
      }

      // Render Clock Chart
      renderClockChart(data.hourly);
    }

    function renderClockChart(hourlyData) {
      const ctx = document.getElementById('clockChart').getContext('2d');
      const labels = Object.keys(hourlyData).map(h => h + ':00');
      const values = Object.values(hourlyData);

      if (clockChartInstance) {
        clockChartInstance.destroy();
      }

      clockChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: '播放次数',
            data: values,
            backgroundColor: 'rgba(99, 102, 241, 0.65)',
            borderColor: '#6366f1',
            borderWidth: 1,
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#64748b', font: { size: 10 } }
            },
            y: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#64748b', stepSize: 1, font: { size: 10 } }
            }
          }
        }
      });
    }

    // Modal & Share Card
    function openShareModal() {
      if (!currentStats) return;
      const s = currentStats.stats;
      const u = currentStats.user;

      document.getElementById('cardUserName').textContent = (u.name || u.user_name) + ' 的音乐旅程';
      document.getElementById('cardPersonaDesc').textContent = s.persona + ' · ' + s.personaDesc;
      document.getElementById('cardPlays').textContent = s.totalScrobbles;
      document.getElementById('cardTime').textContent = Math.round(s.totalDurationSecs / 3600 * 10) / 10 + 'h';
      document.getElementById('cardArtists').textContent = s.uniqueArtists;

      const top5Container = document.getElementById('cardTopSongs');
      if (currentStats.topTracks && currentStats.topTracks.length > 0) {
        top5Container.innerHTML = currentStats.topTracks.slice(0, 5).map((t, idx) => \`
          <div class="report-song-item">
            <span style="font-weight: 800; color: #f59e0b; width: 16px;">\${idx + 1}</span>
            <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              <strong>\${t.title}</strong> · \${t.artist}
            </div>
            <span style="color:#a5b4fc; font-size:12px; font-weight:700;">\${t.plays}次</span>
          </div>
        \`).join('');
      }

      document.getElementById('shareModal').style.display = 'flex';
    }

    function closeShareModal(e) {
      document.getElementById('shareModal').style.display = 'none';
    }

    async function downloadReportCard() {
      const area = document.getElementById('captureArea');
      const canvas = await html2canvas(area, {
        scale: 2,
        backgroundColor: '#0d1020',
        useCORS: true
      });
      const link = document.createElement('a');
      link.download = 'VeyinoMusic-Report-' + Date.now() + '.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    }

    // Initialize
    loadStats(0);
  </script>
</body>
</html>`;
}
