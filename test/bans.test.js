// Tests for the room server's bans and mods. Run with:  npm test
// It starts its own copy of the server on a spare port with a made-up test key
// and a throwaway lists file, so it never touches the real server on Render.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const KEY = "TESTKEY12345";
const DATA = path.join(os.tmpdir(), `sf-lists-${process.pid}.json`);
const URL = `ws://127.0.0.1:${PORT}`;
const PIDS = { owner: "a".repeat(32), mod: "b".repeat(32), bad: "c".repeat(32) };

let failed = 0;
function check(ok, what) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
}

function startServer() {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), OWNER_KEY: KEY, DATA_FILE: DATA },
    stdio: "ignore",
  });
  return new Promise((res) => setTimeout(() => res(srv), 600));
}

function client(name, pid) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.waiters = [];
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      ws.inbox.push(m);
      for (const w of ws.waiters.slice()) if (w.test(m)) { ws.waiters.splice(ws.waiters.indexOf(w), 1); w.res(m); }
    });
    ws.on("error", rej);
    ws.on("open", () => {
      ws.say = (m) => ws.send(JSON.stringify(m));
      ws.wait = (t, ms = 2000) => {
        const hit = ws.inbox.find((m) => m.t === t);
        if (hit) { ws.inbox.splice(ws.inbox.indexOf(hit), 1); return Promise.resolve(hit); }
        return new Promise((r2) => {
          const w = { test: (m) => m.t === t, res: (m) => { ws.inbox.splice(ws.inbox.indexOf(m), 1); r2(m); } };
          ws.waiters.push(w);
          setTimeout(() => { const i = ws.waiters.indexOf(w); if (i >= 0) { ws.waiters.splice(i, 1); r2(null); } }, ms);
        });
      };
      if (pid) ws.say({ t: "me", pid, name });   // an old game (no pid) never says who it is
      res(ws);
    });
  });
}

function status(pid) {
  return new Promise((res) => {
    http.get(`http://127.0.0.1:${PORT}/rooms?pid=${pid}`, (r) => {
      let s = "";
      r.on("data", (c) => (s += c));
      r.on("end", () => res(JSON.parse(s)));
    });
  });
}

async function main() {
  try { fs.unlinkSync(DATA); } catch {}
  let srv = await startServer();
  try {
    const owner = await client("LEO", PIDS.owner);
    owner.say({ t: "owner", key: KEY });
    check(!!(await owner.wait("owner_ok")), "the right key makes you the Owner");

    const wrong = await client("FAKE", "d".repeat(32));
    wrong.say({ t: "owner", key: "WRONGKEY999" });
    check(!!(await wrong.wait("owner_no")), "a wrong key does not");
    wrong.close();

    owner.say({ t: "create", public: false });
    const joined = await owner.wait("joined");
    const code = joined && joined.code;
    check(!!code, "the Owner makes a room");

    const mod = await client("MODB", PIDS.mod);
    const bad = await client("BADC", PIDS.bad);
    mod.say({ t: "join", code });
    bad.say({ t: "join", code });
    check(!!(await mod.wait("joined")) && !!(await bad.wait("joined")), "two players join the room");

    mod.say({ t: "ban", name: "BADC", mins: 0 });
    check(!(await bad.wait("banned", 500)), "a player who is not a mod can't ban");

    owner.say({ t: "mod", name: "MODB" });
    const m1 = await mod.wait("mod");
    check(m1 && m1.on === true, "the Owner makes MODB a mod");

    mod.say({ t: "mod", name: "BADC" });
    check(!(await bad.wait("mod", 500)), "a mod can't make other mods");

    mod.say({ t: "ban", name: "BADC", mins: 0 });
    check(!!(await mod.wait("ban_sent")), "a mod's ban goes to the Owner as a request");
    const req = await owner.wait("ban_req");
    check(req && req.name === "BADC", "the Owner sees the request");
    check(!(await bad.wait("banned", 300)), "nobody is banned before the Owner says yes");

    owner.say({ t: "ban_answer", rid: req.rid, ok: true, mins: 60 });
    const b = await bad.wait("banned");
    check(b && b.left > 0, "after the Owner says yes, BADC is banned for an hour");
    check(!!(await mod.wait("ban_accepted")), "the mod hears it was accepted");

    bad.say({ t: "join", code });
    const e = await bad.wait("error");
    check(e && e.why === "banned", "a banned player can't join a room");
    check((await status(PIDS.bad)).ban > 0, "the status page says BADC is banned");

    owner.say({ t: "ban", name: "LEO", mins: 0 });
    check(!(await owner.wait("banned", 400)), "the Owner can't be banned");

    // a player with an old version of the game (no player id)
    const old = await client("", null);
    old.say({ t: "join", code });
    const oj = await old.wait("joined");
    check(!!oj, "a player with an old game joins");
    mod.say({ t: "ban", id: oj.id, mins: 0 });
    const on = await mod.wait("tool_no");
    check(on && on.why === "old_game", "a mod is told that player has an old game");
    owner.say({ t: "ban", id: oj.id, mins: 0 });
    check(!!(await owner.wait("kick_ok")), "the Owner's ban kicks the old game out");
    const ke = await old.wait("error");
    check(ke && ke.why === "kicked", "the old game is told it was kicked");
    const old2 = await client("", null);
    old2.say({ t: "join", code });
    const ke2 = await old2.wait("error");
    check(ke2 && ke2.why === "kicked", "it can't come straight back to that room");
    old2.close();

    // the lists survive a server restart (on Render, until the free plan wipes the disk)
    for (const c of [owner, mod, bad]) c.close();
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    srv = await startServer();
    check((await status(PIDS.bad)).ban > 0, "the ban is still there after a restart");
    const mod2 = await client("MODB", PIDS.mod);
    const you = await mod2.wait("you");
    check(you && you.mod === true, "MODB is still a mod after a restart");

    const owner2 = await client("LEO", PIDS.owner);
    owner2.say({ t: "owner", key: KEY });
    await owner2.wait("owner_ok");
    owner2.say({ t: "unban", name: "BADC" });
    check(!!(await owner2.wait("unban_ok")), "the Owner unbans BADC");
    check((await status(PIDS.bad)).ban === 0, "BADC is no longer banned");
    owner2.say({ t: "unmod", name: "MODB" });
    const m2 = await mod2.wait("mod");
    check(m2 && m2.on === false, "the Owner takes mod away from MODB");
    owner2.close();
    mod2.close();
  } finally {
    srv.kill();
    try { fs.unlinkSync(DATA); } catch {}
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
