import assert from 'assert';
import http from 'http';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('🧪 Starting integration tests for YouTube Music & Bilingual Lyrics...\n');

  // Test 1: Subsonic Search with YouTube Music
  console.log('Test 1: Subsonic search with YouTube Music (JSON)...');
  const searchRes = await fetchUrl('http://127.0.0.1:4534/rest/search3.view?query=Taylor%20Swift&f=json');
  assert.strictEqual(searchRes.status, 200);
  const searchJson = JSON.parse(searchRes.body);
  const songs = searchJson['subsonic-response']?.searchResult3?.song || [];
  console.log(`  -> Returned ${songs.length} songs`);
  const ytmSong = songs.find(s => s.id?.startsWith('online_ytm_'));
  assert.ok(ytmSong, 'Should find at least one online_ytm_ song');
  console.log(`  ✅ Found YTM track: ${ytmSong.title} (${ytmSong.artist}) [ID: ${ytmSong.id}]`);

  // Test 2: Bilingual Lyrics (Subsonic getLyricsBySongId for local song)
  console.log('\nTest 2: Subsonic getLyricsBySongId bilingual lyrics (Waiting For Love)...');
  const lyricsRes = await fetchUrl('http://127.0.0.1:4534/rest/getLyricsBySongId.view?id=3wpe05XnqkNf4dGqIQBUnU&f=json');
  assert.strictEqual(lyricsRes.status, 200);
  const lyricsJson = JSON.parse(lyricsRes.body);
  const lines = lyricsJson['subsonic-response']?.lyricsList?.structuredLyrics?.[0]?.line || [];
  assert.ok(lines.length > 0, 'Should have lyrics lines');
  const hasChinese = lines.some(l => /[\u4e00-\u9fa5]/.test(l.value));
  assert.ok(hasChinese, 'Should contain Chinese translated lines');
  console.log(`  ✅ Found ${lines.length} lines with synchronized Chinese translation!`);
  console.log(`     Sample: "${lines[4].value}"`);
  console.log(`     Sample: "${lines[5].value}"`);

  // Test 3: Audio Stream HTTP 206
  console.log('\nTest 3: Audio streaming for online track with HTTP 206 / Partial Content...');
  const rangeReq = await new Promise((resolve) => {
    const req = http.request('http://127.0.0.1:4534/rest/stream.view?id=online_ytm_SJKoWAd5ySo', {
      headers: { range: 'bytes=0-2047' }
    }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.end();
  });
  assert.strictEqual(rangeReq.status, 206, 'Should return HTTP 206 for range request');
  assert.strictEqual(rangeReq.headers['content-type'], 'audio/mpeg');
  console.log(`  ✅ Audio stream verified: HTTP 206, Content-Range: ${rangeReq.headers['content-range']}`);

  console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
