#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import subprocess
from urllib.parse import unquote

COOKIE_FILE = os.environ.get('COOKIE_FILE', '/home/suki/project/media_server/youtube_cookies.txt')

def get_ytmusic_client():
    try:
        from ytmusicapi import YTMusic
        return YTMusic()
    except Exception as e:
        sys.stderr.write(f"YTMusic init error: {e}\n")
        return None

def search_songs(query, limit=10):
    ytm = get_ytmusic_client()
    if not ytm or not query:
        return []

    try:
        results = ytm.search(query, filter='songs', limit=limit)
        songs = []
        for r in results:
            video_id = r.get('videoId')
            if not video_id:
                continue

            thumbs = r.get('thumbnails', [])
            cover = thumbs[-1].get('url') if thumbs else ''
            if cover and '=' in cover:
                cover = cover.split('=')[0] + '=w544-h544-l90-rj'

            artists = ' / '.join([a.get('name', '') for a in r.get('artists', []) if a.get('name')])
            
            duration = 0
            dur_str = r.get('duration') or ''
            if dur_str:
                parts = dur_str.split(':')
                try:
                    if len(parts) == 2:
                        duration = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 3:
                        duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                except ValueError:
                    duration = 240

            year = 2024
            raw_year = r.get('year')
            if raw_year and str(raw_year).isdigit():
                year = int(raw_year)

            album_name = r.get('album', {}).get('name') if r.get('album') else 'YouTube Music'

            songs.append({
                'id': f"online_ytm_{video_id}",
                'rawId': video_id,
                'title': f"[YTM] {r.get('title', 'Unknown')}",
                'rawTitle': r.get('title', 'Unknown'),
                'artist': artists or 'Unknown Artist',
                'album': album_name or 'YouTube Music',
                'duration': duration or 240,
                'coverUrl': cover,
                'coverArt': f"online_cover_ytm_{video_id}",
                'year': year,
                'genre': 'YouTube Music'
            })
            if len(songs) >= limit:
                break
        return songs
    except Exception as e:
        sys.stderr.write(f"YTMusic search error: {e}\n")
        return []

def get_stream_url(video_id):
    if not video_id:
        return None
    url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = ['yt-dlp', '-g', url, '-f', 'ba/b']
    if os.path.exists(COOKIE_FILE):
        cmd.extend(['--cookies', COOKIE_FILE])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if proc.returncode == 0:
            lines = proc.stdout.strip().split('\n')
            for line in lines:
                if line.startswith('http'):
                    return line
    except Exception as e:
        sys.stderr.write(f"yt-dlp stream error: {e}\n")
    return None

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)
    
    action = sys.argv[1]
    arg = sys.argv[2]
    
    if action == 'search':
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10
        res = search_songs(arg, limit)
        print(json.dumps(res, ensure_ascii=False))
    elif action == 'stream':
        res = get_stream_url(arg)
        print(res or '')
