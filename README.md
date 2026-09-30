# Errander Pilot — shared task feed (v5)

This is a small, real backend: when someone posts a task on their phone, it's
saved to shared storage (Netlify Blobs) and shows up live on everyone else's
phone within a few seconds.

## ⚠️ v5 is a structural change — read this first

Earlier versions had no real accounts — "being" someone was just typing a
name into a box on that one device. **v5 replaces that with real accounts**:
phone number + PIN, one profile per person, and that profile is what "Boss"
and "Errander" now hang off. This means:

- **Old pilot testers need to create a new account.** There's no migration
  from the old name-based identity — it wasn't a real identity to migrate.
- **Erranders now need admin approval to actually transact**, not just a
  "simulate approval" button. Applications sit as "pending" until someone
  logs into `/` → the "Admin" link in the footer → approves or rejects them.
  **Someone (you) needs to actually do this** for any Errander to be able to
  accept or quote on tasks — it's not automatic anymore.
- **Change the admin passcode before using this with real people.** It's set
  in `netlify/functions/api.js` as `ADMIN_PASSCODE = 'errander-admin-2026'`
  near the top of the file — edit that line in your GitHub repo before
  deploying to anyone outside your own testing.
- **The PIN system is pilot-grade security, not production security.** PINs
  are hashed (not stored in plain text) but there's no session/token system —
  the app just remembers your phone number locally and trusts it. Someone who
  knows another person's phone number and can get at their unlocked phone
  could act as them. Fine for a supervised pilot with people you know; not
  fine for a public launch.

**What's new in this version:**
- **Real accounts** (phone + PIN) replace per-device name typing. One profile
  can act as a Boss and, once approved, also as an Errander — switching
  between the two is just switching tabs on your own dashboard, not
  re-registering.
- **A personal dashboard** — your profile card (name, phone, photo, Errander
  approval status), three tabs: **Post a Task** (Boss), **Find Jobs**
  (Errander — locked until approved), and **My Report**.
- **My Report** — as a Boss: total tasks requested, completed, active,
  cancelled, total spent. As an approved Errander: jobs completed, total
  earned, and total expected from jobs currently in progress.
- **An Admin portal** — reachable via the small "Admin" link in the footer.
  Shows pending Errander applications (name, phone, ID type/number, photo)
  with Approve/Reject buttons, a full user roster with each person's
  Errander status, and task counts by status across the whole pilot.
- **Server-enforced approval gating** — accepting or quoting on a task now
  checks, on the server, that the phone number belongs to an account with
  `errander.status === 'approved'`. A pending or rejected applicant is
  blocked even if they try to call the API directly, not just hidden by the
  UI.
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
- Login is phone + PIN with no session tokens, SMS verification, or password
  reset flow — see the security note above.
- No real payment — "confirm" and "payout" are simulated, not a live transaction.
- ID verification is a form a human (you, via the Admin portal) approves —
  not an automated check against a government database.
- First Errander to tap "Accept" gets a fixed-price task — no dispatch
  algorithm, and a Boss can't currently choose between multiple interested
  Erranders on a fixed-price task (only on quote-request tasks, via quotes).
- Chat messages aren't moderated or exportable beyond this pilot's storage —
  fine for supervised testing, not for a public launch without a
  reporting/blocking mechanism.

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
  it, the app falls back to the typed location text.
- **Phone + PIN has no recovery flow** — if someone forgets their PIN in
  this pilot, the only fix right now is creating a new account with the
  same phone number... which the backend will reject as a duplicate. For a
  short supervised pilot that's an acceptable rough edge; add a real PIN
  reset before running this longer.
- Use the "Reset demo data" button (My Report tab) to clear the task board
  between pilot test sessions. It does not clear user accounts — there's no
  UI for that yet, since wiping real people's accounts mid-pilot would be
  more disruptive than useful.

