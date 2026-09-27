# Errander Pilot — shared task feed

This is a small, real backend: when someone posts a task on their phone, it's
saved to shared storage (Netlify Blobs) and shows up live on everyone else's
phone within a few seconds — no more per-browser fake data.

What's simplified on purpose, so the pilot stays testable:
- No real login — a client or Errander just types their name.
- No real payment — the "escrow" language is a note, not a live transaction.
- Ghana Card verification is a form + a "simulate approval" button, not a real ID check.
- First Errander to tap "Accept" gets a fixed-price task — no matching algorithm yet.

## Deploy it (no coding required)

**1. Put the code on GitHub**
- Go to github.com, sign in (or create a free account).
- Click "+" → "New repository". Name it `errander-pilot`, keep it Private or Public, click Create.
- On the new repo's page, click "uploading an existing file".
- Drag in every file and folder from this project (keep the folder structure —
  `netlify/functions/api.js` and `public/index.html` need to stay in those subfolders).
- Click "Commit changes".

**2. Connect it to Netlify**
- Go to app.netlify.com, sign in (or create a free account — no credit card needed).
- Click "Add new site" → "Import an existing project" → "Deploy with GitHub".
- Pick the `errander-pilot` repo.
- Netlify should auto-detect the settings from `netlify.toml` (publish folder:
  `public`, functions folder: `netlify/functions`). Leave them as detected.
- Click "Deploy site".

**3. Test it**
- Netlify gives you a live URL like `random-name-123.netlify.app`.
- Open that link on two different phones (or one phone + one laptop).
- On phone A, switch to "I need something done" and post a task.
- On phone B, switch to "I'm an Errander", complete the sign-up (any name +
  a Ghana-Card-shaped number like `GHA-123456789-0`), tap "Simulate approval",
  and the task from phone A should appear within a few seconds.

Netlify Blobs needs no setup — it's automatically wired up to your site once
deployed. If a build fails, check the Netlify "Deploys" log; the most common
cause is the `@netlify/blobs` dependency failing to install, which usually
means `package.json` wasn't uploaded to the repo root.

## Limits to know about before a real pilot

- **Not concurrency-safe at scale.** All tasks are stored as one JSON blob;
  two people accepting the same task in the same instant could race. Fine
  for a small pilot (tens of people), not for production volume.
- **No real payments or ID checks yet** — see the notes above. Before
  handling real money or real Ghana Card photos, revisit the escrow and
  Data Protection Commission points from earlier.
- **Anyone can rename themselves** — there's no authentication, so "being"
  a specific Errander is just typing their name. Fine for a supervised
  pilot, not for a public launch.
- Use the "Reset demo data" button (Errander view) to clear the board
  between pilot test sessions.
