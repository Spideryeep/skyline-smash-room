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
