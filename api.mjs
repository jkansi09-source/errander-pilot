// Errander pilot API — v8
// Adds: admin-editable price bands (typical range per job), a sponsored-job
// price cap enforced on the server, receipt-based reimbursement for purchase
// errands, an agreed price the client can no longer tamper with, admin
// endpoints that actually require the admin passcode, contact/photo
// redaction for people who aren't party to a task, and a self-accept block.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Change these before any real pilot use — see README.
// Set ADMIN_PASSCODE in Netlify -> Site configuration -> Environment variables. The built-in default is public knowledge.
const DEFAULT_ADMIN_PASSCODE = 'errander-admin-2026';
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || DEFAULT_ADMIN_PASSCODE;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_TRIES = 5, LOCK_MS = 15 * 60 * 1000;
const PAYOUT_HOLD_MS = Number(process.env.PAYOUT_HOLD_HOURS || 48) * 3600 * 1000;   // weekly-payout jobs wait at least this long (dispute window)
const VERIFY_CALL_AT = 150;    // jobs at/above this price get a verification call before payout
const VERIFY_VISIT_AT = 400;   // jobs at/above this price get a site visit / in-person check
const PLATFORM_FEE_RATE = 0.10;   // added on top of the service price, paid by the Boss (non-sponsored only)
const SPONSORED_CAP = 100;        // total KNUST-sponsored slots for this pilot

// PLACEHOLDER price table (GHS). These are starting guesses, NOT market data.
// Replace them from the Admin portal ("Price bands") using real Kumasi prices.
// typical = base + perKm*km + perStop*(stops-1) + perHour*waitHours, then
// x(1+urgentUplift) if urgent. Range = typical x lowFactor .. typical x highFactor.
const DEFAULT_PRICE_CONFIG = {
  lowFactor: 0.8,
  highFactor: 1.3,
  urgentUplift: 0.25,
  updatedAt: null,
  categories: {
    'Delivery & Pickup':        { base: 15, perKm: 3, perStop: 5, perHour: 10 },
    'Errands & Queuing':        { base: 15, perKm: 3, perStop: 5, perHour: 12 },
    'Home Services · Plumbing': { base: 60, perKm: 4, perStop: 0, perHour: 40 },
    'Home Services · Cleaning': { base: 50, perKm: 3, perStop: 0, perHour: 30 },
    'Business & Field':         { base: 25, perKm: 3, perStop: 8, perHour: 15 }
  }
};

function num(v, min, max, dflt) {
  let n = Number(v);
  if (!isFinite(n)) n = dflt;
  return Math.min(max, Math.max(min, n));
}
function cleanMetrics(m) {
  m = m || {};
  return {
    km: num(m.km, 0, 100, 3),
    stops: Math.round(num(m.stops, 1, 20, 1)),
    waitHours: num(m.waitHours, 0, 12, 0),
    urgent: m.urgent === true || m.urgent === '1' || m.urgent === 'true'
  };
}
function computeBand(cfg, category, metricsIn) {
  const m = cleanMetrics(metricsIn);
  const c = (cfg.categories && cfg.categories[category]) || cfg.categories['Delivery & Pickup'] || DEFAULT_PRICE_CONFIG.categories['Delivery & Pickup'];
  let typical = c.base + c.perKm * m.km + c.perStop * Math.max(0, m.stops - 1) + c.perHour * m.waitHours;
  if (m.urgent) typical *= (1 + cfg.urgentUplift);
  return {
    low: Math.round(typical * cfg.lowFactor),
    typical: Math.round(typical),
    high: Math.round(typical * cfg.highFactor),
    metrics: m
  };
}
function bandFlag(amount, band) {
  if (!band) return null;
  if (amount > band.high) return 'above';
  if (amount < band.low) return 'below';
  return null;
}
function sanitizeConfig(input, current) {
  input = input || {};
  const out = {
    lowFactor: num(input.lowFactor, 0.3, 1, current.lowFactor),
    highFactor: num(input.highFactor, 1, 3, current.highFactor),
    urgentUplift: num(input.urgentUplift, 0, 2, current.urgentUplift),
    updatedAt: Date.now(),
    categories: {}
  };
  Object.keys(current.categories).forEach(cat => {
    const src = (input.categories && input.categories[cat]) || {};
    const cur = current.categories[cat];
    out.categories[cat] = {
      base: num(src.base, 0, 10000, cur.base),
      perKm: num(src.perKm, 0, 1000, cur.perKm),
      perStop: num(src.perStop, 0, 1000, cur.perStop),
      perHour: num(src.perHour, 0, 1000, cur.perHour)
    };
  });
  return out;
}

// ---------- photo storage ----------
// Photos live in their own blob store, one file each. Tasks and users keep
// only a short random id ("p_...") instead of the image itself, and the
// browser downloads each image once (it is served with long-lived caching).
const isInline = (v) => typeof v === 'string' && v.startsWith('data:image/');
const isPhotoId = (v) => typeof v === 'string' && /^p_[a-f0-9]{24}$/.test(v);
async function storePhoto(photoStore, dataUrl) {
  const id = 'p_' + crypto.randomBytes(12).toString('hex');
  await photoStore.set(id, dataUrl);
  return id;
}
// Turn any inline photo into a stored id. Returns the id, or the value unchanged.
async function toPhotoId(photoStore, v) {
  return isInline(v) ? storePhoto(photoStore, v) : v;
}
const TASK_PHOTO_FIELDS = ['photo', 'pickupPhoto', 'deliveryPhoto', 'receiptPhoto', 'clientPhoto', 'erranderPhoto'];

// Opens a blob store that reads the freshest data available.
// Mode "direct": if BLOBS_TOKEN is set (see README), talk to Netlify's API
//   directly. Reads are then always up to date (no edge cache at all).
// Mode "strong": uncached reads through the function runtime, when supported.
// Mode "eventual": last resort; reads may be up to 60s old.
let blobsMode = 'unknown';
function openStore(name) {
  const token = process.env.BLOBS_TOKEN;
  if (token) {
    let siteID = process.env.BLOBS_SITE_ID || process.env.SITE_ID;
    if (!siteID) {
      try { siteID = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT || '', 'base64').toString()).siteID; } catch (e) { /* none */ }
    }
    if (siteID) {
      // The runtime's own (cached) connection details would take priority over ours, so drop them.
      delete process.env.NETLIFY_BLOBS_CONTEXT;
      try { delete globalThis.netlifyBlobsContext; } catch (e) { /* ignore */ }
      blobsMode = 'direct';
      return getStore({ name, siteID, token, apiURL: process.env.BLOBS_API_URL || undefined });
    }
  }
  const strong = getStore({ name, consistency: 'strong' });
  const normal = getStore(name);
  let mode = 'strong';
  blobsMode = 'strong';
  return {
    async get(k, o) {
      if (mode === 'strong') {
        try { return await strong.get(k, o); }
        catch (e) {
          if (!/strong consistency|uncachedEdgeURL/i.test(String(e && e.message))) throw e;
          mode = 'eventual'; blobsMode = 'eventual';
        }
      }
      return normal.get(k, o);
    },
    set: (k, v) => strong.set(k, v),
    setJSON: (k, v) => strong.setJSON(k, v)
  };
}

