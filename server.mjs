// server.mjs — ESM module (youtubei.js is ESM-only)
import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { Innertube, UniversalCache } from "youtubei.js";

import { app as electronApp } from "electron";

const PORT = 3847;
const isWin = process.platform === "win32";
let yt;

// Audio file extensions to scan for
const AUDIO_EXTS = new Set([
  ".mp3",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
  ".aiff",
]);

function getMusicDir() {
  try {
    return electronApp.getPath("music");
  } catch {
    return path.join(os.homedir(), "Music");
  }
}

let ytCreatedAt = 0;
const YT_SESSION_TTL = 6 * 60 * 60 * 1000; // refresh every 6 hours

async function getInnertube() {
  if (!yt || (Date.now() - ytCreatedAt > YT_SESSION_TTL)) {
    const cacheDir = path.join(electronApp.getPath("userData"), "yt-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    yt = await Innertube.create({
      cache: new UniversalCache(true, cacheDir),
      generate_session_locally: true,
    });
    ytCreatedAt = Date.now();
  }
  return yt;
}

// ── Shared getInfo with promise deduplication ─────────────────────────
const fullInfoCache = new Map();     // id → { info, ts }
const fullInfoInFlight = new Map();  // id → Promise<info>
const FULL_INFO_TTL = 30 * 60 * 1000;    // 30 minutes
const FULL_INFO_MAX = 200;

async function getFullInfo(id) {
  const cached = fullInfoCache.get(id);
  if (cached && Date.now() - cached.ts < FULL_INFO_TTL) return cached.info;

  if (fullInfoInFlight.has(id)) return fullInfoInFlight.get(id);

  const promise = (async () => {
    const tube = await getInnertube();
    const info = await tube.getInfo(id);
    fullInfoCache.set(id, { info, ts: Date.now() });
    if (fullInfoCache.size > FULL_INFO_MAX) {
      fullInfoCache.delete(fullInfoCache.keys().next().value);
    }
    return info;
  })();

  fullInfoInFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    fullInfoInFlight.delete(id);
  }
}

// Recursively walk a directory and collect audio files (async, parallel subdirs)
async function walkDir(dir, results = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  const subdirs = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(walkDir(full, results));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) {
        results.push(full);
      }
    }
  }
  if (subdirs.length) await Promise.all(subdirs);
  return results;
}

