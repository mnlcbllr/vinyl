# yt·mp3 — Electron Player

A private YouTube audio player. Uses **youtubei.js** (the same InnerTube approach as [FreeTube](https://github.com/FreeTubeApp/FreeTube)) for search and metadata — no API key required. Uses **yt-dlp** for actual MP3 downloads.

## Prerequisites

- **Node.js** 18+
- **yt-dlp** installed and on your PATH
  - macOS: `brew install yt-dlp`
  - Linux: `sudo pip install yt-dlp` or grab the binary from https://github.com/yt-dlp/yt-dlp/releases
  - Windows: `winget install yt-dlp` or grab the `.exe` from releases
- **ffmpeg** installed and on your PATH (used by yt-dlp for audio conversion)
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
  - Windows: https://ffmpeg.org/download.html

## Install & Run

```bash
npm install
npm start
```

For dev mode (with DevTools):

```bash
npm run dev
```

## How it works

```
┌─────────────────────────────────────────────────┐
│  Electron Renderer (src/index.html)             │
│  · Tailwind UI                                  │
│  · Calls http://localhost:3847 for search/info  │
└───────────────────┬─────────────────────────────┘
                    │ HTTP (loopback only)
┌───────────────────▼─────────────────────────────┐
│  Express API Server (server.mjs)                │
│                                                 │
│  GET  /search?q=    → youtubei.js InnerTube     │
│  GET  /info?id=     → youtubei.js InnerTube     │
│  GET  /trending     → youtubei.js InnerTube     │
│  GET  /download-stream?id= → yt-dlp → MP3      │
└─────────────────────────────────────────────────┘
```

**Search flow:**
1. Searches your local queue first
2. If no local matches → calls `/search` on the local server
3. The server uses `youtubei.js` to hit YouTube's internal InnerTube API directly (no API key, no tracking cookies)
4. Results appear below the queue; **+ ADD** downloads to MP3 via yt-dlp

## Project structure

```
ytmp3-electron/
├── main.js          Electron main process
├── preload.js       Context bridge (IPC)
├── server.mjs       Local API server (youtubei.js + yt-dlp)
├── package.json
└── src/
    └── index.html   UI (Tailwind + vanilla JS)
```

## Build a distributable

```bash
npm run build
# Output in ./dist/
```
