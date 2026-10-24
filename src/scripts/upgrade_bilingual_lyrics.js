#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { generateBilingualLyrics, parseLrc, hasChineseText } from '../services/lyrics_translator.js';
import { triggerNavidromeScan } from '../services/navidrome.js';

const DB_PATH = '/home/suki/project/navidrome/data/navidrome.db';
const MUSIC_DIR = '/home/suki/gdrive/Music Library';

async function main() {
  console.log('🎵 Starting bilingual lyrics synchronization (NetEase -> Google Translate fallback)...');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const songs = db.prepare('SELECT id, title, artist, path, lyrics FROM media_file').all();
  console.log(`📚 Total songs in Navidrome library: ${songs.length}`);

  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const prefix = `[${i + 1}/${songs.length}] ${s.artist} - ${s.title}`;

    // Check if already bilingual
    if (s.lyrics && hasChineseText(s.lyrics)) {
      skippedCount++;
      continue;
    }

    // Check local .lrc file if exists
    const lrcRelative = s.path.replace(/\.[^.]+$/, '.lrc');
    const lrcFull = path.join(MUSIC_DIR, lrcRelative);
    let existingLrc = '';

    if (fs.existsSync(lrcFull)) {
      try {
        existingLrc = fs.readFileSync(lrcFull, 'utf-8');
        if (hasChineseText(existingLrc)) {
          skippedCount++;
          continue;
        }
      } catch (_) {}
    }

    // If no existing .lrc, extract from DB
    if (!existingLrc && s.lyrics) {
      try {
        const parsed = JSON.parse(s.lyrics);
        const synced = parsed.find(g => g.synced && Array.isArray(g.line));
        if (synced) {
          existingLrc = synced.line.map(l => {
            const min = Math.floor(l.start / 60000);
            const sec = Math.floor((l.start % 60000) / 1000);
            const ms = Math.floor((l.start % 1000) / 10);
            const timeStr = `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(2, '0')}]`;
            return `${timeStr}${l.value}`;
          }).join('\n');
        }
      } catch (_) {}
    }

    try {
      const res = await generateBilingualLyrics(s.title, s.artist, existingLrc);
      if (res && res.bilingualLrc && hasChineseText(res.bilingualLrc)) {
        // Write to .lrc
        fs.writeFileSync(lrcFull, res.bilingualLrc, 'utf-8');

        // Write to DB
        const parsed = parseLrc(res.bilingualLrc).filter(p => p.timeMs !== undefined && p.text);
        const lines = parsed.map(p => ({ start: p.timeMs, value: p.text }));
        const dbLyrics = JSON.stringify([
          { lang: 'zh-Hans', synced: true, line: lines }
        ]);
        db.prepare('UPDATE media_file SET lyrics = ? WHERE id = ?').run(dbLyrics, s.id);

        console.log(`  ✅ ${prefix} (${res.source})`);
        updatedCount++;
      } else {
        failedCount++;
      }
    } catch (err) {
      console.warn(`  ⚠️ ${prefix}: ${err.message}`);
      failedCount++;
    }

    // Small delay to prevent rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n📊 Synchronization finished:');
  console.log(`   Updated to bilingual: ${updatedCount}`);
  console.log(`   Already bilingual / skipped: ${skippedCount}`);
  console.log(`   No lyrics or translation: ${failedCount}`);

  if (updatedCount > 0) {
    console.log('\n🔄 Triggering Navidrome fast rescan...');
    try {
      await triggerNavidromeScan(false);
      console.log('✅ Navidrome rescan triggered successfully.');
    } catch (e) {
      console.warn('⚠️ Could not trigger Navidrome rescan:', e.message);
    }
  }
}

main().catch(console.error);
