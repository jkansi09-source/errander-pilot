// Errander pilot API — v7
// Adds: KNUST-sponsored tasks (company pays instead of Boss), a cap on how
// many sponsored slots exist, a one-sponsored-job-per-Boss/Errander-pair
// limit, required pickup/delivery photo proof on sponsored jobs, and an
// admin review queue that must approve a sponsored job before it pays out.

const { connectLambda, getStore } = require('@netlify/blobs');
const crypto = require('crypto');

// Change these before any real pilot use — see README.
const ADMIN_PASSCODE = 'errander-admin-2026';
const PLATFORM_FEE_RATE = 0.10;   // 10% added on top, paid by the Boss (non-sponsored tasks only)
const SPONSORED_CAP = 100;        // total KNUST-sponsored slots for this pilot

function hashPin(phone, pin) {
  return crypto.createHash('sha256').update(phone + ':' + pin + ':errander-pilot-salt').digest('hex');
}
function publicUser(u) {
  return { phone: u.phone, name: u.name, photo: u.photo || null, bio: u.bio || null, createdAt: u.createdAt, errander: u.errander || null, flagCount: u.flagCount || 0 };
}
function normalizePhone(v) { return String(v || '').replace(/\s+/g, ''); }
function normalizeId(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function seedTasks() {
  const now = Date.now();
  return [
    {
      id: 'seed-1', category: 'Delivery & Pickup',
      desc: "Pick up a document from the Registrar's office and deliver to my office",
      loc: 'Adum, Kumasi', lat: 6.6926, lng: -1.6291,
      urgency: 'Today', budget: 40,
      clientName: 'Sam O.', clientPhone: '0240000001', clientPhoto: null,
      status: 'open', stage: null, negotiations: [], messages: [],
      erranderName: null, erranderPhone: null, erranderPhoto: null,
      ratingForErrander: null, ratingForClient: null,
      sponsored: false, pickupPhoto: null, deliveryPhoto: null, reviewStatus: null, bossConfirmedAt: null,
      createdAt: now
    },
    {
      id: 'seed-2', category: 'Home Services · Plumbing',
      desc: 'Fix a leaking kitchen tap',
      loc: 'Ahodwo, Kumasi', lat: 6.6581, lng: -1.6178,
      urgency: 'Tomorrow, 10:00 AM', budget: 60,
      clientName: 'Kojo B.', clientPhone: '0240000002', clientPhoto: null,
      status: 'open', stage: null, negotiations: [], messages: [],
      erranderName: null, erranderPhone: null, erranderPhoto: null,
      ratingForErrander: null, ratingForClient: null,
      sponsored: false, pickupPhoto: null, deliveryPhoto: null, reviewStatus: null, bossConfirmedAt: null,
      createdAt: now
    }
  ];
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  const store = getStore('errander-pilot');
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'list';

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch (e) { /* ignore */ } }

  let tasks = await store.get('all-tasks', { type: 'json' });
  if (!tasks) { tasks = seedTasks(); await store.setJSON('all-tasks', tasks); }
  tasks.forEach(t => {
    if (!t.messages) t.messages = [];
    if (!t.negotiations) t.negotiations = t.quotes ? t.quotes.map(q => ({
      erranderPhone: q.erranderPhone, erranderName: q.erranderName, erranderPhoto: q.erranderPhoto || null,
      amount: q.price, lastBy: 'errander', updatedAt: Date.now()
    })) : [];
    delete t.quotes; delete t.quoteRequest;
    if (t.clientPhoto === undefined) t.clientPhoto = null;
    if (t.erranderPhoto === undefined) t.erranderPhoto = null;
    if (t.sponsored === undefined) t.sponsored = false;
    if (t.pickupPhoto === undefined) t.pickupPhoto = null;
    if (t.deliveryPhoto === undefined) t.deliveryPhoto = null;
    if (t.reviewStatus === undefined) t.reviewStatus = null;
    if (t.bossConfirmedAt === undefined) t.bossConfirmedAt = null;
  });

  let users = await store.get('users', { type: 'json' });
  if (!users) { users = []; await store.setJSON('users', users); }
  users.forEach(u => {
    if (u.errander && u.errander.universityCertified === undefined) u.errander.universityCertified = false;
    if (u.flagCount === undefined) u.flagCount = 0;
  });

  const saveTasks = () => store.setJSON('all-tasks', tasks);
  const saveUsers = () => store.setJSON('users', users);
  const findUser = (phone) => users.find(u => u.phone === normalizePhone(phone));
  const isBusy = (erranderPhone) => tasks.some(x => x.erranderPhone === erranderPhone && x.status === 'accepted');
  const isApprovedErrander = (u) => u && u.errander && u.errander.status === 'approved';
  const sponsoredUsedCount = () => tasks.filter(t => t.sponsored && t.status !== 'cancelled' && t.reviewStatus !== 'rejected').length;

  switch (action) {

    case 'config':
      return json(200, { feeRate: PLATFORM_FEE_RATE, sponsoredCap: SPONSORED_CAP, sponsoredUsed: sponsoredUsedCount() });

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
        photo: typeof body.photo === 'string' ? body.photo.slice(0, 200000) : null,
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
      const phone = normalizePhone((event.queryStringParameters && event.queryStringParameters.phone) || '');
      const u = findUser(phone);
      if (!u) return json(404, { error: 'not found' });
      return json(200, { user: publicUser(u) });
    }
    case 'update-profile': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const u = findUser(body.phone);
      if (!u) return json(404, { error: 'not found' });
      if (typeof body.name === 'string' && body.name.trim()) u.name = body.name.trim().slice(0, 60);
      if (typeof body.photo === 'string') u.photo = body.photo.slice(0, 200000);
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

    /* ---------- admin ---------- */
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
        t.status = 'flagged'; // terminal: not paid, not open, frees the Errander up
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
    case 'list':
      return json(200, { tasks: tasks.filter(t => t.status !== 'cancelled') });

    case 'create': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const boss = findUser(body.clientPhone);
      if (!boss) return json(401, { error: 'Log in first.' });
      const sponsored = !!body.sponsored;
      if (sponsored && sponsoredUsedCount() >= SPONSORED_CAP) {
        return json(409, { error: `All ${SPONSORED_CAP} KNUST-sponsored slots have been used for this pilot.` });
      }
      const task = {
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        category: body.category || 'Delivery & Pickup',
        desc: String(body.desc || '').slice(0, 300),
        loc: String(body.loc || '').slice(0, 120),
        lat: typeof body.lat === 'number' ? body.lat : null,
        lng: typeof body.lng === 'number' ? body.lng : null,
        urgency: String(body.urgency || '').slice(0, 60),
        budget: Number(body.budget) || 0,
        clientName: boss.name, clientPhone: boss.phone, clientPhoto: boss.photo || null,
        status: 'open', stage: null, negotiations: [], messages: [],
        erranderName: null, erranderPhone: null, erranderPhoto: null,
        ratingForErrander: null, ratingForClient: null,
        sponsored, pickupPhoto: null, deliveryPhoto: null, reviewStatus: null, bossConfirmedAt: null,
        createdAt: Date.now()
      };
      tasks.unshift(task);
      await saveTasks();
      return json(200, { task });
    }

    case 'cancel': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
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

      if (body.by === 'errander') {
        const errander = findUser(body.erranderPhone);
        if (!isApprovedErrander(errander)) return json(403, { error: 'You must be an approved Errander to make an offer.' });
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
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const errander = findUser(body.erranderPhone);
      if (!isApprovedErrander(errander)) return json(403, { error: 'You must be an approved Errander to accept tasks.' });
      if (isBusy(errander.phone)) return json(409, { error: 'Finish your active task before accepting another.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
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
      if (body.acceptedPrice) t.budget = Number(body.acceptedPrice);
      await saveTasks();
      return json(200, { task: t });
    }

    case 'advance': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'accepted') return json(409, { error: 'task not in progress' });
      const order = ['accepted', 'picked_up', 'delivered'];
      const idx = order.indexOf(t.stage);
      if (idx >= order.length - 1) return json(409, { error: 'already delivered' });
      if (t.sponsored) {
        const photo = typeof body.photo === 'string' ? body.photo.slice(0, 200000) : null;
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
      if (t.stage !== 'delivered') return json(409, { error: 'not yet delivered' });
      t.bossConfirmedAt = Date.now();
      if (t.sponsored) {
        t.reviewStatus = 'pending'; // status stays 'accepted' — payout withheld until admin approves
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
      if (body.ratingForErrander) t.ratingForErrander = Number(body.ratingForErrander);
      if (body.ratingForClient) t.ratingForClient = Number(body.ratingForClient);
      await saveTasks();
      return json(200, { task: t });
    }

    case 'message': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (!t.erranderName) return json(409, { error: 'chat opens once a task is matched' });
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return json(400, { error: 'empty message' });
      t.messages.push({ sender: String(body.sender || 'User').slice(0, 60), text, ts: Date.now() });
      if (t.messages.length > 200) t.messages = t.messages.slice(-200);
      await saveTasks();
      return json(200, { task: t });
    }

    case 'reset': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const fresh = seedTasks();
      await store.setJSON('all-tasks', fresh);
      return json(200, { tasks: fresh });
    }

    default:
      return json(400, { error: 'unknown action' });
  }
};
