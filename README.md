# Errander Pilot — shared task feed (v8.1)

## New in v8: fair-price bands, receipts, and tighter security

**Price bands.** Every job now shows a "typical" GHS range, computed from the
category, distance, number of stops, waiting hours and urgency. Bosses see it
live while posting; Erranders see it on every job. Outliers get a warning
(they are never blocked, except sponsored jobs, below). Edit the numbers in
**Admin → Price bands**. **The shipped numbers are placeholders, not market
data** — replace them with real Kumasi prices before the pilot, and revisit weekly.

**Sponsored cap.** A sponsored job cannot be posted, countered or accepted above
the top of its typical range. This is enforced on the server.

**Receipts for purchase errands.** Tick "The Errander must buy items" and set a
reimbursement limit. The Errander enters the receipt total and photographs it to
confirm the purchase; the Boss pays back exactly that amount, and can raise the
limit via chat/button if needed. Item costs are never covered by sponsorship.

**Fixes included.**
- The 4-second refresh no longer wipes typed text, open chat/details, or scroll position.
- Phone numbers, chat and proof photos are hidden from everyone except the Boss and the matched Errander (before: phone numbers were visible in the raw `list` response).
- The agreed price comes from the server's negotiation record; a tampered client can't change it.
- Admin endpoints now require the passcode on every request.
- You can't accept your own task; only the right party can cancel, advance, confirm, rate or chat.
- "Reset all task data" moved into the Admin portal and needs the passcode.

**v8.1 chat fix:** the Send button broke whenever a user's name contained a quote or similar character (and sometimes after a refresh); chat now identifies you by phone, Enter sends, and a two-phone test confirms messages flow both ways.

**Deploying v8:** replace `netlify/functions/api.js`, `public/index.html` and this README, redeploy, then check the footer shows **build v8.1**. Still change `ADMIN_PASSCODE` in `api.js` first.

Known limit (unchanged): there are no session tokens, so a technically skilled user who knows another person's phone number could forge requests. Fine for a supervised KNUST pilot; fix before a public launch.


## Debugging "Dashboard not responding" and "others can't see jobs"

**A real bug, found and fixed:** the notification toast container sat on
top of the entire page (including the header) with no exemption for empty
space — an invisible layer that could silently swallow taps near the top of
the screen depending on exact browser rendering, even with no toast visibly
showing. It's now set to ignore clicks everywhere except an actual visible
toast bubble. Separately, tapping "Dashboard" in the header while you're
already on the dashboard (just scrolled down on a different tab) does
nothing visible by design — it's now made to also scroll back to the top,
so it always has a visible effect.

**How to tell, going forward, whether your live site actually has the
latest code:** the footer now shows a build tag (e.g. "build v7.3"). After
redeploying, hard-refresh the page and check that number — if it still
shows an old version, the issue is the deploy, not the code; if it shows
the new version and something's still wrong, it's a real bug worth
reporting with specifics.

**On "jobs posted cannot be seen by others":** there are two different
possible causes, worth telling apart —
1. **By design**, a Boss only ever sees tasks *they themselves* posted —
   there's no public feed of everyone's tasks. The shared, cross-device
   list only shows up under **Find Jobs**, and only once that account has
   applied *and been approved* as an Errander via the Admin portal. If your
   test accounts are Bosses, or Erranders still pending approval, "can't
   see jobs" is expected, not a bug — go approve them in Admin first.
2. If an account genuinely *is* an approved Errander and still sees nothing
   that another device posted, that would be a real sync bug — open
   browser dev tools (easiest on desktop Chrome: F12 → Console/Network tab)
   and check for a red error or a failed request to
   `/.netlify/functions/api` — that's the fastest way to tell me exactly
   what's failing rather than me guessing again.

**New: a Boss/Errander mode banner.** A colored bar now sits at the top of
each dashboard tab — navy "👤 BOSS MODE" on Post a Task, green "🛵 ERRANDER
MODE" on Find Jobs — so which hat you're wearing is never ambiguous, and
the tab buttons themselves now highlight in that same color when active
instead of all three looking identical.



## Fixes from real-device testing feedback

- **Slogan corrected** to "My Kpakpakpa money making place."
- **Touch targets enlarged across the whole app.** Buttons, chips, star
  ratings, and form fields were sized for a mouse pointer, not a thumb —
  every interactive element is now at least ~42–44px tall, the accepted
  minimum for reliable mobile tapping. The header specifically was prone to
  cramming the Dashboard/Log out buttons into an overcrowded row on narrow
  phones; it now wraps onto its own full-width row with proper spacing
  instead of squeezing everything into one line. This was very likely the
  actual cause of "buttons not responding" — the taps were landing just
  outside tiny targets, not failing silently.
- **Boss can now see pickup/delivery photos** on their own posted-task
  card — previously only the Errander's own view showed proof photos, so a
  Boss confirming a sponsored job couldn't actually see the evidence. Tap
  any proof photo to open it full-size.
