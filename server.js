/*
 * Mova server — zero dependencies, pure Node.js (v18+).
 * Run with:  node server.js
 * Then open  http://localhost:3000  in Chrome (and share your address with friends).
 *
 * What it does:
 *  - Serves the app (public/index.html)
 *  - Stores uploaded movies in ./movies and streams them with seek support
 *  - WebSocket rooms: synced play/pause/seek, movie selection, chat, trivia scores
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MOVIE_DIR = path.join(__dirname, "movies");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const ALLOWED_EXT = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v", ".ogg"]);

fs.mkdirSync(MOVIE_DIR, { recursive: true });

/* Clean up half-finished uploads (.part files) left by failed attempts.
 * They eat storage silently; after a restart they can't be resumed reliably
 * anyway, so we clear them on boot. */
for (const f of fs.readdirSync(MOVIE_DIR)) {
  if (f.endsWith(".part")) {
    try { fs.rmSync(path.join(MOVIE_DIR, f)); console.log("cleaned stale upload:", f); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogg": "video/ogg",
  ".json": "application/json",
};

function safeName(name) {
  // keep letters, numbers, spaces, dash, underscore, dot; strip path tricks
  return path
    .basename(String(name || ""))
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 120);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  /* ---- movie library ---- */
  if (req.method === "GET" && p === "/api/movies") {
    const files = fs
      .readdirSync(MOVIE_DIR)
      .filter((f) => ALLOWED_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const st = fs.statSync(path.join(MOVIE_DIR, f));
        return { file: f, size: st.size };
      })
      .sort((a, b) => a.file.localeCompare(b.file));
    return json(res, 200, { movies: files });
  }

  /* ---- chunked upload: big files sent piece by piece ----
   *  POST /api/upload-chunk?name=movie.mp4&offset=0&last=0
   *  Client sends chunks in order. `offset` must equal current .part size.
   *  If it doesn't match (e.g. after a retry), we reply with the size we
   *  have so the client can resume from there. `last=1` finalizes the file.
   */
  if (req.method === "POST" && p === "/api/upload-chunk") {
    const name = safeName(url.searchParams.get("name"));
    const ext = path.extname(name).toLowerCase();
    if (!name || !ALLOWED_EXT.has(ext)) {
      return json(res, 400, { error: "Give the file a video name like movie.mp4 (mp4, webm, mkv, mov, m4v, ogg)." });
    }
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const isLast = url.searchParams.get("last") === "1";
    const dest = path.join(MOVIE_DIR, name);
    const tmp = dest + ".part";

    const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (offset !== have) {
      // client is out of sync (retry/resume) — tell it where we are
      req.resume();
      return json(res, 409, { resumeAt: have });
    }
    if (have > MAX_UPLOAD_BYTES) {
      req.resume();
      fs.rm(tmp, { force: true }, () => {});
      return json(res, 413, { error: "File too large." });
    }

    const out = fs.createWriteStream(tmp, { flags: "a" });
    req.pipe(out);
    out.on("finish", () => {
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (isLast) {
        fs.rename(tmp, dest, (err) => {
          if (err) return json(res, 500, { error: "Could not save the file." });
          json(res, 200, { ok: true, done: true, file: name, size });
          broadcastAll({ type: "library" });
        });
      } else {
        json(res, 200, { ok: true, size });
      }
    });
    out.on("error", () => {
      json(res, 500, { error: "Write failed." });
    });
    return;
  }

  /* ---- upload: raw body PUT/POST with filename in query ---- */
  if ((req.method === "POST" || req.method === "PUT") && p === "/api/upload") {
    const name = safeName(url.searchParams.get("name"));
    const ext = path.extname(name).toLowerCase();
    if (!name || !ALLOWED_EXT.has(ext)) {
      return json(res, 400, { error: "Give the file a video name like movie.mp4 (mp4, webm, mkv, mov, m4v, ogg)." });
    }
    const dest = path.join(MOVIE_DIR, name);
    const tmp = dest + ".part";
    let received = 0;
    const out = fs.createWriteStream(tmp);

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy();
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
      }
    });
    req.pipe(out);
    out.on("finish", () => {
      fs.rename(tmp, dest, (err) => {
        if (err) return json(res, 500, { error: "Could not save the file." });
        json(res, 200, { ok: true, file: name, size: received });
        broadcastAll({ type: "library" }); // tell every room the library changed
      });
    });
    out.on("error", () => {
      fs.rm(tmp, { force: true }, () => {});
      json(res, 500, { error: "Upload failed while writing to disk." });
    });
    return;
  }

  /* ---- delete a movie ---- */
  if (req.method === "DELETE" && p === "/api/delete") {
    const name = safeName(url.searchParams.get("name"));
    if (!name) return json(res, 400, { error: "No filename given" });
    const file = path.join(MOVIE_DIR, name);
    try { fs.rmSync(file + ".part", { force: true }); } catch {} // clear any half-upload too
    if (!fs.existsSync(file)) return json(res, 404, { error: "File not found" });
    fs.rm(file, (err) => {
      if (err) return json(res, 500, { error: "Could not delete the file." });
      json(res, 200, { ok: true, deleted: name });
      broadcastAll({ type: "library" }); // tell every room the library changed
    });
    return;
  }

  /* ---- storage meter: how full is the drive? ---- */
  if (req.method === "GET" && p === "/api/storage") {
    let used = 0;
    for (const f of fs.readdirSync(MOVIE_DIR)) {
      try { used += fs.statSync(path.join(MOVIE_DIR, f)).size; } catch {}
    }
    fs.statfs(MOVIE_DIR, (err, s) => {
      if (err || !s) return json(res, 200, { used, free: null, total: null });
      json(res, 200, {
        used,
        free: s.bavail * s.bsize,
        total: s.blocks * s.bsize
      });
    });
    return;
  }

  /* ---- movie streaming with Range support (lets the player seek) ---- */
  if (req.method === "GET" && p.startsWith("/movies/")) {
    const name = safeName(p.slice("/movies/".length));
    const file = path.join(MOVIE_DIR, name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const st = fs.statSync(file);
    const type = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }

  /* ---- static app files ---- */
  if (req.method === "GET") {
    let rel = p === "/" ? "/index.html" : p;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      return fs.createReadStream(file).pipe(res);
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

/* ------------------------------------------------------------------ */
/*  WebSocket (from scratch — no libraries)                            */
/* ------------------------------------------------------------------ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** room code -> room */
const rooms = new Map();
/** every connected socket */
const allClients = new Set();

function makeRoom(code) {
  return {
    code,
    clients: new Set(),
    state: {
      movie: null,      // filename in ./movies
      stream: null,     // external video / live stream URL
      playing: false,
      time: 0,          // seconds at the moment of updatedAt
      updatedAt: Date.now(),
    },
    scores: {},         // name -> points
    round: 0,
  };
}

function roomCurrentTime(room) {
  const s = room.state;
  if (!s.playing) return s.time;
  return s.time + (Date.now() - s.updatedAt) / 1000;
}

function send(sock, obj) {
  if (sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}

function broadcast(room, obj, except) {
  for (const c of room.clients) if (c !== except) send(c, obj);
}
function broadcastAll(obj) {
  for (const c of allClients) send(c, obj);
}

function presence(room) {
  return {
    type: "presence",
    users: [...room.clients].map((c) => c.userName),
    scores: room.scores,
  };
}

function fullSync(room) {
  return {
    type: "sync",
    movie: room.state.movie,
    stream: room.state.stream,
    playing: room.state.playing,
    time: roomCurrentTime(room),
    round: room.round,
  };
}

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  // Be tolerant of how proxies (Railway, nginx, etc.) forward the URL:
  // strip query strings and accept both "/ws" and absolute-form URLs.
  let upath = String(req.url || "").split("?")[0];
  try { upath = new URL(upath, "http://x").pathname; } catch {}
  console.log("WS upgrade request:", req.url, "->", upath);
  if (!key || !upath.endsWith("/ws")) {
    sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    sock.destroy();
    return;
  }
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 30000);
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  sock.userName = "Guest";
  sock.room = null;
  sock.peerId = crypto.randomBytes(6).toString("hex");
  allClients.add(sock);

  let buffer = Buffer.alloc(0);

  sock.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // parse as many complete frames as we have
    while (true) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return; // wait for more data

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) { // close
        cleanup(sock);
        sock.end();
        return;
      }
      if (opcode === 0x9) { // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        sock.write(pong);
        continue;
      }
      if (opcode === 0x1 && fin) {
        let msg;
        try { msg = JSON.parse(payload.toString("utf8")); } catch { continue; }
        handleMessage(sock, msg);
      }
    }
  });

  sock.on("close", () => cleanup(sock));
  sock.on("error", () => cleanup(sock));
});

