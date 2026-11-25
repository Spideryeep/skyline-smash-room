// Skyline Smash VR room server.
//
// Players connect over a WebSocket. Text frames are small JSON control
// messages (make a room, join one, who came and went). Binary frames are game
// messages; the server just passes each one on to everyone else in the same
// room, and never reads inside them.
//
// Run: npm install && npm start   (listens on $PORT, default 8080)

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500;
const MAX_FRAME = 256 * 1024;        // biggest single message a player may send
const RATE_BYTES = 400 * 1024;       // per player, per second, before we drop
const PROTOCOL = 1;
const KEEP_EMPTY_MS = 15 * 60 * 1000;  // how long an empty private room keeps its code

const rooms = new Map();             // code -> { code, public, players: Map(id -> ws) }
let nextId = 2;                      // ids start at 2 (1 means "nobody" in the game)

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeRoom(isPublic) {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode();
  if (!code) return null;
  const room = { code, public: !!isPublic, players: new Map() };
  rooms.set(code, room);
  return room;
}

// ---------------------------------------------------------------- the Owner
// The server, not the game, decides who the Owner is. A copied Owner APK gets
// no owner powers in rooms: the game only turns them on, and other headsets
// only accept the Owner's PvP hits and gifts, when this server says so.
//
// Now: OWNER_KEY (a Render environment variable). The Owner types the same key
// once on the computer in his apartment (OPTIONS, 5); it's never in any APK.
//
// Later, once the game is on the Meta store: the game sends its Meta user id
// and a user proof (nonce) from the Platform SDK, and this server asks Meta
// whether it's real (needs META_APP_ID, META_APP_SECRET and OWNER_META_ID).
const OWNER_KEY = String(process.env.OWNER_KEY || "").trim();
const META_APP_ID = String(process.env.META_APP_ID || "").trim();
const META_APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const OWNER_META_ID = String(process.env.OWNER_META_ID || "").trim();
const OWNER_TRIES = 5;   // wrong keys per connection before it stops listening

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function ownersIn(room) {
  return [...room.players.values()].filter(w => w.owner).map(w => w.id);
}

function tellOwners(room) {
  if (!room) return;
  const ids = ownersIn(room);
  for (const [, other] of room.players) send(other, { t: "owners", ids });
}

function setOwner(ws, ok, how) {
  ws.owner = !!ok;
  send(ws, { t: ok ? "owner_ok" : "owner_no", how });
  tellOwners(ws.room);
  if (ok) { sendLists(ws); sendPending(ws); }
}

// Meta's own check of a user proof from the Platform SDK.
function metaCheck(userId, nonce, finish) {
  let answered = false;
  const done = (ok) => { if (!answered) { answered = true; finish(ok); } };
  if (!META_APP_ID || !META_APP_SECRET || !OWNER_META_ID) return done(false);
  if (!/^[0-9]{1,24}$/.test(userId) || !/^[A-Za-z0-9_\-]{8,512}$/.test(nonce)) return done(false);
  if (userId !== OWNER_META_ID) return done(false);
  const body = new URLSearchParams({
    access_token: `OC|${META_APP_ID}|${META_APP_SECRET}`, nonce, user_id: userId,
  }).toString();
  const req = https.request({
    host: "graph.oculus.com", path: "/user_nonce_validate", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
    timeout: 8000,
  }, (res) => {
    let text = "";
    res.on("data", (c) => { if (text.length < 4096) text += c; });
    res.on("end", () => {
      try { done(JSON.parse(text).is_valid === true); } catch { done(false); }
    });
  });
  req.on("error", () => done(false));
  req.on("timeout", () => { req.destroy(); done(false); });
  req.end(body);
}

// ---------------------------------------------------------- bans and mods
// Every game (v0.22.14 and newer) makes a random player id the first time it
// starts and keeps it on the headset. Bans and mods are kept by that id, here
// on the server, so a banned game can't join any room. Only the Owner can make
// or remove mods, accept a ban, or unban. A mod's ban goes to the Owner, who
// accepts it (and picks how long) or cancels it.
//
// The lists are saved to DATA_FILE. Render's free plan forgets files when the
// server restarts, so the Owner's game keeps a copy too and puts the lists
// back the next time the Owner is confirmed after a restart.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "lists.json");
const bans = new Map();      // player id -> { name, until }  (until 0 = forever, else ms)
const mods = new Map();      // player id -> name
const seen = new Map();      // NAME -> player id, the last game seen with that name
const pending = new Map();   // request id -> { from, fromPid, pid, name, at }
let nextReq = 1;
let fresh = true;            // true until the lists were read from disk or put back

