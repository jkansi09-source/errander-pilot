// Errander pilot API — v3
// Adds: one-active-task-at-a-time enforcement for Erranders, and a simple
// per-task chat thread once a task is matched.

const { connectLambda, getStore } = require('@netlify/blobs');

function seedTasks() {
  const now = Date.now();
  return [
    {
      id: 'seed-1',
      category: 'Delivery & Pickup',
      desc: "Pick up a document from the Registrar's office and deliver to my office",
      loc: 'Adum, Kumasi', lat: 6.6926, lng: -1.6291,
      urgency: 'Today',
      budget: 40,
      quoteRequest: false,
      clientName: 'Sam O.', clientPhone: '024 000 0001',
      status: 'open', stage: null,
      quotes: [], messages: [],
      erranderName: null, erranderPhone: null,
      ratingForErrander: null, ratingForClient: null,
      createdAt: now
    },
    {
      id: 'seed-2',
      category: 'Home Services · Plumbing',
      desc: 'Fix a leaking kitchen tap',
      loc: 'Ahodwo, Kumasi', lat: 6.6581, lng: -1.6178,
      urgency: 'Tomorrow, 10:00 AM',
      budget: null,
      quoteRequest: true,
      clientName: 'Kojo B.', clientPhone: '024 000 0002',
      status: 'open', stage: null,
      quotes: [], messages: [],
      erranderName: null, erranderPhone: null,
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
  if (!tasks) {
    tasks = seedTasks();
    await store.setJSON('all-tasks', tasks);
  }
  // backfill messages array for tasks created before this version
  tasks.forEach(t => { if (!t.messages) t.messages = []; });

  const save = () => store.setJSON('all-tasks', tasks);
  const isBusy = (erranderName) => tasks.some(x => x.erranderName === erranderName && x.status === 'accepted');

  switch (action) {
    case 'list':
      return json(200, { tasks: tasks.filter(t => t.status !== 'cancelled') });

    case 'create': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
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
        clientName: String(body.clientName || 'Client').slice(0, 60),
        clientPhone: String(body.clientPhone || '').slice(0, 30),
        status: 'open', stage: null,
        quotes: [], messages: [],
        erranderName: null, erranderPhone: null,
        ratingForErrander: null, ratingForClient: null,
        createdAt: Date.now()
      };
      tasks.unshift(task);
      await save();
      return json(200, { task });
    }

    case 'cancel': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'only open tasks can be cancelled' });
      t.status = 'cancelled';
      await save();
      return json(200, { ok: true });
    }

    case 'quote': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const erranderName = String(body.erranderName || 'Errander').slice(0, 60);
      if (isBusy(erranderName)) return json(409, { error: 'Finish your active task before quoting on another.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      t.quotes.push({
        erranderName,
        erranderPhone: String(body.erranderPhone || '').slice(0, 30),
        price: Number(body.price) || 0,
        note: String(body.note || '').slice(0, 200)
      });
      await save();
      return json(200, { task: t });
    }

    case 'accept': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const erranderName = String(body.erranderName || 'Errander').slice(0, 60);
      if (isBusy(erranderName)) return json(409, { error: 'Finish your active task before accepting another.' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
      t.status = 'accepted';
      t.stage = 'accepted';
      t.erranderName = erranderName;
      t.erranderPhone = String(body.erranderPhone || '').slice(0, 30);
      if (body.acceptedPrice) t.budget = Number(body.acceptedPrice);
      await save();
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
      await save();
      return json(200, { task: t });
    }

    case 'confirm': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.stage !== 'delivered') return json(409, { error: 'not yet delivered' });
      t.status = 'completed';
      t.stage = 'completed';
      await save();
      return json(200, { task: t }); // Errander is now free to accept a new task
    }

    case 'rate': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'completed') return json(409, { error: 'task not completed yet' });
      if (body.ratingForErrander) t.ratingForErrander = Number(body.ratingForErrander);
      if (body.ratingForClient) t.ratingForClient = Number(body.ratingForClient);
      await save();
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
      await save();
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