function cleanup(sock) {
  allClients.delete(sock);
  const room = sock.room;
  if (room) {
    room.clients.delete(sock);
    broadcast(room, { type: "chat", system: true, text: `${sock.userName} left the room` });
    broadcast(room, presence(room));
    broadcast(room, { type: "rtc-peer-left", peerId: sock.peerId });
    if (room.clients.size === 0) rooms.delete(room.code);
  }
  sock.room = null;
}

/** Find a socket in a room by its peerId (used to route WebRTC signaling). */
function findPeer(room, peerId) {
  for (const c of room.clients) if (c.peerId === peerId) return c;
  return null;
}

function handleMessage(sock, msg) {
  const room = sock.room;

  switch (msg.type) {
    case "join": {
      const code = String(msg.room || "LOBBY").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20) || "LOBBY";
      const name = String(msg.name || "Guest").slice(0, 24) || "Guest";
      sock.userName = name;
      let r = rooms.get(code);
      if (!r) {
        r = makeRoom(code);
        rooms.set(code, r);
      }
      r.clients.add(sock);
      sock.room = r;
      if (!(name in r.scores)) r.scores[name] = 0;
      send(sock, { type: "joined", room: code, you: name });
      send(sock, fullSync(r));
      broadcast(r, { type: "chat", system: true, text: `${name} joined the room` });
      broadcast(r, presence(r));
      // Video chat: tell the newcomer who's already here (they'll call each one),
      // and tell everyone already here that a new peer exists (they just wait for a call).
      send(sock, {
        type: "rtc-peers",
        peers: [...r.clients].filter((c) => c !== sock).map((c) => ({ peerId: c.peerId, name: c.userName })),
      });
      broadcast(r, { type: "rtc-peer-joined", peerId: sock.peerId, name: sock.userName }, sock);
      break;
    }

    case "chat": {
      if (!room) return;
      const text = String(msg.text || "").slice(0, 400);
      if (!text.trim()) return;
      broadcast(room, { type: "chat", name: sock.userName, text });
      break;
    }

    case "control": {
      if (!room) return;
      const s = room.state;
      const t = Math.max(0, Number(msg.time) || 0);
      if (msg.action === "play") {
        s.time = t; s.playing = true; s.updatedAt = Date.now();
        broadcast(room, { type: "control", action: "play", time: t, by: sock.userName });
      } else if (msg.action === "pause") {
        s.time = t; s.playing = false; s.updatedAt = Date.now();
        broadcast(room, { type: "control", action: "pause", time: t, by: sock.userName });
      } else if (msg.action === "seek") {
        s.time = t; s.updatedAt = Date.now();
        broadcast(room, { type: "control", action: "seek", time: t, playing: s.playing, by: sock.userName });
      }
      break;
    }

    case "selectMovie": {
      if (!room) return;
      const file = safeName(msg.file);
      if (!fs.existsSync(path.join(MOVIE_DIR, file))) return;
      room.state = { movie: file, stream: null, playing: false, time: 0, updatedAt: Date.now() };
      broadcast(room, { type: "movie", file, by: sock.userName });
      break;
    }

    case "selectStream": {
      if (!room) return;
      const url = String(msg.url || "").slice(0, 2000);
      if (!/^https?:\/\//i.test(url)) return;
      room.state = { movie: null, stream: url, playing: false, time: 0, updatedAt: Date.now() };
      broadcast(room, { type: "stream", url, by: sock.userName });
      break;
    }

    case "answer": {
      if (!room) return;
      if (msg.correct) room.scores[sock.userName] = (room.scores[sock.userName] || 0) + 1;
      broadcast(room, presence(room));
      broadcast(room, {
        type: "chat", system: true,
        text: `${sock.userName} answered round ${Number(msg.round) || "?"} ${msg.correct ? "correctly 🎉" : "wrong 😅"}`,
      });
      break;
    }

    case "nextRound": {
      if (!room) return;
      room.round = (Number(msg.round) || room.round + 1);
      broadcast(room, { type: "round", round: room.round });
      break;
    }

    case "syncRequest": {
      if (!room) return;
      send(sock, fullSync(room));
      break;
    }

    /* ---- WebRTC video chat signaling: just relay between two peers ---- */
    case "rtc-offer":
    case "rtc-answer":
    case "rtc-ice": {
      if (!room) return;
      const target = findPeer(room, msg.to);
      if (!target) return;
      send(target, { ...msg, from: sock.peerId, name: sock.userName });
      break;
    }
  }
}

/* Heartbeat: ping every client every 25s so hosting proxies
   don't close the connection for being idle. */
setInterval(() => {
  for (const c of allClients) {
    if (!c.destroyed) c.write(Buffer.from([0x89, 0x00])); // WS ping frame
  }
}, 25000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  Mova is running!");
  console.log(`  Open        http://localhost:${PORT}`);
  console.log("  On your network, friends on the same wifi can use your local IP.");
  console.log("  To go worldwide, deploy this folder to Railway / Render / a VPS.");
  console.log("");
});
