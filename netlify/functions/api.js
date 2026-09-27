// Errander pilot API
// One function, routed by ?action=..., backed by a single JSON blob.
// Good enough for a small pilot: last write wins, no per-record locking.
// If you outgrow that, move this to Netlify DB (or any real database).

const { connectLambda, getStore } = require('@netlify/blobs');

function seedTasks() {
  const now = Date.now();
  return [
    {
      id: 'seed-1',
      category: 'Delivery & Pickup',
      desc: "Pick up a document from the Registrar's office and deliver to my office",
      loc: 'Adum, Kumasi',
      urgency: 'Today',
      budget: 40,
      quoteRequest: false,
      clientName: 'Sam O.',
      status: 'open',
      quotes: [],
      erranderName: null,
      step: 0,
      createdAt: now
    },
    {
      id: 'seed-2',
      category: 'Home Services · Plumbing',
      desc: 'Fix a leaking kitchen tap',
      loc: 'Ahodwo, Kumasi',
      urgency: 'Tomorrow, 10:00 AM',
      budget: null,
      quoteRequest: true,
      clientName: 'Kojo B.',
      status: 'open',
      quotes: [],
      erranderName: null,
      step: 0,
      createdAt: now
    }
  ];
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
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
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { /* leave body empty */ }
  }

  let tasks = await store.get('all-tasks', { type: 'json' });
  if (!tasks) {
    tasks = seedTasks();
    await store.setJSON('all-tasks', tasks);
  }

  switch (action) {
    case 'list':
      return json(200, { tasks });

    case 'create': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const task = {
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        category: body.category || 'Delivery & Pickup',
        desc: String(body.desc || '').slice(0, 300),
        loc: String(body.loc || '').slice(0, 120),
        urgency: String(body.urgency || '').slice(0, 60),
        budget: body.quoteRequest ? null : (Number(body.budget) || 0),
        quoteRequest: !!body.quoteRequest,
        clientName: String(body.clientName || 'Client').slice(0, 60),
        status: 'open',
        quotes: [],
        erranderName: null,
        step: 0,
        createdAt: Date.now()
      };
      tasks.unshift(task);
      await store.setJSON('all-tasks', tasks);
      return json(200, { task });
    }

    case 'quote': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      t.quotes.push({
        erranderName: String(body.erranderName || 'Errander').slice(0, 60),
        price: Number(body.price) || 0,
        note: String(body.note || '').slice(0, 200)
      });
      await store.setJSON('all-tasks', tasks);
      return json(200, { task: t });
    }

    case 'accept': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      if (t.status !== 'open') return json(409, { error: 'task is no longer open' });
      t.status = 'accepted';
      t.erranderName = String(body.erranderName || 'Errander').slice(0, 60);
      if (body.acceptedPrice) t.budget = Number(body.acceptedPrice);
      t.step = 0;
      await store.setJSON('all-tasks', tasks);
      return json(200, { task: t });
    }

    case 'advance': {
      if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
      const t = tasks.find(x => x.id === body.id);
      if (!t) return json(404, { error: 'task not found' });
      t.step = (t.step || 0) + 1;
      if (t.step >= 3) t.status = 'completed';
      await store.setJSON('all-tasks', tasks);
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
