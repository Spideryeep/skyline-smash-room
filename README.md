# Skyline Smash room server

This small program runs the online rooms for Skyline Smash VR: public rooms,
private rooms and room codes. It runs free on Render.

## Put it online (about 5 minutes, works from a phone)

1. Put these files in a GitHub repository (Claude can do this for you once
   your GitHub is connected).
2. Go to render.com and tap **Get Started**. Sign up with **GitHub**. It's free.
3. Tap **New +** and pick **Blueprint**.
4. Pick the **skyline-smash-rooms** repository, then tap **Apply**.
   Render reads `render.yaml` and sets everything up on the free plan.
5. Wait for it to say **Live**. Copy the address at the top. It looks like
   `https://skyline-smash-rooms-abcd.onrender.com`.
6. Open that address in a browser. You should see
   "Skyline Smash room server is running."
7. Send the address to Claude, who builds it into the game.

## Good to know
- On the free plan the server falls asleep after about 15 minutes with
  nobody connected. The first player in then waits up to a minute while it
  wakes up; the game keeps trying by itself.
- Up to 8 heroes per room. Codes are 4 digits.
- The server only passes game messages between players in the same room. It
  keeps no accounts and saves nothing.

## Run it on a computer
```
npm install
npm start
```
It listens on port 8080 (or `$PORT`).

## Early Access badge

While early access is on, every player who joins gets the Early Access badge
in the game, and keeps it forever. It is on by default.

To end early access:

1. Open the room service on Render and go to **Environment**.
2. Add the variable `EARLY_ACCESS` with the value `off`, then **Save**.
3. Render restarts the server. From then on nobody new gets the badge;
   players who already have it keep it.

To turn it back on, change the value to `on` (or delete the variable).

## Owner check

The room server decides who the Owner is, so the Owner APK on its own gives
no owner powers in a room.

1. Open the room service on Render and go to **Environment**.
2. Add the variable `OWNER_KEY` with a secret key of at least 8 letters and
   numbers, then **Save**. Keep the key to yourself: don't put it in this repo,
   the game's source or any APK.
3. Click **Manual Deploy**, then **Deploy latest commit**, so the server with
   the owner check runs.
4. On the Quest, in the Owner APK, open Leo's Computer, press OPTIONS, then 5
   (OWNER KEY), type the key and press ENTER. It's saved on the headset.
5. Join a room. "OWNER CONFIRMED BY THE ROOM SERVER" means it worked.

Without `OWNER_KEY` nobody is the Owner in rooms. After 5 wrong keys a
connection stops being listened to until it reconnects.

Later, for the Meta store version, the game can prove who you are with your
Meta user id instead. That needs `META_APP_ID`, `META_APP_SECRET` and
`OWNER_META_ID` on Render. Set `META_APP_SECRET` only there, never in a file.

## Bans and mods

The room server keeps the ban list and the mod list, so a ban works in every
room, not just the one it happened in.

- The Owner can ban, unban, make mods and take mod away.
- A mod has the Ban Hammer only. A mod's ban is a request: it waits for the
  Owner to say yes (and pick how long) before anyone is banned.
- Nobody can ban the Owner.
- The lists are saved in `lists.json` on the server. Render's free plan wipes
  that file when the server restarts, so the Owner's game keeps a copy and puts
  it back the next time the Owner is confirmed.

To check that Render runs this version, open your server address with
`/rooms` on the end. The text should include `"bans":true`.

## Update the server on Render

Render runs whatever is in the GitHub repository. After Claude pushes a change:

1. Open dashboard.render.com and tap the **skyline-smash-rooms** service.
2. Look at **Events**. If the newest deploy shows the latest commit message
   and says **Deploy live**, you're done: Render did it by itself.
3. If not, tap **Manual Deploy**, then **Deploy latest commit**, and wait
   until it says **Live** (a minute or two).
4. Check: open your server address with `/rooms` on the end and look for
   `"bans":true`.

Your Environment settings (`OWNER_KEY`, `EARLY_ACCESS` and so on) stay as they
are; a deploy doesn't change them.

## Tests

```
npm install
npm test
```
The test starts its own copy of the server with a made-up key and checks the
Owner check, bans, mod requests, unbans and that the lists survive a restart.
