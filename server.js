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
  switch (m.t) {
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
    res.end(JSON.stringify({ v: PROTOCOL, rooms: live, players, public: open, early: EARLY, owner_check: OWNER_KEY.length >= 8 || !!(META_APP_ID && META_APP_SECRET && OWNER_META_ID) }));
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

server.listen(PORT, () => console.log(`Skyline Smash room server on port ${PORT}`));