// Chat is one thread per (task, Errander): any approved Errander can ask the Boss
// about an open job, and the Boss answers each one separately. Threads for a task
// live in one blob "thr/<taskId>"; "thr-index" lists which Erranders have a thread.
async function loadThreads(store, t) {
  const blob = await store.get('thr/' + t.id, { type: 'json' });
  if (blob && blob.threads) return blob;
  // Older matched tasks: bring their single chat across as the matched Errander's thread.
  const out = { threads: {} };
  // Offers made under the older negotiation system become offer messages in the thread.
  for (const n of (t.negotiations || [])) {
    if (!n.erranderPhone || !n.amount) continue;
    out.threads[n.erranderPhone] = { name: n.erranderName, photo: n.erranderPhoto || null, messages: [{
      type: 'offer', amount: n.amount, sender: n.lastBy === 'boss' ? t.clientName : n.erranderName,
      by: n.lastBy === 'boss' ? t.clientPhone : n.erranderPhone, text: 'Offer: GHS ' + n.amount, ts: n.updatedAt || Date.now(), cid: 'legacy-' + n.erranderPhone
    }] };
  }
  if (t.erranderPhone && !out.threads[t.erranderPhone]) {
    const old = await store.get('chat/' + t.id, { type: 'json' });
    const msgs = (old && Array.isArray(old.messages)) ? old.messages : (t.messages || []);
    out.threads[t.erranderPhone] = { name: t.erranderName, photo: t.erranderPhoto || null, messages: msgs };
  }
  return out;
}

function legacyHashPin(phone, pin) {
  return crypto.createHash('sha256').update(phone + ':' + pin + ':errander-pilot-salt').digest('hex');
}
// New PINs use scrypt with a random salt (slow on purpose, so a leaked user list can't be cracked quickly).
function hashPin(phone, pin) {
  const salt = crypto.randomBytes(12).toString('hex');
  return 's2$' + salt + '$' + crypto.scryptSync(phone + ':' + pin, salt, 32).toString('hex');
}
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function checkPin(u, phone, pin) {
  if (typeof u.pinHash === 'string' && u.pinHash.startsWith('s2$')) {
    const [, salt, hash] = u.pinHash.split('$');
    return safeEq(crypto.scryptSync(phone + ':' + pin, salt, 32).toString('hex'), hash);
  }
  return safeEq(u.pinHash, legacyHashPin(phone, pin));
}

