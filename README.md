# Vinyl

A private YouTube audio player built with Electron. Streams audio directly from YouTube via **youtubei.js** (the same InnerTube approach as [FreeTube](https://github.com/FreeTubeApp/FreeTube)) — no API key, no tracking cookies. Falls back to **yt-dlp** when needed.

## Features

- **Search** YouTube and stream audio instantly
- **Download** tracks as MP3 via yt-dlp
- **Local library** — scan and play local audio files (MP3, FLAC, M4A, OGG, WAV, etc.)
- **Autoplay** — "Up Next" queue powered by YouTube's related videos
- **Trending & Hits** — discover popular music without leaving the app
- Smart music filtering — skips podcasts, gaming videos, vlogs, and other non-music content

## Prerequisites

- **Node.js** 18+
- **yt-dlp** installed and on your PATH
  - macOS: `brew install yt-dlp`
  - Linux: `sudo pip install yt-dlp` or grab the binary from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)
  - Windows: `winget install yt-dlp` or grab the `.exe` from releases
- **ffmpeg** installed and on your PATH (used by yt-dlp for audio conversion)
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
  - Windows: [ffmpeg.org/download](https://ffmpeg.org/download.html)

## Install & Run

```bash
npm install
npm start
```

For dev mode (with DevTools):

```bash
npm run dev
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Electron Renderer (src/index.html)                 │
│  · Tailwind CSS + vanilla JS                        │
│  · Calls http://localhost:3847 for all API requests  │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP (loopback only)
┌───────────────────▼─────────────────────────────────┐
│  Express API Server (server.mjs)                    │
│                                                     │
│  GET /search?q=         Search via InnerTube        │
│  GET /info?id=          Video metadata              │
│  GET /info-batch?ids=   Batch metadata              │
│  GET /stream?id=        Stream audio (CDN / yt-dlp) │
│  GET /preload?id=       Background download         │
│  GET /next?id=          Related / autoplay tracks    │
│  GET /trending          Trending music videos        │
│  GET /hits              Popular songs (random genre) │
│  GET /scan?dir=         Scan local audio files       │
│  GET /local?path=       Serve local audio file       │
│  GET /download-stream?id=  Download MP3 via yt-dlp  │
└─────────────────────────────────────────────────────┘
```

## Project Structure

```
vinyl-electron/
├── main.js          Electron main process
├── preload.js       Context bridge (IPC)
├── server.mjs       Local API server (youtubei.js + yt-dlp)
├── package.json
├── build/           Build resources & icons
├── .github/         CI workflows (Build & Release)
└── src/
    ├── index.html   UI (Tailwind + vanilla JS)
    ├── input.css    Tailwind source styles
    ├── output.css   Compiled CSS
    └── fonts/       Bundled fonts (DM Sans, Space Mono)
```

## Build

```bash
# Linux (AppImage + RPM)
npm run build:linux

# Windows (NSIS + MSI)
npm run build:win

# All platforms
npm run build:all
```

Output goes to `./dist/`.

## License

MIT