function loadLists() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const b of j.bans || []) if (validPid(b.pid)) bans.set(b.pid, { name: cleanName(b.name), until: Number(b.until) || 0 });
    for (const m of j.mods || []) if (validPid(m.pid)) mods.set(m.pid, cleanName(m.name));
    for (const [n, pid] of Object.entries(j.seen || {})) if (validPid(pid)) seen.set(cleanName(n), pid);
    fresh = false;
  } catch { /* first start, or the file is gone */ }
}

function saveLists() {
  fresh = false;   // the lists here are the ones that count now
  const j = {
    bans: [...bans].map(([pid, b]) => ({ pid, name: b.name, until: b.until })),
    mods: [...mods].map(([pid, name]) => ({ pid, name })),
    seen: Object.fromEntries([...seen].slice(-2000)),
  };
  try {
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(j));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) { console.log("couldn't save the lists:", e.message); }
}

function validPid(pid) { return typeof pid === "string" && /^[a-f0-9]{16,64}$/.test(pid); }
function cleanName(n) { return String(n || "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim().slice(0, 12); }

// ms of ban left: 0 = not banned, -1 = forever
function banLeft(pid) {
  const b = pid && bans.get(pid);
  if (!b) return 0;
  if (!b.until) return -1;
  const left = b.until - Date.now();
  if (left > 0) return left;
  bans.delete(pid);
  saveLists();
  return 0;
}

function allSockets() { return [...wss.clients]; }
function socketsOf(pid) { return allSockets().filter(w => w.pid === pid); }
function owners() { return allSockets().filter(w => w.owner); }

function findTarget(ws, m) {
  // a player in your room (by their room id), or anyone by the name they play as
  if (m.id !== undefined && ws.room) {
    const t = ws.room.players.get(Number(m.id));
    if (t) return { pid: t.pid, name: t.name || "", ws: t };
  }
  const name = cleanName(m.name);
  if (name) {
    const live = allSockets().find(w => w.name === name && w.pid);
    if (live) return { pid: live.pid, name, ws: live };
    if (seen.has(name)) return { pid: seen.get(name), name };
    for (const [pid, b] of bans) if (b.name === name) return { pid, name };
    for (const [pid, n] of mods) if (n === name) return { pid, name };
  }
  return null;
}

function applyBan(pid, name, mins) {
  const until = mins > 0 ? Date.now() + Math.min(mins, 525600) * 60000 : 0;
  bans.set(pid, { name, until });
  saveLists();
  const left = banLeft(pid);
  for (const w of socketsOf(pid)) {
    if (w.owner) continue;
    send(w, { t: "banned", left });
    leave(w);
  }
}

function sendLists(ws) {
  const now = Date.now();
  send(ws, {
    t: "lists", fresh,
    bans: [...bans].filter(([pid]) => banLeft(pid) !== 0).map(([pid, b]) => ({ pid, name: b.name, until: b.until, left: b.until ? b.until - now : -1 })),
    mods: [...mods].map(([pid, name]) => ({ pid, name })),
  });
}

function sendPending(ws) {
  for (const [rid, r] of pending) send(ws, { t: "ban_req", rid, from: r.from, name: r.name });
}

function onTools(ws, m) {
  const isMod = ws.pid && mods.has(ws.pid);
  switch (m.t) {
    case "ban": {
      if (!ws.owner && !isMod) return;
      const t = findTarget(ws, m);
      if (!t || !t.pid) return send(ws, { t: "tool_no", why: "not_found", name: cleanName(m.name) });
      if (t.ws && t.ws.owner) return send(ws, { t: "tool_no", why: "owner", name: t.name });
      if (ws.owner) {
        applyBan(t.pid, t.name, Number(m.mins) || 0);
        return send(ws, { t: "ban_ok", name: t.name, mins: Number(m.mins) || 0 });
      }
      // a mod: ask the Owner
      const now = Date.now();
      if (now - (ws.lastReq || 0) < 5000) return send(ws, { t: "tool_no", why: "wait", name: t.name });
      ws.lastReq = now;
      for (const [rid, r] of pending) if (r.pid === t.pid) pending.delete(rid);
      const rid = nextReq++;
      pending.set(rid, { from: ws.name || "A MOD", fromPid: ws.pid, pid: t.pid, name: t.name, at: now });
      while (pending.size > 50) pending.delete(pending.keys().next().value);
      for (const o of owners()) send(o, { t: "ban_req", rid, from: ws.name || "A MOD", name: t.name });
      return send(ws, { t: "ban_sent", name: t.name, owner_on: owners().length > 0 });
    }
    case "ban_answer": {
      if (!ws.owner) return;
      const r = pending.get(Number(m.rid));
      if (!r) return;
      pending.delete(Number(m.rid));
      const ok = m.ok === true;
      if (ok) applyBan(r.pid, r.name, Number(m.mins) || 0);
      for (const w of socketsOf(r.fromPid)) send(w, { t: ok ? "ban_accepted" : "ban_cancelled", name: r.name });
      for (const o of owners()) send(o, { t: "ban_req_done", rid: Number(m.rid) });
      return send(ws, ok ? { t: "ban_ok", name: r.name, mins: Number(m.mins) || 0 } : { t: "ban_dropped", name: r.name });
    }
    case "mod":
    case "unmod": {
      if (!ws.owner) return;
      const t = findTarget(ws, m);
      if (!t || !t.pid) return send(ws, { t: "tool_no", why: "not_found", name: cleanName(m.name) });
      const on = m.t === "mod";
      if (on) mods.set(t.pid, t.name); else mods.delete(t.pid);
      saveLists();
      for (const w of socketsOf(t.pid)) send(w, { t: "mod", on });
      return send(ws, { t: "mod_ok", name: t.name, on });
    }
    case "unban": {
      if (!ws.owner) return;
      const t = findTarget(ws, m);
      if (!t || !t.pid || !bans.has(t.pid)) return send(ws, { t: "tool_no", why: "not_banned", name: t ? t.name : cleanName(m.name) });
      bans.delete(t.pid);
      saveLists();
      for (const w of socketsOf(t.pid)) send(w, { t: "unbanned" });
      return send(ws, { t: "unban_ok", name: t.name });
    }
    case "lists":
      if (ws.owner) sendLists(ws);
      return;
    case "restore": {
      // after a restart, the Owner's game puts its copy of the lists back
      if (!ws.owner || !fresh) return;
      for (const b of (Array.isArray(m.bans) ? m.bans : []).slice(0, 2000)) {
        if (validPid(b.pid) && (!b.until || Number(b.until) > Date.now())) bans.set(b.pid, { name: cleanName(b.name), until: Number(b.until) || 0 });
      }
      for (const x of (Array.isArray(m.mods) ? m.mods : []).slice(0, 500)) if (validPid(x.pid)) mods.set(x.pid, cleanName(x.name));
      fresh = false;
      saveLists();
      for (const [pid] of bans) for (const w of socketsOf(pid)) if (!w.owner) { send(w, { t: "banned", left: banLeft(pid) }); leave(w); }
      for (const [pid] of mods) for (const w of socketsOf(pid)) send(w, { t: "mod", on: true });
      return sendLists(ws);
    }
  }
}

function enter(ws, room) {
  leave(ws);
  const others = [...room.players.keys()];
  room.players.set(ws.id, ws);
  room.emptySince = 0;
  ws.room = room;
  send(ws, { t: "joined", id: ws.id, code: room.code, public: room.public, peers: others, max: MAX_PLAYERS, owners: ownersIn(room) });
  for (const [, other] of room.players) {
    if (other !== ws) send(other, { t: "peer_join", id: ws.id });
  }
  if (ws.owner) tellOwners(room);
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.id);
  ws.room = null;
  for (const [, other] of room.players) send(other, { t: "peer_left", id: ws.id });
  if (room.players.size === 0) {
    // A private room stays open a while after everyone has gone, so its code
    // still works when a headset went to sleep (taken off to tell a friend the
    // code) or lost its Wi-Fi for a moment. Public rooms close at once.
    if (room.public) rooms.delete(room.code);
    else room.emptySince = Date.now();
  }
}

function onControl(ws, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m.t !== "string") return;
  if (["create", "random", "join"].includes(m.t) && !ws.owner) {
    const left = banLeft(ws.pid);
    if (left !== 0) return send(ws, { t: "error", why: "banned", left });
  }
  switch (m.t) {
    case "me": {
      // who this game is: its own player id and the name it plays as
      if (validPid(m.pid) && !ws.pid) ws.pid = m.pid;
      ws.name = cleanName(m.name);
      if (ws.pid && ws.name) {
        seen.delete(ws.name);
        seen.set(ws.name, ws.pid);
        while (seen.size > 5000) seen.delete(seen.keys().next().value);
        if (mods.has(ws.pid) && mods.get(ws.pid) !== ws.name) { mods.set(ws.pid, ws.name); saveLists(); }
        const b = bans.get(ws.pid);
        if (b && b.name !== ws.name) b.name = ws.name;
      }
      send(ws, { t: "you", mod: !!(ws.pid && mods.has(ws.pid)), banned: banLeft(ws.pid) });
      if (!ws.owner && banLeft(ws.pid) !== 0 && ws.room) leave(ws);
      break;
    }
    case "ban": case "ban_answer": case "mod": case "unmod": case "unban": case "lists": case "restore":
      onTools(ws, m);
      break;
    case "create": {
      const room = makeRoom(m.public === true);
      if (!room) return send(ws, { t: "error", why: "full" });
      enter(ws, room);
      break;
    }
    case "random": {
      const open = [...rooms.values()].filter(r => r.public && r.players.size < MAX_PLAYERS && r !== ws.room);
      let room = open.length ? open[Math.floor(Math.random() * open.length)] : makeRoom(true);
      if (!room) return send(ws, { t: "error", why: "full" });
      enter(ws, room);
      break;
    }
    case "join": {
      const code = String(m.code || "").replace(/[^0-9]/g, "").slice(0, 6);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", why: "no_room", code });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: "error", why: "room_full", code });
      enter(ws, room);
      break;
    }
    case "leave":
      leave(ws);
      break;
    case "owner": {
      ws.ownerTries = (ws.ownerTries || 0) + 1;
      if (ws.ownerTries > OWNER_TRIES) return send(ws, { t: "owner_no", how: "key", why: "tries" });
      const key = String(m.key || "").slice(0, 64);
      setOwner(ws, OWNER_KEY.length >= 8 && key.length > 0 && sameSecret(key, OWNER_KEY), "key");
      break;
    }
    case "meta_owner": {
      ws.ownerTries = (ws.ownerTries || 0) + 1;
      if (ws.ownerTries > OWNER_TRIES) return send(ws, { t: "owner_no", how: "meta", why: "tries" });
      metaCheck(String(m.user_id || ""), String(m.nonce || ""), (ok) => setOwner(ws, ok, "meta"));
      break;
    }
  }
}