// Signed session tokens. Nothing is stored for them, so they work even while Netlify Blobs is serving stale reads.
// A token carries the phone, an expiry and the user's "epoch" (bumped when the PIN changes, which logs every device out).
let cachedSecret = null;
async function getSecret(store) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let sec = await store.get('session-secret', { type: 'text' });
  if (!sec) { sec = crypto.randomBytes(32).toString('hex'); await store.set('session-secret', sec); }
  cachedSecret = sec;
  return sec;
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function signToken(secret, user) {
  const payload = b64u(JSON.stringify({ p: user.phone, e: user.epoch || 0, x: Date.now() + SESSION_MS }));
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function readToken(secret, tok, usersList) {
  if (typeof tok !== 'string' || tok.length > 400) return null;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return null;
  if (!safeEq(crypto.createHmac('sha256', secret).update(payload).digest('base64url'), sig)) return null;
  let d; try { d = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!d || d.x < Date.now()) return null;
  const u = usersList.find(x => x.phone === d.p);
  if (!u || (u.epoch || 0) !== d.e) return null;
  return d.p;
}
const TERMS_VERSION = 'pilot-1';
const ALL_CATEGORIES = ['Delivery & Pickup', 'Errands & Queuing', 'Home Services · Plumbing', 'Home Services · Cleaning', 'Business & Field'];
// The pilot starts with the lowest-risk categories. Admin can switch others on under "Pilot categories".
const DEFAULT_ENABLED_CATEGORIES = ['Delivery & Pickup', 'Errands & Queuing'];
const TITLES = ['Prof.', 'Dr.', 'Rev.', 'Ing.', 'Mr.', 'Mrs.', 'Ms.'];
const cleanTitle = (v) => TITLES.includes(String(v || '').trim()) ? String(v).trim() : '';
// How a person's name appears to others: "Prof. Kwame Mensah" when they gave a title.
const fullName = (u) => (u && u.title ? u.title + ' ' : '') + (u ? u.name : '');
function publicUser(u) {
  return { phone: u.phone, name: u.name, title: u.title || '', termsAcceptedAt: u.termsAcceptedAt || null, mustChangePin: !!u.mustChangePin, photo: u.photo || null, bio: u.bio || null, createdAt: u.createdAt, errander: u.errander || null, flagCount: u.flagCount || 0 };
}
function normalizePhone(v) { return String(v || '').replace(/\s+/g, ''); }
function normalizeId(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// What a viewer is allowed to see of a task. Phone numbers, chat and proof
// photos are only for the Boss and the matched Errander; everyone else gets
// the public face of the task plus their own offer (if any).
// Which completed jobs need a human check before the Errander is paid.
// Bigger jobs get a bigger check; new or previously flagged people and a random 1-in-10 sample are also checked.
function verifyNeeds(t, tasks, boss, errander) {
  const reasons = [];
  let level = null;
  const amt = Number(t.budget) || 0;
  if (amt >= VERIFY_VISIT_AT) { level = 'visit'; reasons.push('High-value job (GHS ' + amt + ')'); }
  else if (amt >= VERIFY_CALL_AT) { level = 'call'; reasons.push('Mid-value job (GHS ' + amt + ')'); }
  if ((boss && boss.flagCount > 0) || (errander && errander.flagCount > 0)) { level = level || 'call'; reasons.push('A party has been flagged before'); }
  const done = tasks.filter(x => x.erranderPhone === t.erranderPhone && x.status === 'completed').length;
  if (done < 1) { level = level || 'call'; reasons.push("Errander's first job"); }
  let h = 0; for (const ch of String(t.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (h % 10 === 0) { level = level || 'call'; reasons.push('Random spot check'); }
  return level ? { level, reasons, status: 'pending', createdAt: Date.now(), note: '', agent: '' } : null;
}

function redactTask(t, viewer) {
  if (viewer && t.clientPhone === viewer) return t;
  const c = Object.assign({}, t);
  c.negotiations = (t.negotiations || []).filter(n => viewer && n.erranderPhone === viewer);
  if (!(viewer && t.erranderPhone === viewer)) {
    c.clientPhone = null; c.erranderPhone = null; c.messages = [];
    c.pickupPhoto = null; c.deliveryPhoto = null; c.receiptPhoto = null;
  }
  return c;
}

function blankTaskFields() {
  return {
    status: 'open', stage: null, negotiations: [], messages: [],
    erranderName: null, erranderPhone: null, erranderPhoto: null,
    ratingForErrander: null, ratingForClient: null,
    sponsored: false, pickupPhoto: null, deliveryPhoto: null, reviewStatus: null, bossConfirmedAt: null,
    metrics: null, band: null, priceFlag: null, photo: null,
    itemsLimit: null, receiptAmount: null, receiptPhoto: null, verify: null, payout: null
  };
}

function seedTasks() {
  const now = Date.now();
  return [
    Object.assign(blankTaskFields(), {
      id: 'seed-1', category: 'Delivery & Pickup',
      desc: "Pick up a document from the Registrar's office and deliver to my office",
      loc: 'Adum, Kumasi', lat: 6.6926, lng: -1.6291,
      urgency: 'Today', budget: 40,
      clientName: 'Sam O.', clientPhone: '0240000001', clientPhoto: null,
      createdAt: now
    }),
    Object.assign(blankTaskFields(), {
      id: 'seed-2', category: 'Home Services · Plumbing',
      desc: 'Fix a leaking kitchen tap',
      loc: 'Ahodwo, Kumasi', lat: 6.6581, lng: -1.6178,
      urgency: 'Tomorrow, 10:00 AM', budget: 60,
      clientName: 'Kojo B.', clientPhone: '0240000002', clientPhoto: null,
      createdAt: now
    })
  ];
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

async function core(event) {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Passcode, X-Session'
      },
      body: ''
    };
  }

  // Strong consistency: without it Netlify can serve a copy of the task list that
  // is up to 60 seconds old, so a freshly posted job would not show for the other
  // person and updates would appear to be missing.
  const store = openStore('errander-pilot');
  const photoStore = openStore('errander-photos');
  const qs = event.queryStringParameters || {};
  const action = qs.action || 'list';

  // Quick health check you can open in a browser: /.netlify/functions/api?action=health
  if (action === 'health') {
    const ts = await store.get('all-tasks', { type: 'json' });
    const us = await store.get('users', { type: 'json' });
    return json(200, {
      ok: true, version: 'v10.3', time: Date.now(),
      readMode: blobsMode,
      adminPasscodeIsDefault: ADMIN_PASSCODE === DEFAULT_ADMIN_PASSCODE,
      sessionSecretFromEnv: !!process.env.SESSION_SECRET,
      readModeNote: blobsMode === 'eventual' ? 'WARNING: reads may be up to 60s old. Set BLOBS_TOKEN (see README) for instant, reliable updates.' : 'ok',
      tasks: ts ? ts.length : 0,
      openTasks: ts ? ts.filter(t => t.status === 'open').length : 0,
      users: us ? us.length : 0
    });
  }

  // Serve one photo. Ids are 96-bit random, so they can't be guessed; the
  // browser caches each image for a year so it is only downloaded once.
  if (action === 'photo') {
    const id = String(qs.id || '');
    if (!isPhotoId(id)) return { statusCode: 404, body: 'not found' };
    const data = await photoStore.get(id, { type: 'text' });
    const m = data && /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(data);
    if (!m) return { statusCode: 404, body: 'not found' };
    return {
      statusCode: 200,
      headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable' },
      body: m[2],
      isBase64Encoded: true
    };
  }

  const hdrs = event.headers || {};
  const ip = String(hdrs['x-nf-client-connection-ip'] || (hdrs['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim().slice(0, 60);
  // Counts wrong guesses per key (a phone number or an IP) and locks that key for a while after too many.
  const lockLeft = async (key) => { const a = await store.get('att/' + key, { type: 'json' }); return (a && a.until > Date.now()) ? Math.ceil((a.until - Date.now()) / 60000) : 0; };
  const noteFail = async (key) => {
    const a = (await store.get('att/' + key, { type: 'json' })) || { n: 0 };
    const stale = a.last && Date.now() - a.last > LOCK_MS;
    const n = (stale ? 0 : (a.n || 0)) + 1;
    await store.setJSON('att/' + key, { n: n >= MAX_TRIES ? 0 : n, last: Date.now(), until: n >= MAX_TRIES ? Date.now() + LOCK_MS : 0 });
  };
  const clearFails = async (key) => { const a = await store.get('att/' + key, { type: 'json' }); if (a && (a.n || a.until)) await store.setJSON('att/' + key, { n: 0, until: 0 }); };

  // Every admin-* action needs the passcode on the request; wrong guesses are limited per IP.
  if (action.startsWith('admin-') && action !== 'admin-login') {
    const given = hdrs['x-admin-passcode'] || hdrs['X-Admin-Passcode'] || '';
    const left = await lockLeft('admin-' + ip);
    if (left) return json(429, { error: 'Too many wrong attempts. Try again in ' + left + ' minute(s).' });
    if (!safeEq(given, ADMIN_PASSCODE)) { await noteFail('admin-' + ip); return json(401, { error: 'Admin passcode required.' }); }
  }

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }

  let priceConfig = await store.get('price-config', { type: 'json' });
  if (!priceConfig) priceConfig = DEFAULT_PRICE_CONFIG;
  priceConfig = Object.assign({}, DEFAULT_PRICE_CONFIG, priceConfig, {
    categories: Object.assign({}, DEFAULT_PRICE_CONFIG.categories, priceConfig.categories || {})
  });

  const catSetting = await store.get('pilot-cats', { type: 'json' });
  const enabledCategories = (catSetting && Array.isArray(catSetting.enabled)) ? catSetting.enabled.filter(c => ALL_CATEGORIES.includes(c)) : DEFAULT_ENABLED_CATEGORIES;

  let tasks = await store.get('all-tasks', { type: 'json' });
  if (!tasks) { tasks = seedTasks(); await store.setJSON('all-tasks', tasks); }
  tasks.forEach(t => {
    if (!t.messages) t.messages = [];
    if (!t.negotiations) t.negotiations = t.quotes ? t.quotes.map(q => ({
      erranderPhone: q.erranderPhone, erranderName: q.erranderName, erranderPhoto: q.erranderPhoto || null,
      amount: q.price, lastBy: 'errander', updatedAt: Date.now()
    })) : [];
    delete t.quotes; delete t.quoteRequest;
    const blank = blankTaskFields();
    Object.keys(blank).forEach(k => { if (t[k] === undefined) t[k] = blank[k]; });
    if (t.clientPhoto === undefined) t.clientPhoto = null;
    if (!t.band) t.band = computeBand(priceConfig, t.category, t.metrics);
  });

  let users = await store.get('users', { type: 'json' });
  if (!users) { users = []; await store.setJSON('users', users); }
  users.forEach(u => {
    if (u.errander && u.errander.universityCertified === undefined) u.errander.universityCertified = false;
    if (u.flagCount === undefined) u.flagCount = 0;
  });

  // One-time migration: move any inline photos (from older versions) into the photo store.
  {
    let tasksChanged = false, usersChanged = false;
    for (const t of tasks) for (const f of TASK_PHOTO_FIELDS) {
      if (isInline(t[f])) { t[f] = await storePhoto(photoStore, t[f]); tasksChanged = true; }
    }
    for (const t of tasks) for (const n of (t.negotiations || [])) {
      if (isInline(n.erranderPhoto)) { n.erranderPhoto = await storePhoto(photoStore, n.erranderPhoto); tasksChanged = true; }
    }
    for (const u of users) if (isInline(u.photo)) { u.photo = await storePhoto(photoStore, u.photo); usersChanged = true; }
    if (tasksChanged) await store.setJSON('all-tasks', tasks);
    if (usersChanged) await store.setJSON('users', users);
  }

  const saveTasks = () => store.setJSON('all-tasks', tasks);
  const saveUsers = () => store.setJSON('users', users);
  const findUser = (phone) => users.find(u => u.phone === normalizePhone(phone));
  // Called whenever a job becomes completed. "instant" Erranders are paid now; "weekly" Erranders' money is held for the next payout window.
  const completePayout = (t) => {
    const e = findUser(t.erranderPhone);
    const mode = e && e.errander && e.errander.payoutMode === 'weekly' ? 'weekly' : 'instant';
    t.payout = { mode, status: mode === 'instant' ? 'paid' : 'held', completedAt: Date.now(), paidAt: mode === 'instant' ? Date.now() : null };
  };
  const isBusy = (erranderPhone) => tasks.some(x => x.erranderPhone === erranderPhone && x.status === 'accepted');
  const isApprovedErrander = (u) => u && u.errander && u.errander.status === 'approved';
  const sponsoredUsedCount = () => tasks.filter(t => t.sponsored && t.status !== 'cancelled' && t.reviewStatus !== 'rejected').length;
  const capMessage = (t) => `Sponsored jobs are capped at GHS ${t.band.high} (the top of the typical range for this job).`;

  // ---- who is calling? Every account action needs a valid signed session for the phone it acts as. ----
  const secret = await getSecret(store);
  const PUBLIC_ACTIONS = ['config', 'price-band', 'signup', 'login'];
  if (!PUBLIC_ACTIONS.includes(action) && !action.startsWith('admin-')) {
    let actor = '';
    if (action === 'list') actor = qs.phone || '';
    else if (action === 'accept') actor = body.by === 'boss' ? body.bossPhone : body.erranderPhone;
    else if (action === 'raise-item-limit') actor = body.bossPhone;
    else if (action === 'create') actor = body.clientPhone;
    else actor = body.phone || qs.phone || '';
    actor = normalizePhone(actor);
    if (actor || action !== 'list') {
      const who = readToken(secret, hdrs['x-session'], users);
      if (!actor || who !== actor) return json(401, { error: 'Please log in again.', auth: true });
    }
  }
  const sessionFor = (u) => signToken(secret, u);

  switch (action) {

    case 'config':
      return json(200, { feeRate: PLATFORM_FEE_RATE, sponsoredCap: SPONSORED_CAP, sponsoredUsed: sponsoredUsedCount(), supportPhone: process.env.SUPPORT_PHONE || '', categories: ALL_CATEGORIES, enabledCategories, termsVersion: TERMS_VERSION, payoutHoldHours: PAYOUT_HOLD_MS / 3600000 });

    case 'price-band': {
      const category = qs.category || 'Delivery & Pickup';
      const band = computeBand(priceConfig, category, {
        km: qs.km, stops: qs.stops, waitHours: qs.waitHours, urgent: qs.urgent
      });
      return json(200, { band });
    }

    /* ---------- accounts ---------- */
    case 'signup': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const phone = normalizePhone(body.phone);
      const pin = String(body.pin || '');
      const name = String(body.name || '').trim().slice(0, 60);
      if (!phone || !name) return json(400, { error: 'Name, phone, and a PIN are required.' });
      if (!/^\d{4,12}$/.test(pin)) return json(400, { error: 'Your PIN must be 4 to 12 digits.' });
      if (body.agree !== true) return json(400, { error: 'Please tick the box to accept the Terms and Privacy Notice.' });
      if (findUser(phone)) return json(409, { error: 'An account with that phone number already exists — log in instead.' });
      const user = {
        phone, pinHash: hashPin(phone, pin), name, title: cleanTitle(body.title), termsAcceptedAt: Date.now(), termsVersion: TERMS_VERSION,
        photo: (isInline(body.photo) && body.photo.length <= 250000) ? await storePhoto(photoStore, body.photo) : null,
        createdAt: Date.now(), errander: null, flagCount: 0
      };
      users.push(user);
      await saveUsers();
      return json(200, { user: publicUser(user), token: sessionFor(user) });
    }
    case 'login': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const phone = normalizePhone(body.phone);
      const u = findUser(phone);
      if (!u) return json(404, { error: 'No account with that phone number — sign up first.' });
      const left = await lockLeft('pin-' + phone);
      if (left) return json(429, { error: 'Too many wrong PINs. Try again in ' + left + ' minute(s).' });
      if (!checkPin(u, phone, String(body.pin || ''))) { await noteFail('pin-' + phone); return json(401, { error: 'Incorrect PIN.' }); }
      await clearFails('pin-' + phone);
      if (!String(u.pinHash).startsWith('s2$')) { u.pinHash = hashPin(phone, String(body.pin)); await saveUsers(); }   // upgrade old hashes quietly
      return json(200, { user: publicUser(u), token: sessionFor(u) });
    }
    case 'change-pin': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'not found' });
      const left = await lockLeft('pin-' + u.phone);
      if (left) return json(429, { error: 'Too many wrong PINs. Try again in ' + left + ' minute(s).' });
      if (!checkPin(u, u.phone, String(body.oldPin || ''))) { await noteFail('pin-' + u.phone); return json(401, { error: 'Your current PIN is wrong.' }); }
      const np = String(body.newPin || '');
      if (!/^\d{4,12}$/.test(np)) return json(400, { error: 'New PIN must be 4 to 12 digits.' });
      u.pinHash = hashPin(u.phone, np);
      u.epoch = (u.epoch || 0) + 1;   // signs out every other device
      u.mustChangePin = false;
      await saveUsers();
      return json(200, { ok: true, token: sessionFor(u) });
    }
    case 'accept-terms': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'not found' });
      u.termsAcceptedAt = Date.now(); u.termsVersion = TERMS_VERSION;
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }
    case 'get-user': {
      const phone = normalizePhone(qs.phone || '');
      const u = findUser(phone);
      if (!u) return json(404, { error: 'not found' });
      return json(200, { user: publicUser(u) });
    }
    case 'update-profile': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'not found' });
      if (typeof body.name === 'string' && body.name.trim()) u.name = body.name.trim().slice(0, 60);
      if (isInline(body.photo) && body.photo.length <= 250000) u.photo = await storePhoto(photoStore, body.photo);
      if (typeof body.bio === 'string') u.bio = body.bio.trim().slice(0, 140);
      if (body.title !== undefined) u.title = cleanTitle(body.title);
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }
    case 'apply-errander': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'Log in first.' });
      const idType = body.idType === 'license' ? 'license' : 'ghana_card';
      const idNumber = normalizeId(body.idNumber);
      if (!idNumber) return json(400, { error: 'ID number required.' });
      const dup = users.find(x => x.phone !== u.phone && x.errander && x.errander.idNumber === idNumber);
      if (dup) return json(409, { error: 'This ID is already registered to another account.' });
      u.errander = { idType, idNumber, status: 'pending', universityCertified: false, appliedAt: Date.now(), decidedAt: null };
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }

    /* ---------- admin (all require the X-Admin-Passcode header) ---------- */
    case 'admin-login': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const left = await lockLeft('admin-' + ip);
      if (left) return json(429, { error: 'Too many wrong attempts. Try again in ' + left + ' minute(s).' });
      if (!safeEq(String(body.passcode || ''), ADMIN_PASSCODE)) { await noteFail('admin-' + ip); return json(401, { error: 'Incorrect passcode.' }); }
      await clearFails('admin-' + ip);
      return json(200, { ok: true });
    }
    case 'admin-list-users':
      return json(200, { users: users.map(publicUser) });
    case 'admin-decide': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u || !u.errander) return json(404, { error: 'No application on file.' });
      if (!['approved', 'rejected'].includes(body.decision)) return json(400, { error: 'invalid decision' });
      u.errander.status = body.decision;
      u.errander.decidedAt = Date.now();
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }
    case 'admin-toggle-university': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u || !u.errander || u.errander.status !== 'approved') return json(404, { error: 'No approved Errander with that phone.' });
      u.errander.universityCertified = !u.errander.universityCertified;
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }
    case 'admin-list-tasks':
      return json(200, { tasks });
    case 'admin-get-price-config':
      return json(200, { config: priceConfig });
    case 'admin-set-price-config': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const next = sanitizeConfig(body.config, priceConfig);
      await store.setJSON('price-config', next);
      return json(200, { config: next });
    }
    case 'admin-reset-pin': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'No account with that phone number.' });
      const temp = String(crypto.randomInt(100000, 1000000));
      u.pinHash = hashPin(u.phone, temp);
      u.epoch = (u.epoch || 0) + 1;      // signs them out everywhere
      u.mustChangePin = true;            // they must pick their own PIN at next login
      await store.setJSON('att/pin-' + u.phone, { n: 0, until: 0 });
      await saveUsers();
      return json(200, { ok: true, tempPin: temp, name: fullName(u) });
    }
    case 'admin-set-categories': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const en = (Array.isArray(body.enabled) ? body.enabled : []).filter(c => ALL_CATEGORIES.includes(c));
      if (!en.length) return json(400, { error: 'Keep at least one category open.' });
      await store.setJSON('pilot-cats', { enabled: en });
      return json(200, { enabledCategories: en });
    }
    case 'admin-export': {
      const threads = {};
      for (const t of tasks) { const th = await store.get('thr/' + t.id, { type: 'json' }); if (th) threads[t.id] = th; }
      const support = (await store.get('support', { type: 'json' })) || [];
      const safeUsers = users.map(u => { const c = Object.assign({}, u); delete c.pinHash; return c; });
      return json(200, { exportedAt: new Date().toISOString(), version: 'v10.3', users: safeUsers, tasks, threads, support, enabledCategories });
    }
    case 'admin-verify-decide': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t || !t.verify) return json(404, { error: 'task not found' });
      if (t.verify.status !== 'pending') return json(409, { error: 'Already decided.' });
      const d = body.decision;
      if (!['verified', 'flag-errander', 'flag-boss'].includes(d)) return json(400, { error: 'invalid decision' });
      t.verify.note = String(body.note || '').slice(0, 300);
      t.verify.agent = String(body.agent || '').slice(0, 60);
      t.verify.decidedAt = Date.now();
      if (d === 'verified') {
        t.verify.status = 'verified'; t.status = 'completed'; t.stage = 'completed'; completePayout(t);
      } else {
        t.verify.status = 'problem'; t.status = 'flagged';
        const who = findUser(d === 'flag-errander' ? t.erranderPhone : t.clientPhone);
        if (who) { who.flagCount = (who.flagCount || 0) + 1; await saveUsers(); }
      }
      await saveTasks();
      return json(200, { task: t });
    }
    case 'admin-review-sponsored': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t || !t.sponsored) return json(404, { error: 'task not found' });
      if (t.reviewStatus !== 'pending') return json(409, { error: 'This task is not awaiting review.' });
      if (!['approved', 'rejected'].includes(body.decision)) return json(400, { error: 'invalid decision' });
      if (body.decision === 'approved') {
        t.reviewStatus = 'approved';
        t.status = 'completed';
        completePayout(t);
        t.stage = 'completed';
      } else {
        t.reviewStatus = 'rejected';
        t.status = 'flagged';
        const boss = findUser(t.clientPhone);
        const errander = findUser(t.erranderPhone);
        if (boss) boss.flagCount = (boss.flagCount || 0) + 1;
        if (errander) errander.flagCount = (errander.flagCount || 0) + 1;
        await saveUsers();
      }
      await saveTasks();
      return json(200, { task: t });
    }

    /* ---------- tasks ---------- */
    case 'list': {
      const viewer = normalizePhone(qs.phone || '');
      const visible = tasks.filter(t => t.status !== 'cancelled');
      const idx = (await store.get('thr-index', { type: 'json' })) || {};
      const asked = new Set(String(qs.ask || '').split(',').filter(Boolean).slice(0, 50));
      const out = await Promise.all(visible.map(async t => {
        const c = Object.assign({}, redactTask(t, viewer));
        c.messages = []; c.threads = [];
        if (!viewer) return c;
        const chatters = idx[t.id] || [];
        const isClient = viewer === t.clientPhone, isMatched = viewer === t.erranderPhone;
        // A Boss always has their own open/accepted tasks checked directly (no reliance on the index);
        // an Errander is checked where the index lists them or where their app says they have written.
        const need = (isClient && (t.status === 'open' || t.status === 'accepted')) || isMatched || chatters.includes(viewer) || asked.has(t.id);
        if (!need) return c;
        const thr = await loadThreads(store, t);
        if (isClient) {
          c.threads = Object.keys(thr.threads).map(ph => ({
            erranderPhone: ph, erranderName: thr.threads[ph].name, erranderPhoto: thr.threads[ph].photo || null,
            messages: thr.threads[ph].messages || []
          }));
          c.messages = t.erranderPhone && thr.threads[t.erranderPhone] ? (thr.threads[t.erranderPhone].messages || []) : [];
        } else if (thr.threads[viewer]) {
          c.messages = thr.threads[viewer].messages || [];
        }
        c.threads = c.threads.filter(th => (th.messages || []).length > 0);
        return c;
      }));
      return json(200, { tasks: out });
    }

    case 'create': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const boss = findUser(body.clientPhone);
      if (!boss) return json(401, { error: 'Log in first.' });
      const sponsored = !!body.sponsored;
      if (sponsored && sponsoredUsedCount() >= SPONSORED_CAP) {
        return json(409, { error: `All ${SPONSORED_CAP} KNUST-sponsored slots have been used for this pilot.` });
      }
      const category = body.category || 'Delivery & Pickup';
      if (!enabledCategories.includes(category)) return json(400, { error: 'That kind of task is not open in the pilot yet. Please choose one of the available categories.' });
      const metrics = cleanMetrics(body.metrics);
      const band = computeBand(priceConfig, category, metrics);
      const budget = Number(body.budget) || 0;
      if (budget <= 0) return json(400, { error: 'Enter your offer amount.' });
      if (sponsored && budget > band.high) {
        return json(400, { error: `Sponsored jobs are capped at GHS ${band.high} (the top of the typical range for this job). Lower your offer, or untick the sponsored option.` });
      }
      let itemsLimit = null;
      if (body.itemsLimit !== undefined && body.itemsLimit !== null && body.itemsLimit !== '') {
        const n = Number(body.itemsLimit);
        if (n > 0 && isFinite(n)) itemsLimit = Math.round(n * 100) / 100;
        else return json(400, { error: 'Enter the most you are willing to reimburse for items, or untick the purchase option.' });
      }
      let photo = null;
      if (typeof body.photo === 'string' && body.photo) {
        if (!isInline(body.photo)) return json(400, { error: 'That file is not a photo.' });
        if (body.photo.length > 250000) return json(413, { error: 'That photo is too large — please pick a smaller one.' });
        photo = await storePhoto(photoStore, body.photo);
      }
      const task = Object.assign(blankTaskFields(), {
        photo,
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        category,
        desc: String(body.desc || '').slice(0, 300),
        loc: String(body.loc || '').slice(0, 120),
        lat: typeof body.lat === 'number' ? body.lat : null,
        lng: typeof body.lng === 'number' ? body.lng : null,
        urgency: String(body.urgency || '').slice(0, 60),
        budget,
        clientName: fullName(boss), clientPhone: boss.phone, clientPhoto: boss.photo || null,
        sponsored, metrics, band, itemsLimit,
        createdAt: Date.now()
      });
      tasks.unshift(task);
      await saveTasks();
      return json(200, { task });
    }

    case 'cancel': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (normalizePhone(body.phone) !== t.clientPhone) return json(403, { error: 'Only the Boss who posted this task can cancel it.' });
      if (t.status !== 'open') return json(409, { error: 'only open tasks can be cancelled' });
      t.status = 'cancelled';
      await saveTasks();
      return json(200, { ok: true });
    }

    case 'accept': {
      // The agreed price is always taken from the negotiation record on the
      // server — whatever price the caller sends is ignored.
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const by = body.by === 'boss' ? 'boss' : 'errander';
      const errander = findUser(body.erranderPhone);
      if (!isApprovedErrander(errander)) return json(403, { error: 'That account is not an approved Errander.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
      if (errander.phone === t.clientPhone) return json(409, { error: "You can't accept your own task." });
      if (isBusy(errander.phone)) {
        return json(409, { error: by === 'boss' ? 'That Errander just took another job — pick a different offer.' : 'Finish your active task before accepting another.' });
      }
      // The latest offer in this Errander's conversation with the Boss is the price on the table.
      const thr = await loadThreads(store, t);
      const th = thr.threads[errander.phone];
      const offers = th ? th.messages.filter(m => m.type === 'offer') : [];
      const last = offers[offers.length - 1];
      let agreed;
      if (by === 'boss') {
        if (normalizePhone(body.bossPhone) !== t.clientPhone) return json(403, { error: 'Only the Boss who posted this task can accept an offer.' });
        if (!last || last.by === t.clientPhone) return json(409, { error: 'There is no pending offer from that Errander to accept.' });
        agreed = last.amount;
      } else if (last) {
        if (last.by !== t.clientPhone) return json(409, { error: 'You are waiting for the Boss to respond to your offer.' });
        agreed = last.amount;
      } else {
        agreed = t.budget;
      }
      // The screen shows the price the person is agreeing to; if it changed in the meantime, stop and show the new one.
      if (body.expectAmount !== undefined && body.expectAmount !== null && body.expectAmount !== '' && Number(body.expectAmount) !== Number(agreed)) {
        return json(409, { error: `The price just changed to GHS ${agreed} — please check it and try again.` });
      }
      if (t.sponsored && t.band && agreed > t.band.high) return json(409, { error: capMessage(t) });
      if (t.sponsored) {
        const pairDone = tasks.some(x => x.sponsored && x.id !== t.id && x.clientPhone === t.clientPhone &&
          x.erranderPhone === errander.phone && x.status !== 'cancelled' && x.reviewStatus !== 'rejected');
        if (pairDone) return json(409, { error: 'This Boss and Errander have already done a sponsored task together in this pilot.' });
      }
      t.status = 'accepted';
      t.stage = 'accepted';
      t.erranderName = fullName(errander);
      t.erranderPhone = errander.phone;
      t.erranderPhoto = errander.photo || null;
      t.budget = agreed;
      t.priceFlag = bandFlag(agreed, t.band);
      await saveTasks();
      if (th) {
        th.messages.push({ type: 'system', sender: 'Errander', by: '', text: '✅ Agreed at GHS ' + agreed, ts: Date.now(), cid: 'agreed-' + t.id });
        try { await store.setJSON('thr/' + t.id, thr); } catch (e) { /* the job is already accepted; the note is optional */ }
      }
      return json(200, { task: t });
    }

    case 'raise-item-limit': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (normalizePhone(body.bossPhone) !== t.clientPhone) return json(403, { error: 'Only the Boss can change the item limit.' });
      if (t.itemsLimit == null) return json(409, { error: 'This task does not involve buying items.' });
      if (t.status !== 'accepted' || t.stage !== 'accepted') return json(409, { error: 'The limit can only be raised before the purchase is confirmed.' });
      const n = Math.round(Number(body.newLimit) * 100) / 100;
      if (!n || n <= t.itemsLimit) return json(400, { error: `Enter an amount higher than the current limit (GHS ${t.itemsLimit}).` });
      t.itemsLimit = n;
      await saveTasks();
      return json(200, { task: t });
    }

    case 'advance': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (normalizePhone(body.phone) !== t.erranderPhone) return json(403, { error: 'Only the matched Errander can update this task.' });
      if (t.status !== 'accepted') return json(409, { error: 'task not in progress' });
      const order = ['accepted', 'picked_up', 'delivered'];
      const idx = order.indexOf(t.stage);
      if (idx >= order.length - 1) return json(409, { error: 'already delivered' });
      if (typeof body.photo === 'string' && body.photo.length > 250000) return json(413, { error: 'That photo is too large — please retake it.' });
      if (typeof body.photo === 'string' && body.photo && !isInline(body.photo)) return json(400, { error: 'That file is not a photo.' });
      const photo = isInline(body.photo) ? await storePhoto(photoStore, body.photo) : null;

      if (t.stage === 'accepted' && t.itemsLimit != null) {
        // Purchase errand: receipt total + receipt photo are required to confirm the purchase.
        const amt = Math.round(Number(body.receiptAmount) * 100) / 100;
        if (!amt || amt <= 0) return json(400, { error: 'Enter the total on your receipt.' });
        if (!photo) return json(400, { error: 'A photo of the receipt is required.' });
        if (amt > t.itemsLimit) {
          return json(409, { error: `The receipt (GHS ${amt}) is over the Boss's item limit (GHS ${t.itemsLimit}). Ask the Boss in chat to raise the limit first.` });
        }
        t.receiptAmount = amt;
        t.receiptPhoto = photo;
        if (t.sponsored) t.pickupPhoto = photo; // proof of purchase doubles as proof of pickup
      } else if (t.sponsored) {
        if (!photo) return json(400, { error: 'A photo is required at each step for sponsored tasks.' });
        if (t.stage === 'accepted') t.pickupPhoto = photo;
        if (t.stage === 'picked_up') t.deliveryPhoto = photo;
      }
      t.stage = order[idx + 1];
      await saveTasks();
      return json(200, { task: t });
    }

    case 'confirm': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (normalizePhone(body.phone) !== t.clientPhone) return json(403, { error: 'Only the Boss can confirm completion.' });
      if (t.stage !== 'delivered' || t.bossConfirmedAt) return json(409, { error: 'not ready to confirm' });
      t.bossConfirmedAt = Date.now();
      if (t.sponsored) {
        t.reviewStatus = 'pending';
      } else {
        const need = verifyNeeds(t, tasks, findUser(t.clientPhone), findUser(t.erranderPhone));
        if (need) { t.verify = need; }   // stays "delivered" until our team has checked it
        else { t.status = 'completed'; t.stage = 'completed'; completePayout(t); }
      }
      await saveTasks();
      return json(200, { task: t });
    }

    case 'rate': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'completed') return json(409, { error: 'task not completed yet' });
      const who = normalizePhone(body.phone);
      const star = (v) => Math.min(5, Math.max(1, Math.round(Number(v)) || 0));
      if (body.ratingForErrander && who === t.clientPhone) t.ratingForErrander = star(body.ratingForErrander);
      else if (body.ratingForClient && who === t.erranderPhone) t.ratingForClient = star(body.ratingForClient);
      else return json(403, { error: 'You can only rate the other person on your own task.' });
      await saveTasks();
      return json(200, { task: t });
    }

    case 'message': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      const me = normalizePhone(body.phone);
      const meUser = findUser(me);
      if (!meUser) return json(401, { error: 'Log in first.' });
      const idx = (await store.get('thr-index', { type: 'json' })) || {};
      const chatters = idx[t.id] || [];
      let erranderPhone;
      if (me === t.clientPhone) {
        erranderPhone = normalizePhone(body.to) || t.erranderPhone;
        if (!erranderPhone) return json(400, { error: 'Choose which Errander you are replying to.' });
      } else {
        if (!isApprovedErrander(meUser)) return json(403, { error: 'Only approved Erranders can message about a job.' });
        erranderPhone = me;
      }
      if (t.status === 'cancelled') return json(409, { error: 'This task was cancelled.' });
      if (t.status !== 'open' && erranderPhone !== t.erranderPhone) return json(403, { error: 'This job is no longer open.' });
      // An offer is a message that carries a price. It follows the same rules as before:
      // the job must still be open, sponsored jobs stay under the cap, a busy Errander can't offer.
      let offerAmt = null;
      if (body.offer !== undefined && body.offer !== null && body.offer !== '') {
        offerAmt = Math.round(Number(body.offer) * 100) / 100;
        if (!(offerAmt > 0 && offerAmt <= 100000)) return json(400, { error: 'Enter a valid amount.' });
        if (t.status !== 'open') return json(409, { error: 'This job is no longer open.' });
        if (t.sponsored && t.band && offerAmt > t.band.high) return json(409, { error: capMessage(t) });
        if (me !== t.clientPhone && isBusy(me)) return json(409, { error: 'Finish your active task before offering on another.' });
      }
      const text = offerAmt ? ('Offer: GHS ' + offerAmt) : String(body.text || '').trim().slice(0, 500);
      if (!text) return json(400, { error: 'empty message' });
      const cid = String(body.cid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || ('s' + Date.now() + Math.floor(Math.random() * 1e6));
      const thr = await loadThreads(store, t);
      if (me === t.clientPhone && !thr.threads[erranderPhone]) return json(409, { error: 'That Errander has not written to you yet.' });
      const errUser = findUser(erranderPhone);
      const th = thr.threads[erranderPhone] || (thr.threads[erranderPhone] = { name: errUser ? fullName(errUser) : 'Errander', photo: errUser ? (errUser.photo || null) : null, messages: [] });
      // A repeated send of the same message (the app retries until it sees it) is stored once.
      if (!th.messages.some(m => m.cid === cid)) {
        th.messages.push(Object.assign({ sender: me === t.clientPhone ? t.clientName : th.name, by: me, text, ts: Date.now(), cid },
          offerAmt ? { type: 'offer', amount: offerAmt } : {}));
        if (th.messages.length > 200) th.messages = th.messages.slice(-200);
        await store.setJSON('thr/' + t.id, thr);
      }
      // Make sure this Errander is listed for this task (re-checked on every send, so a lost write heals itself).
      if (!chatters.includes(erranderPhone)) {
        idx[t.id] = chatters.concat(erranderPhone);
        await store.setJSON('thr-index', idx);
      }
      return json(200, { ok: true, cid });
    }

    case 'set-payout-mode': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!isApprovedErrander(u)) return json(403, { error: 'Only approved Erranders choose a payout option.' });
      if (!['instant', 'weekly'].includes(body.mode)) return json(400, { error: 'invalid mode' });
      u.errander.payoutMode = body.mode;
      await saveUsers();
      return json(200, { user: publicUser(u) });
    }
    case 'admin-release-payouts': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const now = Date.now();
      let count = 0, total = 0;
      tasks.forEach(t => {
        if (t.payout && t.payout.status === 'held' && t.status === 'completed' && now - t.payout.completedAt >= PAYOUT_HOLD_MS) {
          t.payout.status = 'paid'; t.payout.paidAt = now; count++; total += Number(t.budget) || 0;
        }
      });
      if (count) await saveTasks();
      return json(200, { count, total });
    }

    /* ---------- support: help chat + "report a problem" tickets ---------- */
    case 'support-list': {
      const me = normalizePhone(qs.phone || '');
      if (!findUser(me)) return json(401, { error: 'Log in first.' });
      const all = (await store.get('support', { type: 'json' })) || [];
      return json(200, { tickets: all.filter(x => x.phone === me) });
    }
    case 'support-send': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const me = normalizePhone(body.phone);
      const u = findUser(me);
      if (!u) return json(401, { error: 'Log in first.' });
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) return json(400, { error: 'empty message' });
      const cid = String(body.cid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || ('s' + Date.now() + Math.floor(Math.random() * 1e6));
      const kind = body.kind === 'report' ? 'report' : 'chat';
      const all = (await store.get('support', { type: 'json' })) || [];
      let tk;
      if (kind === 'report') {
        const t = tasks.find(x => x.id === body.taskId);
        if (!t) return json(404, { error: 'task not found' });
        if (me !== t.clientPhone && me !== t.erranderPhone) return json(403, { error: 'You can only report a problem on your own job.' });
        tk = all.find(x => x.kind === 'report' && x.phone === me && x.taskId === t.id && x.status === 'open');
        if (!tk) {
          tk = {
            id: 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), kind, phone: me, name: fullName(u),
            role: me === t.clientPhone ? 'Boss' : 'Errander', taskId: t.id,
            subject: 'Problem with: ' + String(t.desc).slice(0, 60),
            context: { desc: t.desc, category: t.category, status: t.status, stage: t.stage, budget: t.budget, sponsored: !!t.sponsored,
              boss: t.clientName, bossPhone: t.clientPhone, errander: t.erranderName || null, erranderPhone: t.erranderPhone || null,
              pickupPhoto: t.pickupPhoto || null, deliveryPhoto: t.deliveryPhoto || null, receiptPhoto: t.receiptPhoto || null },
            status: 'open', human: true, createdAt: Date.now(), updatedAt: Date.now(), messages: []
          };
          all.push(tk);
        }
      } else {
        tk = all.find(x => x.kind === 'chat' && x.phone === me);
        if (!tk) {
          tk = { id: 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), kind, phone: me, name: fullName(u),
            role: 'User', subject: 'Help chat', status: 'open', human: false, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
          all.push(tk);
        }
        if (tk.status === 'resolved') tk.status = 'open';
        if (body.human) tk.human = true;
      }
      if (!tk.messages.some(m => m.cid === cid)) {
        tk.messages.push({ from: 'user', sender: fullName(u), text, ts: Date.now(), cid });
        if (tk.messages.length > 300) tk.messages = tk.messages.slice(-300);
        tk.updatedAt = Date.now();
        tk.awaiting = 'admin';
        await store.setJSON('support', all);
      }
      return json(200, { ok: true, ticket: tk });
    }
    case 'admin-support-list': {
      const all = (await store.get('support', { type: 'json' })) || [];
      return json(200, { tickets: all.sort((a, b) => b.updatedAt - a.updatedAt) });
    }
    case 'admin-support-reply': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const all = (await store.get('support', { type: 'json' })) || [];
      const tk = all.find(x => x.id === body.id);
      if (!tk) return json(404, { error: 'ticket not found' });
      const text = String(body.text || '').trim().slice(0, 1000);
      const cid = String(body.cid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || ('a' + Date.now());
      if (text && !tk.messages.some(m => m.cid === cid)) {
        tk.messages.push({ from: 'admin', sender: 'Errander Support', text, ts: Date.now(), cid });
        tk.awaiting = 'user';
      }
      if (body.resolved === true) { tk.status = 'resolved'; tk.awaiting = null; }
      if (body.resolved === false) tk.status = 'open';
      tk.updatedAt = Date.now();
      await store.setJSON('support', all);
      return json(200, { ok: true, ticket: tk });
    }

    case 'admin-reset': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const fresh = seedTasks();
      await store.setJSON('all-tasks', fresh);
      return json(200, { tasks: fresh });
    }

    default:
      return json(400, { error: 'unknown action' });
  }
}

// Netlify Functions (v2) entry point. Any unexpected error comes back as JSON
// so the app can show it instead of silently doing nothing.
export default async (req) => {
  try {
    const url = new URL(req.url);
    const headers = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const body = (req.method === 'GET' || req.method === 'HEAD') ? null : await req.text();
    const r = await core({
      httpMethod: req.method,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers, body
    });
    const payload = r.isBase64Encoded ? Buffer.from(r.body, 'base64') : r.body;
    return new Response(payload, { status: r.statusCode, headers: r.headers || {} });
  } catch (e) {
    console.error('api error', e);
    return new Response(JSON.stringify({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
