# Errander Pilot — shared task feed (v4)

This is a small, real backend: when someone posts a task on their phone, it's
saved to shared storage (Netlify Blobs) and shows up live on everyone else's
phone within a few seconds.

**What's new in this version:**
- **A home/welcome screen on launch** — no more landing straight in a form
  with no context. It explains what Errander does, shows the slogan, and
  offers two clear paths: "I'm a Boss" (task requester) or "I'm an Errander."
  Clicking the "Errander" wordmark in the header always brings you back here.
- **"Boss" replaces "Client" in the UI** for whoever's requesting a task — it
  pairs naturally with "Errander" and reads more like how people actually
  talk. (Code and API fields still say `client` internally — only the
  on-screen wording changed.)
- **No duplicate Errander registrations.** ID numbers are now checked against
  a real server-side registry, not just stored locally — signing up twice
  with the same Ghana Card or license number is rejected.
- **Driver's License added as a second ID option** alongside Ghana Card.
  Ghana Card format is validated against the standard `GHA-000000000-0`
  pattern; license numbers just need to look plausible (6+ characters) since
  there's no single published DVLA format to validate against — tighten this
  once you have real examples.
- **Photos for both sides.** A Boss can attach a photo when posting (reused
  across future posts once uploaded), and an Errander uploads one at
  sign-up. Photos are resized client-side before upload and shown to the
  other party once a task is matched — same reveal-on-match rule as phone
  numbers.
- **One active task at a time, per Errander.** Accepting or quoting is blocked
  (both client-side and server-side) while an Errander already has a task in
  progress. It unlocks the moment the Boss confirms the current one complete
  — matching "one job at a time, back to back" rather than juggling several.
- **Live-ish chat, once a task is matched.** A collapsible chat thread appears
  on the task once an Errander has accepted or had a quote accepted. It's
  polling-based (updates every ~4 seconds, same as the rest of the app) rather
  than a real-time socket connection — for a small pilot that's indistinguishable
  in practice, but it's not instant like a native chat app.
- **In-app + browser notifications** — a toast appears when your task is
  accepted, delivered, confirmed, or when a new chat message arrives. Tap the
  🔔 in the header once to allow real browser notifications too (works while
  the tab is open or backgrounded on desktop; mobile browsers may pause a
  fully-closed tab, so this isn't a substitute for real push notifications in
  a production build).
- **Contact numbers revealed on match** — once a task is accepted, the Boss
  sees the Errander's name + phone and vice versa. Nobody sees a stranger's
  number before there's a committed job.
- **Two-step completion, matching the escrow model** — the Errander can mark
  a job "picked up" and "delivered," but only the **Boss** can confirm it
  complete. That confirmation is what would trigger payout in a real build,
  and it's what unlocks the mutual rating prompts.
- **Mutual 1–5 star ratings** — after confirmation, the Boss rates the
  Errander and the Errander rates the Boss. Ratings and completed jobs move
  into a collapsed "Completed history" section so the active board stays
  uncluttered.
- **Distance-based sorting for Erranders** — tapping "Enable location" sorts
  open tasks by real distance (using the browser's Geolocation API). A Boss
  can similarly tap "Use my current location" when posting so their task
  carries real coordinates instead of just a typed place name.
- **Cancel an open task** — a Boss can pull back a task nobody's accepted yet.

**Still simplified on purpose:**
- No real login — a client or Errander just types their name (matching is
  done by name, so don't reuse the same name for two different people during
  a pilot).
- No real payment — "confirm" and "payout" are simulated, not a live transaction.
- Ghana Card verification is a form + a "simulate approval" button.
- First Errander to tap "Accept" gets a fixed-price task — no dispatch
  algorithm, and a client can't currently choose between multiple interested
  Erranders on a fixed-price task (only on quote-request tasks, via quotes).
- No in-app chat — once contact numbers are revealed, coordination happens
  by phone call/SMS outside the app.
- **Chat messages aren't moderated or persisted beyond this pilot's storage** —
  fine for supervised testing, not for a public launch without a reporting/
  blocking mechanism.

## Deploy it (no coding required)

1. Unzip this folder.
2. Push the contents to a GitHub repo (drag-and-drop upload works — see below).
3. On app.netlify.com: "Add new site" → "Import an existing project" →
   "Deploy with GitHub" → pick the repo → deploy. Netlify auto-detects the
   `public` and `netlify/functions` folders from `netlify.toml`.
4. Test on two phones — post a task on one, accept/quote it as an Errander
   on the other.

If GitHub's drag-and-drop flattens your folder structure, upload the
`netlify` folder and `public` folder separately rather than all at once —
`netlify/functions/api.js` and `public/index.html` need to stay nested.

Netlify Blobs needs no setup — it's automatically wired up once deployed.
If the build fails, check that `package.json` made it into the repo root
(the `@netlify/blobs` dependency install is the most common failure point).

## Limits to know about before a real pilot

- **Not concurrency-safe at scale.** All tasks are stored as one JSON blob;
  two people accepting the same task in the same instant could race. Fine
  for a small pilot (tens of people), not for production volume.
- **Location requires the browser's permission prompt** — if someone denies
  it, the app falls back to the typed location text, same as before.
- **Anyone can rename themselves** — there's no authentication. Fine for a
  supervised pilot, not for a public launch.
- Use the "Reset demo data" button (Errander view) to clear the board
  between pilot test sessions.