// Early Access: while this is on, anyone whose game asks the server gets the
// Early Access badge (kept forever). To end early access, set the environment
// variable EARLY_ACCESS to off on Render (Environment tab) and save.
const EARLY = !/^(off|false|0|no)$/i.test(String(process.env.EARLY_ACCESS || "on").trim());

const server = http.createServer((req, res) => {
  // Render (and people) can open the address in a browser to check it's up.
  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  const live = [...rooms.values()].filter(r => r.players.size > 0).length;
  if (req.url && req.url.startsWith("/rooms")) {
    // the open public rooms, for the game's room page (newest game versions)
    const open = [...rooms.values()]
      .filter(r => r.public && r.players.size > 0 && r.players.size < MAX_PLAYERS)
      .map(r => ({ code: r.code, n: r.players.size }))
      .slice(0, 20);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    // a game that was banned asks with its player id whether it still is
    let ban;
    const q = req.url.indexOf("?pid=");
    if (q >= 0) {
      const pid = req.url.slice(q + 5).split("&")[0];
      if (validPid(pid)) ban = banLeft(pid);
    }
    res.end(JSON.stringify({ v: PROTOCOL, bans: true, ban, rooms: live, players, public: open, early: EARLY, owner_check: OWNER_KEY.length >= 8 || !!(META_APP_ID && META_APP_SECRET && OWNER_META_ID) }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Skyline Smash room server is running. Rooms: ${live}, players: ${players}\n`);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME });

wss.on("connection", (ws) => {
  ws.id = nextId++;
  if (nextId > 2000000000) nextId = 2;
  ws.room = null;
  ws.owner = false;
  ws.alive = true;
  ws.bytes = 0;
  ws.on("pong", () => { ws.alive = true; });
  send(ws, { t: "hello", id: ws.id, v: PROTOCOL });
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return onControl(ws, data.toString());
    ws.bytes += data.length;
    if (ws.bytes > RATE_BYTES || !ws.room) return;
    for (const [, other] of ws.room.players) {
      if (other !== ws && other.readyState === 1) other.send(data, { binary: true });
    }
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

// Close private rooms that have been empty for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > KEEP_EMPTY_MS) rooms.delete(code);
  }
}, 30000);

// Byte budget refill, and drop players whose headset went away without saying.
setInterval(() => { for (const ws of wss.clients) ws.bytes = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

loadLists();
server.listen(PORT, () => console.log(`Skyline Smash room server on port ${PORT}`));
