// Skyline Smash VR room server.
//
// Players connect over a WebSocket. Text frames are small JSON control
// messages (make a room, join one, who came and went). Binary frames are game
// messages; the server just passes each one on to everyone else in the same
// room, and never reads inside them.
//
// Run: npm install && npm start   (listens on $PORT, default 8080)

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500;
const MAX_FRAME = 256 * 1024;        // biggest single message a player may send
const RATE_BYTES = 400 * 1024;       // per player, per second, before we drop
const PROTOCOL = 1;

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

function enter(ws, room) {
  leave(ws);
  const others = [...room.players.keys()];
  room.players.set(ws.id, ws);
  ws.room = room;
  send(ws, { t: "joined", id: ws.id, code: room.code, public: room.public, peers: others, max: MAX_PLAYERS });
  for (const [, other] of room.players) {
    if (other !== ws) send(other, { t: "peer_join", id: ws.id });
  }
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.id);
  ws.room = null;
  for (const [, other] of room.players) send(other, { t: "peer_left", id: ws.id });
  if (room.players.size === 0) rooms.delete(room.code);
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
  }
}

const server = http.createServer((req, res) => {
  // Render (and people) can open the address in a browser to check it's up.
  let players = 0;
  for (const r of rooms.values()) players += r.players.size;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Skyline Smash room server is running. Rooms: ${rooms.size}, players: ${players}\n`);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME });

wss.on("connection", (ws) => {
  ws.id = nextId++;
  if (nextId > 2000000000) nextId = 2;
  ws.room = null;
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
