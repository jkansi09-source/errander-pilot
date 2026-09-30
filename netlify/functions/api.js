// Errander pilot API — v5
// Adds real accounts (phone + PIN), one profile per person that can act as
// Boss and/or (once approved) Errander, an admin approval workflow, and
// server-side enforcement of "must be an approved Errander to accept/quote."

const { connectLambda, getStore } = require('@netlify/blobs');
const crypto = require('crypto');

// Change this before any real pilot use — see README.
const ADMIN_PASSCODE = 'errander-admin-2026';

function hashPin(phone, pin) {
  return crypto.createHash('sha256').update(phone + ':' + pin + ':errander-pilot-salt').digest('hex');
}
function publicUser(u) {
  return { phone: u.phone, name: u.name, photo: u.photo || null, createdAt: u.createdAt, errander: u.errander || null };
}
function normalizePhone(v) { return String(v || '').replace(/\s+/g, ''); }
function normalizeId(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function seedTasks() {
  const now = Date.now();
  return [
    {
      id: 'seed-1',
      category: 'Delivery & Pickup',
      desc: "Pick up a document from the Registrar's office and deliver to my office",
      loc: 'Adum, Kumasi', lat: 6.6926, lng: -1.6291,
      urgency: 'Today', budget: 40, quoteRequest: false,
      clientName: 'Sam O.', clientPhone: '0240000001', clientPhoto: null,
      status: 'open', stage: null, quotes: [], messages: [],
      erranderName: null, erranderPhone: null, erranderPhoto: null,
      ratingForErrander: null, ratingForClient: null,
      createdAt: now
    },
    {
      id: 'seed-2',
      category: 'Home Services · Plumbing',
      desc: 'Fix a leaking kitchen tap',
      loc: 'Ahodwo, Kumasi', lat: 6.6581, lng: -1.6178,
      urgency: 'Tomorrow, 10:00 AM', budget: null, quoteRequest: true,
      clientName: 'Kojo B.', clientPhone: '0240000002', clientPhoto: null,
      status: 'open', stage: null, quotes: [], messages: [],
      erranderName: null, erranderPhone: null, erranderPhoto: null,
      ratingForErrander: null, ratingForClient: null,
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
    if (t.clientPhoto === undefined) t.clientPhoto = null;
    if (t.erranderPhoto === undefined) t.erranderPhoto = null;
  });

  let users = await store.get('users', { type: 'json' });
  if (!users) { users = []; await store.setJSON('users', users); }

  const saveTasks = () => store.setJSON('all-tasks', tasks);
  const saveUsers = () => store.setJSON('users', users);
  const findUser = (phone) => users.find(u => u.phone === normalizePhone(phone));
  const isBusy = (erranderPhone) => tasks.some(x => x.erranderPhone === erranderPhone && x.status === 'accepted');

  switch (action) {

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
        createdAt: Date.now(), errander: null
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
      u.errander = { idType, idNumber, status: 'pending', appliedAt: Date.now(), decidedAt: null };
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
    case 'admin-list-tasks':
      return json(200, { tasks }); // includes cancelled, for oversight

    /* ---------- tasks ---------- */
    case 'list':
      return json(200, { tasks: tasks.filter(t => t.status !== 'cancelled') });

    case 'create': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const boss = findUser(body.clientPhone);
      if (!boss) return json(401, { error: 'Log in first.' });
      const task = {
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        category: body.category || 'Delivery & Pickup',
        desc: String(body.desc || '').slice(0, 300),
        loc: String(body.loc || '').slice(0, 120),
        lat: typeof body.lat === 'number' ? body.lat : null,
        lng: typeof body.lng === 'number' ? body.lng : null,
        urgency: String(body.urgency || '').slice(0, 60),
        budget: body.quoteRequest ? null : (Number(body.budget) || 0),
        quoteRequest: !!body.quoteRequest,
        clientName: boss.name, clientPhone: boss.phone, clientPhoto: boss.photo || null,
        status: 'open', stage: null, quotes: [], messages: [],
        erranderName: null, erranderPhone: null, erranderPhoto: null,
        ratingForErrander: null, ratingForClient: null,
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

    case 'quote': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const errander = findUser(body.erranderPhone);
      if (!errander || !errander.errander || errander.errander.status !== 'approved') return json(403, { error: 'You must be an approved Errander to quote.' });
      if (isBusy(errander.phone)) return json(409, { error: 'Finish your active task before quoting on another.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      t.quotes.push({
        erranderName: errander.name, erranderPhone: errander.phone, erranderPhoto: errander.photo || null,
        price: Number(body.price) || 0, note: String(body.note || '').slice(0, 200)
      });
      await saveTasks();
      return json(200, { task: t });
    }

    case 'accept': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const errander = findUser(body.erranderPhone);
      if (!errander || !errander.errander || errander.errander.status !== 'approved') return json(403, { error: 'You must be an approved Errander to accept tasks.' });
      if (isBusy(errander.phone)) return json(409, { error: 'Finish your active task before accepting another.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
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
      if (idx < order.length - 1) t.stage = order[idx + 1];
      await saveTasks();
      return json(200, { task: t });
    }

    case 'confirm': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.stage !== 'delivered') return json(409, { error: 'not yet delivered' });
      t.status = 'completed';
      t.stage = 'completed';
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