- **Long lists scroll inside their own panel** ("Your posted tasks," open
  jobs, completed history) rather than pushing the whole page down
  indefinitely — a proper scrollable portal once there are more than a
  few tasks.
- **Editable profile.** Name and a personal quote/motto (140 characters,
  shown on your profile card) can now be edited from the dashboard, not
  just the photo. "✏️ Edit name & personal quote" on the profile card.


## Brand update: real logo + palette

- Colors sampled directly from the submitted logo file: navy `#0B2A57`
  (trust), green `#0E7A3B` (safety/service/"done"), gold `#FDC902` /
  `#E09500` (speed/value — a brighter tone for text on navy, a deeper tone
  for text on white), background shifted to true white per the brand's
  "transparency & simplicity" note. The off-brand teal that had crept into
  category labels and badges now resolves to the same brand green.
- The actual logo is in the app: the icon mark (the "E" + shield) is the
  favicon and sits in the header next to the wordmark; the full lockup
  (icon + wordmark + tagline) is the hero image on the home screen. Both
  live at `public/assets/logo-icon.png` and `public/assets/logo-hero.png`
  — replace those two files directly if the logo is revised later, no code
  changes needed.


## New in v7: KNUST-sponsored tasks, with fraud controls

For the 100-student KNUST pilot where Errander (the company) pays instead of
the Boss, the risk is obvious: if the Boss isn't the one paying, a Boss and
Errander who know each other have no financial reason not to just fake a
job and split the free money. This version builds in the controls we
discussed to close that gap:

- **A "🎓 KNUST-sponsored" toggle** on the post-task form. When checked, the
  Errander-company (not the Boss) covers the agreed price — the Boss pays
  nothing, no platform fee applies. A live counter shows remaining slots out
  of the `SPONSORED_CAP` (100 by default, edit the constant in `api.js`).
  Once the cap is hit, the toggle disappears for everyone.
- **Photo proof is mandatory on sponsored jobs**, enforced server-side, not
  just in the UI. The Errander can't advance from "accepted" to "picked up,"
  or "picked up" to "delivered," without attaching a photo at each step —
  the API rejects the advance otherwise.
- **The Boss's confirmation no longer pays out instantly for sponsored
  jobs.** Confirming moves the job into an admin review queue instead
  (`reviewStatus: 'pending'`) — a human has to look at the photos and
  approve it before it counts as completed or anyone's earnings reflect it.
  This is the main structural fix: money now requires an approver who isn't
  party to the transaction, not just the two people who'd benefit from
  faking it.
- **One sponsored job per Boss–Errander pair, for the whole pilot.** Once a
  specific pair has done one sponsored job together, the API blocks them
  from doing a second — makes repeat collusion between the same two people
  meaningfully harder, since every attempt needs a new accomplice.
- **Rejecting a review flags both accounts.** A `flagCount` appears on the
  Boss's and Errander's profile (visible to them, and prominently in the
  Admin portal's user list) — not an automated ban, just a visible signal
  for you to act on with institutional consequences (e.g. reporting to the
  Dean of Students' office, as discussed).

**What this doesn't solve, and what still needs a human:** the person
reviewing sponsored jobs in the Admin portal needs to actually look
critically at the photos and occasionally spot-check by contacting the Boss
directly — photo proof raises the bar on casual fraud but doesn't stop two
people willing to stage photos together. At 100 transactions, following up
on all of them directly is realistic; that follow-up is still on you, not
something software can fully replace.

## New in v6: negotiation, platform fee, Errander University

- **Negotiation.** A Boss's posted price is now an opening offer, not fixed.
  Any approved Errander viewing it can **Accept** outright or **Counter**
  with their own number. The Boss sees every counter (if several Erranders
  are interested, each gets their own thread) and can **Accept** or
  **counter back** — this can go back and forth until someone accepts.
- **Platform fee, shown to both sides, everywhere a price appears.** It's
  added on top and paid by the Boss — the Errander always receives exactly
  the agreed amount. Rate is `PLATFORM_FEE_RATE` near the top of
  `netlify/functions/api.js` (10% by default) — change it there, not in the
  frontend; the frontend fetches it from the API on load so there's one
  source of truth.
- **Errander University certification.** A 🎓 badge an admin can grant to
  an approved Errander (Admin portal → "All users" → grant/remove button).
  It shows next to their name wherever a Boss sees them — most usefully
  when several Erranders have countered on the same task and the Boss is
  choosing who to engage. **The course content itself isn't built** — this
  is the verification badge mechanic only; authoring an actual curriculum
  is a separate, non-software task.

This is a small, real backend: when someone posts a task on their phone, it's
saved to shared storage (Netlify Blobs) and shows up live on everyone else's
phone within a few seconds.

## v5: accounts replaced per-device identity

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
- First Errander to tap "Accept" gets the task at the Boss's listed price —
  no dispatch algorithm. If multiple Erranders counter instead of accepting
  outright, the Boss can compare and choose between them (see "Negotiation"
  above); but once any one Errander is accepted, every other thread on that
  task simply stops mattering — there's no notification to the Erranders who
  didn't get picked.
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