export async function createServer() {
  // Start Innertube session eagerly in background (don't block server start)
  const ytReady = getInnertube().catch((e) =>
    console.warn("[server] Innertube pre-init failed, will retry on demand:", e.message),
  );

  const app = express();
  const server = app.listen(PORT);
  // Save the original close method BEFORE we reassign it to avoid infinite recursion
  const _serverClose = server.close.bind(server);

  app.use(cors({ origin: "*" }));
  app.use(express.json());

  // Serve the app icon for MediaSession artwork
  app.get("/icon.png", (_req, res) => {
    const iconPath = path.join(electronApp.getAppPath(), "build", "icons", "256x256.png");
    if (fs.existsSync(iconPath)) return res.sendFile(iconPath);
    res.status(404).end();
  });

  // GET /hits — greatest hits / popular songs
  app.get("/hits", async (req, res) => {
    try {
      const tube = await getInnertube();
      const genres = [
        "top hits " + new Date().getFullYear(),
        "greatest hits all time",
        "trending songs " + new Date().getFullYear(),
        "best pop songs",
        "best rock songs",
        "best r&b songs",
      ];
      const genre = genres[Math.floor(Math.random() * genres.length)];
      const results = await tube.search(genre, { type: "video" });
      const videos = (results.videos ?? [])
        .filter((v) => {
          const dur = v.duration?.seconds ?? 0;
          const title = v.title?.text ?? "";
          const author = v.author?.name ?? "";
          return v.id && isMusicVideo({ title, author, duration: dur });
        })
        .slice(0, 15)
        .map((v) => ({
          id: v.id,
          title: v.title?.text ?? "(unknown)",
          author: v.author?.name ?? "",
          duration: v.duration?.seconds ?? 0,
          durStr: v.duration?.text ?? "?:??",
          thumb: v.thumbnails?.[0]?.url ?? "",
        }));
      res.json(videos);
    } catch (err) {
      console.error("[hits]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /search?q=
  app.get("/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query" });
    try {
      const tube = await getInnertube();
      const results = await tube.search(q, { type: "video" });
      const videos = (results.videos ?? [])
        .filter((v) => {
          const dur = v.duration?.seconds ?? 0;
          const title = v.title?.text ?? "";
          const author = v.author?.name ?? "";
          return v.id && isMusicVideo({ title, author, duration: dur });
        })
        .slice(0, 12)
        .map((v) => ({
          id: v.id,
          title: v.title?.text ?? "(unknown)",
          author: v.author?.name ?? "",
          duration: v.duration?.seconds ?? 0,
          durStr: v.duration?.text ?? "?:??",
          thumb: v.thumbnails?.[0]?.url ?? "",
        }));
      res.json(videos);
    } catch (err) {
      console.error("[search]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /scan?dir= — walk audio locations (custom dir overrides defaults)
  app.get("/scan", async (req, res) => {
    try {
      const customDir = (req.query.dir || "").trim();
      const scanDirs = new Set();
      if (customDir && fs.existsSync(customDir)) {
        scanDirs.add(customDir);
      } else {
        try {
          scanDirs.add(electronApp.getPath("music"));
        } catch {}
        try {
          scanDirs.add(electronApp.getPath("downloads"));
        } catch {}
        scanDirs.add(path.join(os.homedir(), "Music"));
        scanDirs.add(path.join(os.homedir(), "Downloads"));
      }
      // Walk all dirs in parallel
      const validDirs = [...scanDirs].filter((d) => fs.existsSync(d));
      const allResults = await Promise.all(validDirs.map((d) => walkDir(d)));
      const seen = new Set();
      const files = [];
      for (const batch of allResults) {
        for (const f of batch) {
          if (!seen.has(f)) {
            seen.add(f);
            files.push(f);
          }
        }
      }
      const tracks = files.map((filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        const basename = path.basename(filePath, ext);
        // Try to parse "Artist - Title" naming convention
        const dashIdx = basename.indexOf(" - ");
        let title, meta;
        if (dashIdx > 0) {
          meta = basename.slice(0, dashIdx).trim();
          title = basename.slice(dashIdx + 3).trim();
        } else {
          title = basename;
          meta = path.basename(path.dirname(filePath));
        }
        return {
          title,
          meta,
          ext: ext.replace(".", "").toUpperCase(),
          localPath: filePath,
          dur: "?:??",
          durSec: 0,
        };
      });
      res.json({ tracks });
    } catch (err) {
      console.error("[scan]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Music video filtering ──────────────────────────────────────────
  const MAX_DUR = 12 * 60; // 12 minutes
  const MIN_DUR = 30;      // 30 seconds — skip sound effects / intros
  const SKIP_TYPES = new Set(["PLAYLIST", "ALBUM", "PODCAST", "SHOPPING_COLLECTION"]);
  const SKIP_LEGACY_TYPES = new Set(["CompactPlaylist", "CompactMix", "PlaylistVideo", "Playlist", "Mix", "CompactStation"]);

  // Non-music title keywords (case-insensitive, word-boundary)
  const SKIP_TITLE_RE = new RegExp([
    // Aggregations
    "\\bmix\\b", "\\bplaylist\\b", "\\bcollection\\b", "\\bcompilation\\b", "\\bfull\\s+album\\b",
    // Podcasts / talk
    "\\bpodcast\\b", "\\binterview\\b", "\\btalk\\s+show\\b", "\\bq\\s*&\\s*a\\b",
    // Educational / informational
    "\\btutorial\\b", "\\bhow\\s+to\\b", "\\bexplained\\b", "\\blecture\\b", "\\bwebinar\\b",
    "\\bcourse\\b", "\\blesson\\b", "\\btraining\\b",
    // Reactions / commentary
    "\\breaction\\b", "\\breview\\b", "\\bcommentary\\b", "\\banalysis\\b", "\\bbreakdown\\b",
    // Gaming
    "\\bgameplay\\b", "\\bwalkthrough\\b", "\\bplaythrough\\b", "\\blets?\\s+play\\b",
    "\\bgaming\\b", "\\bspeedrun\\b", "\\bfortnite\\b", "\\bminecraft\\b", "\\broblox\\b",
    // Streaming / live
    "\\bstream\\b", "\\blive\\s+stream\\b", "\\blivestream\\b", "\\bfull\\s+stream\\b",
    // Vlogs / lifestyle
    "\\bvlog\\b", "\\bchallenge\\b", "\\bprank\\b", "\\bunboxing\\b", "\\bhaul\\b",
    "\\bday\\s+in\\s+(my|the)\\s+life\\b", "\\bmorning\\s+routine\\b", "\\bget\\s+ready\\b",
    // News / documentary
    "\\bbreaking\\b", "\\bnews\\b", "\\bdocumentary\\b", "\\binvestigation\\b",
    // Movies / shows
    "\\bfull\\s+movie\\b", "\\bfull\\s+episode\\b", "\\btrailer\\b", "\\bteaser\\b",
    "\\bscene\\b", "\\bclip\\b",
    // Misc non-music
    "\\btimelapse\\b", "\\basmr\\b", "\\bsatisfying\\b", "\\bcompilation\\b",
    "\\bfails?\\b", "\\bfunny\\b", "\\btop\\s+\\d+\\b", "\\bbest\\s+of\\b",
    "\\bcooking\\b", "\\brecipe\\b", "\\bworkout\\b", "\\bexercise\\b", "\\byoga\\b",
    "\\bmeditation\\b", "\\bwhite\\s+noise\\b", "\\brain\\s+sounds\\b",
  ].join("|"), "i");

  // Known non-music channel name patterns
  const SKIP_AUTHOR_RE = /\bnews\b|\bgaming\b|\bgames?\b|\bcooking\b|\bfitness\b|\btech\b|\bpolitics\b|\bsports?\b|\bespn\b|\bcnn\b|\bfox\b|\bbbc\b|\bvox\b|\bvice\b|\bted\b|\bnational\s+geographic\b|\bdiscovery\b/i;

  // Positive music signals in title — if present, more likely to be music
  const MUSIC_TITLE_RE = /official\s*(music\s*)?video|official\s*audio|official\s*lyric|lyric\s*video|\blyrics?\b|\bft\.?\s|\bfeat\.?\s|\bremix\b|\bacoustic\b|\bunplugged\b|\bcover\b|\bperformance\b|\bmusic\s*video\b|\baudio\b|\b(?:mv)\b|\bvisualizer\b/i;

  /**
   * Returns true if the video looks like a song/music content.
   * @param {object} v - { title, author, duration }
   * @param {object} [opts] - { lenient: true } to allow borderline cases (e.g. for /next)
   */
  function isMusicVideo(v, opts = {}) {
    const title = (v.title || "").trim();
    const author = (v.author || "").trim();
    const dur = v.duration || 0;

    // Duration gate (skip if duration is known and out of range)
    if (dur > 0) {
      if (dur > MAX_DUR) return false;
      if (dur < MIN_DUR) return false;
    }

    // Hard reject on non-music title keywords
    if (SKIP_TITLE_RE.test(title)) return false;

    // Reject known non-music channels
    if (SKIP_AUTHOR_RE.test(author)) return false;

    // In strict mode (search/hits/trending), require either:
    //   - a positive music signal in the title, OR
    //   - a reasonable duration for a song (1:00 – 8:00), OR
    //   - the author contains "music", "records", "VEVO", etc.
    if (!opts.lenient) {
      const hasMusicSignal = MUSIC_TITLE_RE.test(title);
      const isSongLength = dur >= 60 && dur <= 480;
      const isMusicChannel = /music|records|recording|entertainment|vevo|warner|sony|universal|capitol|atlantic|republic|interscope|def\s*jam/i.test(author);
      // If none of these signals, it's likely not a song
      if (!hasMusicSignal && !isSongLength && !isMusicChannel && dur > 0) {
        return false;
      }
    }

    return true;
  }

  function extractFeedItem(v) {
    // Skip legacy playlist/mix types
    if (SKIP_LEGACY_TYPES.has(v.type)) return null;

    // LockupView (new YouTube format)
    if (v.type === "LockupView") {
      // Skip playlists, albums, etc.
      if (v.content_type && SKIP_TYPES.has(v.content_type)) return null;

      const vid = v.content_id;
      if (!vid) return null;
      const title = v.metadata?.title?.text ?? v.metadata?.title?.toString?.() ?? "";

      // Skip mixes/playlists by title
      if (SKIP_TITLE_RE.test(title)) return null;

      const rows = v.metadata?.metadata?.metadata_rows ?? [];
      let author = "";
      let durStr = "";
      for (const row of rows) {
        const parts = (row.metadata_parts ?? []).map((p) => p.text?.text ?? p.text?.toString?.() ?? "").filter(Boolean);
        for (const part of parts) {
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(part)) {
            durStr = part;
          } else if (!author && part !== "New" && part.length > 1) {
            author = part;
          }
        }
      }
      let duration = 0;
      if (durStr) {
        const segs = durStr.split(":").map(Number);
        if (segs.length === 3) duration = segs[0] * 3600 + segs[1] * 60 + segs[2];
        else if (segs.length === 2) duration = segs[0] * 60 + segs[1];
      }
      if (!isMusicVideo({ title, author, duration }, { lenient: true })) return null;

      const thumb = v.content_image?.image?.[0]?.url ?? v.thumbnails?.[0]?.url ?? "";
      return { id: vid, title, author, duration, durStr: durStr || "?:??", thumb };
    }

    // Legacy format (CompactVideo, etc.)
    const vid = v.id || v.video_id;
    if (!vid) return null;
    const title = v.title?.text ?? v.title?.toString?.() ?? v.title ?? "";
    const author = v.author?.name ?? v.short_byline_text?.text ?? v.author ?? "";
    const duration = v.duration?.seconds ?? v.length_seconds ?? 0;
    if (!isMusicVideo({ title, author, duration }, { lenient: true })) return null;

    return {
      id: vid,
      title,
      author,
      duration,
      durStr: v.duration?.text ?? "?:??",
      thumb: v.thumbnails?.[0]?.url ?? "",
    };
  }

  // GET /next?id= — returns "up next" related videos for autoplay
  const nextCache = new Map();  // id → { related, ts }
  const NEXT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

  app.get("/next", async (req, res) => {
    const id = (req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const cachedNext = nextCache.get(id);
    if (cachedNext && Date.now() - cachedNext.ts < NEXT_CACHE_TTL) {
      console.log("[next] cache hit for", id);
      return res.json(cachedNext.related);
    }

    try {
      const info = await getFullInfo(id);
      const feed = info.watch_next_feed ?? [];

      const related = feed
        .map(extractFeedItem)
        .filter(Boolean)
        .slice(0, 15);

      // If watch_next_feed was empty or all items unparseable, try autoplay sets
      if (related.length === 0 && info.autoplay?.sets?.length > 0) {
        const autoVid = info.autoplay.sets[0].autoplay_video;
        const nextId = autoVid?.payload?.videoId;
        if (nextId) {
          try {
            const nextInfo = await getFullInfo(nextId);
            const b = nextInfo.basic_info;
            if (b.id && (!b.duration || b.duration <= MAX_DUR) && !SKIP_TITLE_RE.test(b.title ?? "")) {
              related.push({
                id: b.id,
                title: b.title ?? "Unknown",
                author: b.author ?? "",
                duration: b.duration ?? 0,
                durStr: b.duration ? `${Math.floor(b.duration/60)}:${String(b.duration%60).padStart(2,'0')}` : "?:??",
              });
            }
          } catch (e) {
            console.warn("[next] failed to fetch autoplay video info:", e.message);
          }
        }
      }

      nextCache.set(id, { related, ts: Date.now() });
      console.log("[next] returning", related.length, "related for", id);
      res.json(related);
    } catch (err) {
      console.error("[next]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Shared video info cache — avoids duplicate tube.getInfo() calls
  // ensureDownload already calls getInfo to resolve CDN URLs; cache the metadata too
  const infoCache = new Map(); // id → { title, author, duration, thumb, ts }
  const INFO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // GET /info?id=
  app.get("/info", async (req, res) => {
    const id = (req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    // Serve from cache if available
    const cached = infoCache.get(id);
    if (cached && Date.now() - cached.ts < INFO_CACHE_TTL) {
      return res.json({ id, title: cached.title, author: cached.author, duration: cached.duration, thumb: cached.thumb });
    }

    try {
      const info = await getFullInfo(id);
      const basic = info.basic_info;
      const data = {
        title: basic.title,
        author: basic.author,
        duration: basic.duration,
        thumb: basic.thumbnail?.[0]?.url ?? "",
        ts: Date.now(),
      };
      infoCache.set(id, data);

      // Also cache the CDN URL while we have the info object
      try {
        const tube = await getInnertube();
        const format = info.chooseFormat({ type: "audio", quality: "best" });
        const url = format?.decipher(tube.session.player);
        if (url && !url.includes(".m3u8") && !url.includes("/manifest/")) {
          if (!app._urlCache) app._urlCache = new Map();
          app._urlCache.set(id, { url, ts: Date.now() });
        }
      } catch {}

      res.json({ id: basic.id, title: data.title, author: data.author, duration: data.duration, thumb: data.thumb });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /info-batch?ids=X,Y,Z — resolve multiple track durations in one call
  app.get("/info-batch", async (req, res) => {
    const ids = (req.query.ids || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
    if (!ids.length) return res.status(400).json({ error: "Missing ids" });
    const results = await Promise.allSettled(ids.map(async (id) => {
      const cached = infoCache.get(id);
      if (cached && Date.now() - cached.ts < INFO_CACHE_TTL) {
        return { id, title: cached.title, author: cached.author, duration: cached.duration, thumb: cached.thumb };
      }
      const info = await getFullInfo(id);
      const basic = info.basic_info;
      const data = { title: basic.title, author: basic.author, duration: basic.duration, thumb: basic.thumbnail?.[0]?.url ?? "" };
      infoCache.set(id, { ...data, ts: Date.now() });
      return { id, ...data };
    }));
    res.json(results.filter(r => r.status === "fulfilled").map(r => r.value));
  });

  const STREAM_CACHE_MAX = 50;
  const streamCache = new Map();   // id → filePath (fully downloaded)
  const activeDownloads = new Map(); // id → { emitter, contentType, contentLength }

  // Shared download that emits chunks in real-time.
  // Both /preload and /stream use this — only one download per id at a time.
  function ensureDownload(id) {
    if (activeDownloads.has(id)) return activeDownloads.get(id);

    const tmpDir = path.join(os.tmpdir(), "vinyl-stream");
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `${id}.m4a`);

    const dl = { emitter: new EventEmitter(), contentType: "audio/mp4", contentLength: null, chunks: [] };
    dl.emitter.setMaxListeners(20);
    activeDownloads.set(id, dl);

    // Evict oldest if full
    if (streamCache.size >= STREAM_CACHE_MAX && !streamCache.has(id)) {
      const oldest = streamCache.keys().next().value;
      try { fs.unlinkSync(streamCache.get(oldest)); } catch {}
      streamCache.delete(oldest);
    }

    const run = async () => {
      // Resolve CDN URL
      let cdnUrl = null;
      if (!app._urlCache) app._urlCache = new Map();
      const cached = app._urlCache.get(id);
      if (cached && Date.now() - cached.ts < 5 * 60 * 60 * 1000) {
        cdnUrl = cached.url;
      } else {
        try {
          const info = await getFullInfo(id);

          // Cache video metadata so /info doesn't need a separate call
          const basic = info.basic_info;
          if (basic) {
            infoCache.set(id, {
              title: basic.title, author: basic.author,
              duration: basic.duration, thumb: basic.thumbnail?.[0]?.url ?? "",
              ts: Date.now(),
            });
          }

          const tube = await getInnertube();
          const format = info.chooseFormat({ type: "audio", quality: "best" });
          const url = format?.decipher(tube.session.player);
          if (url && !url.includes(".m3u8") && !url.includes("/manifest/")) {
            cdnUrl = url;
            app._urlCache.set(id, { url, ts: Date.now() });
          }
        } catch (e) {
          console.warn("[download] youtubei.js failed:", e.message);
        }
      }

      if (cdnUrl) {
        try {
          const upstream = await fetch(cdnUrl);
          if (!upstream.ok) throw new Error(`CDN ${upstream.status}`);
          dl.contentType = upstream.headers.get("content-type") || "audio/mp4";
          dl.contentLength = upstream.headers.get("content-length") || null;
          dl.emitter.emit("headers");

          const fileWrite = fs.createWriteStream(filePath);
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fileWrite.write(value);
            dl.chunks.push(value);
            dl.emitter.emit("chunk", value);
          }
          await new Promise((resolve) => fileWrite.end(resolve));
          if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
            streamCache.set(id, filePath);
            console.log("[download] cached", id);
          }
          dl.chunks.length = 0;
          dl.emitter.emit("end");
          return;
        } catch (e) {
          console.warn("[download] CDN failed, falling back to yt-dlp:", e.message);
        }
      }

      // Fallback: yt-dlp piped to stdout
      dl.emitter.emit("headers");
      await new Promise((resolve) => {
        const proc = spawn("yt-dlp", [
          `https://www.youtube.com/watch?v=${id}`,
          "-f", "ba[ext=m4a]/ba[ext=webm]/ba",
          "-o", "-",
          "--no-playlist", "-q", "--no-warnings",
        ], { shell: isWin });
        const fileWrite = fs.createWriteStream(filePath);
        let ok = true;

        proc.stdout.on("data", (chunk) => {
          if (ok) fileWrite.write(chunk);
          dl.chunks.push(chunk);
          dl.emitter.emit("chunk", chunk);
        });
        proc.stderr.on("data", (d) => console.error("[stream]", d.toString().trim()));
        proc.on("error", (err) => {
          ok = false;
          console.error("[stream spawn]", err.message);
          dl.emitter.emit("error", err);
          fileWrite.end();
          resolve();
        });
        proc.on("close", (code) => {
          fileWrite.end(() => {
            if (code === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
              streamCache.set(id, filePath);
            } else {
              try { fs.unlinkSync(filePath); } catch {}
            }
          });
          dl.chunks.length = 0;
          dl.emitter.emit("end");
          resolve();
        });
      });
    };

    run()
      .catch((e) => {
        console.error("[download] fatal:", e.message);
        dl.emitter.emit("error", e);
      })
      .finally(() => activeDownloads.delete(id));

    return dl;
  }

  // GET /preload?id= — trigger background download, respond immediately
  app.get("/preload", (req, res) => {
    const id = (req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (streamCache.has(id)) return res.json({ status: "cached" });
    ensureDownload(id);
    res.json({ status: "started" });
  });

  // GET /stream?id=
  // Serves cached file instantly, or streams chunks in real-time from an active download.
  app.get("/stream", async (req, res) => {
    const id = (req.query.id || "").trim();
    if (!id) return res.status(400).end("Missing id");

    const tmpDir = path.join(os.tmpdir(), "vinyl-stream");
    const filePath = path.join(tmpDir, `${id}.m4a`);

    // Already fully cached → serve with range support
    if (streamCache.has(id) && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return res.sendFile(filePath);
    }

    // Start or join an active download and stream chunks as they arrive
    const dl = ensureDownload(id);

    // Wait for headers to be ready
    await new Promise((resolve) => {
      if (dl.contentLength !== null || dl.contentType !== "audio/mp4") return resolve();
      const onHeaders = () => resolve();
      const onChunk = () => { dl.emitter.removeListener("headers", onHeaders); resolve(); };
      const onEnd = () => { dl.emitter.removeListener("headers", onHeaders); resolve(); };
      dl.emitter.once("headers", onHeaders);
      dl.emitter.once("chunk", onChunk);
      dl.emitter.once("end", onEnd);
      dl.emitter.once("error", onEnd);
    });

    // If download finished while we waited, serve the file
    if (streamCache.has(id) && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return res.sendFile(filePath);
    }

    res.setHeader("Content-Type", dl.contentType);
    if (dl.contentLength) res.setHeader("Content-Length", dl.contentLength);
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "no-cache");

    // Send any chunks that were already downloaded before we subscribed
    for (const chunk of dl.chunks) {
      if (res.writableEnded) break;
      res.write(chunk);
    }

    const onChunk = (chunk) => { if (!res.writableEnded) res.write(chunk); };
    const onEnd = () => { try { res.end(); } catch {} cleanup(); };
    const onError = () => { try { res.end(); } catch {} cleanup(); };

    function cleanup() {
      dl.emitter.removeListener("chunk", onChunk);
      dl.emitter.removeListener("end", onEnd);
      dl.emitter.removeListener("error", onError);
    }

    dl.emitter.on("chunk", onChunk);
    dl.emitter.once("end", onEnd);
    dl.emitter.once("error", onError);

    req.on("close", cleanup);
  });

  // GET /local?path=
  app.get("/local", (req, res) => {
    const filePath = decodeURIComponent(req.query.path || "");
    const resolved = path.resolve(filePath);
    // Allow any file under home directory
    if (!resolved.startsWith(os.homedir()) || !fs.existsSync(resolved)) {
      return res.status(403).end("Forbidden");
    }
    res.sendFile(resolved);
  });

  // GET /download-stream?id=&title=&outDir=
  app.get("/download-stream", (req, res) => {
    const { id, title, outDir } = req.query;
    if (!id) return res.status(400).end("Missing id");

    const safeTitle = (title || id)
      .replace(/[/\\?%*:|"<>]/g, "_")
      .slice(0, 120);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    // Find first writable directory
    const dirCandidates = [
      outDir && outDir.trim() ? outDir.trim() : null,
      (() => {
        try {
          return electronApp.getPath("downloads");
        } catch {
          return null;
        }
      })(),
      path.join(os.homedir(), "Downloads"),
      os.tmpdir(),
    ].filter(Boolean);

    let dir = null;
    for (const c of dirCandidates) {
      try {
        fs.mkdirSync(c, { recursive: true });
        fs.accessSync(c, fs.constants.W_OK);
        dir = c;
        break;
      } catch {}
    }
    if (!dir) {
      send({ type: "error", message: "No writable directory found." });
      return res.end();
    }

    const outPath = path.join(dir, `${safeTitle}.mp3`);
    send({ type: "start", outPath });

    const proc = spawn("yt-dlp", [
      `https://www.youtube.com/watch?v=${id}`,
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      outPath,
      "--no-playlist",
      "--newline",
    ], { shell: isWin });

    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString();
      console.error("[download]", d.toString().trim());
    });

    proc.stdout.on("data", (d) => {
      // Forward yt-dlp progress lines to the client
      const line = d.toString().trim();
      if (line) send({ type: "progress", line });
    });

    proc.on("close", (code) => {
      if (fs.existsSync(outPath)) {
        send({ type: "done", outPath });
      } else {
        send({
          type: "error",
          message: stderrBuf.trim() || `yt-dlp exited with code ${code}`,
        });
      }
      res.end();
    });

    proc.on("error", (err) => {
      console.error("[download spawn]", err.message);
      send({
        type: "error",
        message: `Failed to start yt-dlp: ${err.message}`,
      });
      res.end();
    });

    req.on("close", () => {
      try {
        if (isWin) {
          spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { shell: true });
        } else {
          proc.kill("SIGTERM");
        }
      } catch {}
    });
  });

  // GET /trending
  app.get("/trending", async (_req, res) => {
    try {
      const tube = await getInnertube();
      const trend = await tube.getTrending();
      const videos = (trend.videos ?? [])
        .filter((v) => {
          const dur = v.duration?.seconds ?? 0;
          const title = v.title?.text ?? "";
          const author = v.author?.name ?? "";
          return v.id && isMusicVideo({ title, author, duration: dur });
        })
        .slice(0, 16)
        .map((v) => ({
          id: v.id,
          title: v.title?.text ?? "",
          author: v.author?.name ?? "",
          duration: v.duration?.seconds ?? 0,
          durStr: v.duration?.text ?? "?:??",
          thumb: v.thumbnails?.[0]?.url ?? "",
        }));
      res.json(videos);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  server.port = PORT;
  // Use the saved original — avoids the infinite recursion bug
  server.close = () => new Promise((resolve) => _serverClose(resolve));
  console.log(`[server] Listening on http://localhost:${PORT}`);
  return server;
}
