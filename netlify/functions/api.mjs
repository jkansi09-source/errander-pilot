// Errander pilot API — v8
// Adds: admin-editable price bands (typical range per job), a sponsored-job
// price cap enforced on the server, receipt-based reimbursement for purchase
// errands, an agreed price the client can no longer tamper with, admin
// endpoints that actually require the admin passcode, contact/photo
// redaction for people who aren't party to a task, and a self-accept block.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Change these before any real pilot use — see README.
const ADMIN_PASSCODE = 'errander-admin-2026';
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

function hashPin(phone, pin) {
  return crypto.createHash('sha256').update(phone + ':' + pin + ':errander-pilot-salt').digest('hex');
}
function publicUser(u) {
  return { phone: u.phone, name: u.name, photo: u.photo || null, bio: u.bio || null, createdAt: u.createdAt, errander: u.errander || null, flagCount: u.flagCount || 0 };
}
function normalizePhone(v) { return String(v || '').replace(/\s+/g, ''); }
function normalizeId(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// What a viewer is allowed to see of a task. Phone numbers, chat and proof
// photos are only for the Boss and the matched Errander; everyone else gets
// the public face of the task plus their own offer (if any).
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
    itemsLimit: null, receiptAmount: null, receiptPhoto: null
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
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Passcode'
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
      ok: true, version: 'v8.7', time: Date.now(),
      readMode: blobsMode,
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

  // Every admin-* action (except logging in) now needs the passcode on the request.
  if (action.startsWith('admin-') && action !== 'admin-login') {
    const h = event.headers || {};
    const given = h['x-admin-passcode'] || h['X-Admin-Passcode'] || '';
    if (given !== ADMIN_PASSCODE) return json(401, { error: 'Admin passcode required.' });
  }

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }

  let priceConfig = await store.get('price-config', { type: 'json' });
  if (!priceConfig) priceConfig = DEFAULT_PRICE_CONFIG;
  priceConfig = Object.assign({}, DEFAULT_PRICE_CONFIG, priceConfig, {
    categories: Object.assign({}, DEFAULT_PRICE_CONFIG.categories, priceConfig.categories || {})
  });

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
  const isBusy = (erranderPhone) => tasks.some(x => x.erranderPhone === erranderPhone && x.status === 'accepted');
  const isApprovedErrander = (u) => u && u.errander && u.errander.status === 'approved';
  const sponsoredUsedCount = () => tasks.filter(t => t.sponsored && t.status !== 'cancelled' && t.reviewStatus !== 'rejected').length;
  const capMessage = (t) => `Sponsored jobs are capped at GHS ${t.band.high} (the top of the typical range for this job).`;

  switch (action) {

    case 'config':
      return json(200, { feeRate: PLATFORM_FEE_RATE, sponsoredCap: SPONSORED_CAP, sponsoredUsed: sponsoredUsedCount() });

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
      if (!phone || pin.length < 4 || !name) return json(400, { error: 'Name, phone, and a 4+ digit PIN are required.' });
      if (findUser(phone)) return json(409, { error: 'An account with that phone number already exists — log in instead.' });
      const user = {
        phone, pinHash: hashPin(phone, pin), name,
        photo: (isInline(body.photo) && body.photo.length <= 250000) ? await storePhoto(photoStore, body.photo) : null,
        createdAt: Date.now(), errander: null, flagCount: 0
      };
      users.push(user);
      await saveUsers();
      return json(200, { user: publicUser(user) });
    }
    case 'login': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const phone = normalizePhone(body.phone);
      const u = findUser(phone);
      if (!u) return json(404, { error: 'No account with that phone number — sign up first.' });
      if (u.pinHash !== hashPin(phone, String(body.pin || ''))) return json(401, { error: 'Incorrect PIN.' });
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
      if (String(body.passcode || '') !== ADMIN_PASSCODE) return json(401, { error: 'Incorrect passcode.' });
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
    case 'admin-review-sponsored': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t || !t.sponsored) return json(404, { error: 'task not found' });
      if (t.reviewStatus !== 'pending') return json(409, { error: 'This task is not awaiting review.' });
      if (!['approved', 'rejected'].includes(body.decision)) return json(400, { error: 'invalid decision' });
      if (body.decision === 'approved') {
        t.reviewStatus = 'approved';
        t.status = 'completed';
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
      // Chat lives in its own blob per task (so chat and task updates never overwrite each other).
      await Promise.all(visible.filter(t => viewer && t.erranderName && (t.clientPhone === viewer || t.erranderPhone === viewer)).map(async t => {
        const chat = await store.get('chat/' + t.id, { type: 'json' });
        if (chat && Array.isArray(chat.messages)) t.messages = chat.messages;
      }));
      return json(200, { tasks: visible.map(t => redactTask(t, viewer)) });
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
        clientName: boss.name, clientPhone: boss.phone, clientPhoto: boss.photo || null,
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

    case 'counter': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
      const amount = Number(body.amount);
      if (!amount || amount <= 0) return json(400, { error: 'enter a valid amount' });
      if (t.sponsored && t.band && amount > t.band.high) return json(409, { error: capMessage(t) });

      if (body.by === 'errander') {
        const errander = findUser(body.erranderPhone);
        if (!isApprovedErrander(errander)) return json(403, { error: 'You must be an approved Errander to make an offer.' });
        if (errander.phone === t.clientPhone) return json(409, { error: "You can't make an offer on your own task." });
        if (isBusy(errander.phone)) return json(409, { error: 'Finish your active task before offering on another.' });
        let entry = t.negotiations.find(n => n.erranderPhone === errander.phone);
        if (!entry) { entry = { erranderPhone: errander.phone, erranderName: errander.name, erranderPhoto: errander.photo || null }; t.negotiations.push(entry); }
        entry.amount = amount; entry.lastBy = 'errander'; entry.updatedAt = Date.now();
      } else if (body.by === 'boss') {
        if (normalizePhone(body.bossPhone) !== t.clientPhone) return json(403, { error: 'Only the Boss who posted this task can counter.' });
        const entry = t.negotiations.find(n => n.erranderPhone === normalizePhone(body.erranderPhone));
        if (!entry) return json(404, { error: 'No offer from that Errander yet.' });
        entry.amount = amount; entry.lastBy = 'boss'; entry.updatedAt = Date.now();
      } else {
        return json(400, { error: 'invalid by' });
      }
      await saveTasks();
      return json(200, { task: t });
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
      const entry = t.negotiations.find(n => n.erranderPhone === errander.phone);
      let agreed;
      if (by === 'boss') {
        if (normalizePhone(body.bossPhone) !== t.clientPhone) return json(403, { error: 'Only the Boss who posted this task can accept an offer.' });
        if (!entry || entry.lastBy !== 'errander') return json(409, { error: 'There is no pending offer from that Errander to accept.' });
        agreed = entry.amount;
      } else if (entry) {
        if (entry.lastBy !== 'boss') return json(409, { error: 'You are waiting for the Boss to respond to your offer.' });
        agreed = entry.amount;
      } else {
        agreed = t.budget;
      }
      if (t.sponsored && t.band && agreed > t.band.high) return json(409, { error: capMessage(t) });
      if (t.sponsored) {
        const pairDone = tasks.some(x => x.sponsored && x.id !== t.id && x.clientPhone === t.clientPhone &&
          x.erranderPhone === errander.phone && x.status !== 'cancelled' && x.reviewStatus !== 'rejected');
        if (pairDone) return json(409, { error: 'This Boss and Errander have already done a sponsored task together in this pilot.' });
      }
      t.status = 'accepted';
      t.stage = 'accepted';
      t.erranderName = errander.name;
      t.erranderPhone = errander.phone;
      t.erranderPhoto = errander.photo || null;
      t.budget = agreed;
      t.priceFlag = bandFlag(agreed, t.band);
      await saveTasks();
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
        t.status = 'completed';
        t.stage = 'completed';
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
      if (!t.erranderName) return json(409, { error: 'chat opens once a task is matched' });
      const me = normalizePhone(body.phone);
      if (me !== t.clientPhone && me !== t.erranderPhone) return json(403, { error: 'Only the Boss and the matched Errander can chat.' });
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return json(400, { error: 'empty message' });
      const cid = String(body.cid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || ('s' + Date.now() + Math.floor(Math.random() * 1e6));
      const key = 'chat/' + t.id;
      const chat = await store.get(key, { type: 'json' });
      let messages = (chat && Array.isArray(chat.messages)) ? chat.messages : (t.messages || []).slice();
      // A repeated send of the same message (the app retries until it sees it) is stored once.
      if (!messages.some(m => m.cid === cid)) {
        messages.push({ sender: me === t.clientPhone ? t.clientName : t.erranderName, by: me, text, ts: Date.now(), cid });
        if (messages.length > 200) messages = messages.slice(-200);
        await store.setJSON(key, { messages });
      }
      return json(200, { ok: true, cid });
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
