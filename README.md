# WatchTogether

Watch the same movie at the same moment as friends anywhere in the world — synced play/pause/seek, a shared movie library with uploads, live room chat, and a trivia game with shared scores.

No frameworks, no npm install. One Node.js file is the whole backend.

## Run it on your computer

1. Install Node.js (v18 or newer) from https://nodejs.org
2. Open a terminal in this folder and run:

```
node server.js
```

3. Open http://localhost:3000 in Chrome
4. Enter your name and a room code (e.g. `MOVIE-NITE`) and join
5. Upload a movie file, click it in the library, and press **Play for everyone**

Anyone who joins with the same room code gets synced playback, sees the chat, and shares the trivia scoreboard.

### Testing with two "people" on one computer

Open http://localhost:3000 in two different browser windows, join the same room code with different names, and press play in one window — the other follows.

### Friends on the same wifi

They can join using your local IP, e.g. `http://192.168.1.24:3000` (find yours with `ipconfig` on Windows or `ifconfig` on Mac/Linux).

## Put it on the internet (so friends in other countries can join)

The folder deploys as-is to any Node host. Two easy options:

**Railway / Render (simplest):**
1. Push this folder to a GitHub repository
2. Create a new project on https://railway.app or https://render.com and connect the repo
3. Start command: `node server.js` — the platform sets the PORT automatically
4. Share the URL it gives you

**A VPS (DigitalOcean, Hetzner, etc.):**
1. Copy the folder to the server, install Node
2. Run `node server.js` (use `pm2` or a systemd service to keep it alive)
3. Put nginx or Caddy in front for HTTPS — required for camera access in browsers

Note: uploaded movies are stored on the server's disk in `./movies`. On free hosting tiers, disk space is limited and may reset on redeploy — a VPS or attached volume is better for real use.

## What's included vs. what's next

| Feature | Status |
|---|---|
| Synced play / pause / seek across everyone in a room | ✅ Working |
| Movie upload + shared library (mp4, webm, mkv, mov, m4v, ogg) | ✅ Working |
| Video streaming with seek support (HTTP Range) | ✅ Working |
| Live room chat | ✅ Working |
| Trivia game with shared scores | ✅ Working |
| Multiple rooms at once | ✅ Working |
| Your own webcam preview tile | ✅ Local only |
| Live face-to-face video between friends | 🔜 Needs WebRTC + a TURN server — the natural next step |
| Accounts / passwords for rooms | 🔜 Not yet — anyone with the room code can join |

## Important

Only upload and stream videos you have the rights to share. Streaming copyrighted movies to other people without permission is illegal in most countries — use your own recordings, licensed content, or open-licensed films.
