require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const multer = require('multer');
const upload = multer({
  dest: './public/uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  }
});
const path = require('path');

const app = express();
const PORT = process.env.PORT || 19100;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jason@ercsn.com';
const BREVO_KEY = process.env.BREVO_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS;

// DB
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'getrallied.db');
const fs_extra = require('fs');
if (!fs_extra.existsSync(path.dirname(dbPath))) fs_extra.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    organizer_token TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    vision TEXT,
    date TEXT,
    location TEXT,
    organizer_name TEXT,
    organizer_email TEXT,
    is_private INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    quantity_needed INTEGER DEFAULT 1,
    quantity_claimed INTEGER DEFAULT 0,
    requires_approval INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    note TEXT,
    status TEXT DEFAULT 'approved',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );
  CREATE TABLE IF NOT EXISTS magic_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function genId(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Add image columns if missing (safe migration)
try { db.exec('ALTER TABLE events ADD COLUMN org_logo TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN event_time TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN location_name TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN location_address TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN location_maps_url TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN banner_image TEXT DEFAULT NULL'); } catch(e) {}

// Recalculate approved claim count for a task
function recalcClaimed(taskId) {
  db.prepare(`UPDATE tasks SET quantity_claimed = (
    SELECT COUNT(*) FROM claims WHERE task_id = ? AND status = 'approved'
  ) WHERE id = ?`).run(taskId, taskId);
}
function isUnlimited(task) { return task.quantity_needed === 0; }
function isFull(task) { return !isUnlimited(task) && task.quantity_claimed >= task.quantity_needed; }

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Claude breakdown ──────────────────────────────────────────────────────────
async function breakdownVision(vision, eventTitle, eventDate, eventLocation) {
  const prompt = `You are helping an event organizer break down their vision into a concrete task registry.

Event: "${eventTitle}"
Date: ${eventDate}
Location: ${eventLocation}
Organizer's vision: "${vision}"

Return ONLY valid JSON:
{
  "tasks": [
    {
      "title": "Short task name",
      "description": "1-2 sentence description",
      "category": "people|materials|skills|logistics",
      "quantity_needed": 1,
      "requires_approval": false
    }
  ]
}

Rules:
- 6-16 tasks total. Be specific.
- Set requires_approval: true for leadership/coordination/security roles (coordinator, safety lead, stage manager, etc.)
- Set requires_approval: false for general tasks (bring drums, wear a costume, help with setup)`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await resp.json();
  const text = data.content?.[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!BREVO_KEY) return;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'GetRallied', email: 'noreply@getrallied.com' },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.render('home'));

// Create event
app.post('/create', async (req, res) => {
  const { title, vision, date, location, organizer_name, organizer_email, is_private } = req.body;
  if (!title || !vision) return res.status(400).send('Title and vision required');
  try {
    const breakdown = await breakdownVision(vision, title, date || 'TBD', location || 'TBD');
    const eventId = genId(8);
    const organizerToken = genId(16);
    const isPrivate = is_private === '1' ? 1 : 0;

    db.prepare(`INSERT INTO events (id,organizer_token,title,description,vision,date,location,organizer_name,organizer_email,is_private) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(eventId, organizerToken, title.trim(), '', vision.trim(), date || '', location || '', organizer_name || '', organizer_email || NOTIFY_EMAIL, isPrivate);

    (breakdown.tasks || []).forEach((t, i) => {
      db.prepare(`INSERT INTO tasks (id,event_id,title,description,category,quantity_needed,requires_approval,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
        .run(genId(), eventId, t.title, t.description || '', t.category || 'people', t.quantity_needed || 1, t.requires_approval ? 1 : 0, i);
    });

    const dashUrl = `${BASE_URL}/organizer/${organizerToken}`;
    const eventUrl = `${BASE_URL}/event/${eventId}`;
    await sendEmail(organizer_email || NOTIFY_EMAIL, `Your GetRallied registry is live: ${title}`,
      `<h2>Your event registry is live!</h2>
       <p>${isPrivate ? '🔒 <strong>Private event</strong> — only people with the link can see it.' : '🌐 Public event'}</p>
       <p><a href="${eventUrl}">Share this link with your people →</a></p>
       <p><a href="${dashUrl}">Your organizer dashboard →</a></p>`);

    res.redirect(`/organizer/${organizerToken}?new=1`);
  } catch (e) {
    console.error('Create error:', e);
    res.status(500).send('Error creating event: ' + e.message);
  }
});

// Public event page
app.get('/event/:id', async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).render('404');
  const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ? ORDER BY sort_order').all(event.id);
  const allClaims = db.prepare('SELECT * FROM claims WHERE event_id = ?').all(event.id);
  // Public only sees approved claims
  const claimsByTask = {};
  allClaims.filter(c => c.status === 'approved').forEach(c => {
    if (!claimsByTask[c.task_id]) claimsByTask[c.task_id] = [];
    claimsByTask[c.task_id].push(c);
  });
  // Pending count per task (so public sees "X pending review")
  const pendingByTask = {};
  allClaims.filter(c => c.status === 'pending').forEach(c => {
    pendingByTask[c.task_id] = (pendingByTask[c.task_id] || 0) + 1;
  });
  const eventUrl = `${BASE_URL}/event/${event.id}`;
  const qrDataUrl = await QRCode.toDataURL(eventUrl, { width: 200, margin: 1, color: { dark: '#111', light: '#fff' } });
  res.render('event', { event, tasks, claimsByTask, pendingByTask, qrDataUrl, eventUrl, claimed: req.query.claimed, pending: req.query.pending });
});

// Claim a task
app.post('/claim/:taskId', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).send('Task not found');
  const { name, email, phone, note } = req.body;
  if (!name) return res.redirect(`/event/${task.event_id}?error=name`);

  const claimId = genId();
  const needsApproval = task.requires_approval === 1;
  const status = needsApproval ? 'pending' : 'approved';

  db.prepare(`INSERT INTO claims (id,task_id,event_id,name,email,phone,note,status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(claimId, task.id, task.event_id, name.trim(), email || '', phone || '', note || '', status);

  if (!needsApproval) recalcClaimed(task.id);

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(task.event_id);
  if (event) {
    if (needsApproval) {
      const approveUrl = `${BASE_URL}/organizer/${event.organizer_token}/approve-claim/${claimId}`;
      const denyUrl = `${BASE_URL}/organizer/${event.organizer_token}/deny-claim/${claimId}`;
      await sendEmail(event.organizer_email || NOTIFY_EMAIL,
        `⏳ Approval needed: ${name} wants "${task.title}"`,
        `<h3>Someone wants to claim a role that needs your approval.</h3>
         <p><strong>${name}</strong> wants to claim <strong>${task.title}</strong> for <em>${event.title}</em>.</p>
         ${email ? `<p>📧 ${email}${phone ? ' &nbsp;·&nbsp; 📞 ' + phone : ''}</p>` : ''}
         ${note ? `<p>📝 "${note}"</p>` : ''}
         <p style="margin-top:20px">
           <a href="${approveUrl}" style="background:#C8621A;color:#fff;padding:10px 20px;text-decoration:none;font-weight:bold;margin-right:12px">✅ Approve</a>
           <a href="${denyUrl}" style="background:#666;color:#fff;padding:10px 20px;text-decoration:none;font-weight:bold">✗ Decline</a>
         </p>
         <p style="font-size:12px;color:#999">Or manage all approvals on your <a href="${BASE_URL}/organizer/${event.organizer_token}">dashboard →</a></p>`
      );
    } else {
      await sendEmail(event.organizer_email || NOTIFY_EMAIL,
        `🙋 ${name} claimed "${task.title}"`,
        `<p><strong>${name}</strong> claimed <strong>${task.title}</strong> for <em>${event.title}</em>.</p>
         ${email ? `<p>Contact: ${email}${phone ? ' / ' + phone : ''}</p>` : ''}
         <p><a href="${BASE_URL}/organizer/${event.organizer_token}">View dashboard →</a></p>`
      );
    }
    // Confirmation email to claimant
    if (email) {
      const eventUrl = `${BASE_URL}/event/${event.id}`;
      const dateStr = [event.date, event.event_time].filter(Boolean).join(' · ');
      const locStr = [event.location_name || event.location, event.location_address].filter(Boolean).join(', ').replace(/\n/g, ' ');
      if (needsApproval) {
        await sendEmail(email,
          `Your request for "${task.title}" is pending`,
          `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:40px;margin-bottom:24px;display:block">
            <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:8px">You're in the queue.</h2>
            <p style="color:#555;line-height:1.6;margin-bottom:20px">Your request to claim <strong>${task.title}</strong> for <strong>${event.title}</strong> has been sent to the organizer. They'll confirm your spot shortly.</p>
            ${dateStr ? `<p style="color:#888;font-size:13px;margin-bottom:4px">📅 ${dateStr}</p>` : ''}
            ${locStr ? `<p style="color:#888;font-size:13px;margin-bottom:20px">📍 ${locStr}</p>` : ''}
            <a href="${eventUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;font-weight:700;font-size:14px;text-decoration:none">View event →</a>
            <p style="color:#bbb;font-size:11px;margin-top:28px">You'll hear back from the organizer soon.</p>
          </div>`
        );
      } else {
        await sendEmail(email,
          `You're confirmed for "${task.title}" — ${event.title}`,
          `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:40px;margin-bottom:24px;display:block">
            <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:8px">You're in. 🙌</h2>
            <p style="color:#555;line-height:1.6;margin-bottom:6px">You've claimed <strong>${task.title}</strong> for:</p>
            <p style="font-size:18px;font-weight:800;color:#111;margin-bottom:20px">${event.title}</p>
            ${dateStr ? `<p style="color:#555;font-size:14px;margin-bottom:4px">📅 ${dateStr}</p>` : ''}
            ${locStr ? `<p style="color:#555;font-size:14px;margin-bottom:20px">📍 ${locStr}</p>` : ''}
            <a href="${eventUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:28px">View full event →</a>
            <p style="color:#bbb;font-size:11px">Save this email — it has the event details. See you there.</p>
          </div>`
        );
      }
    }
  }
  const redirectParam = needsApproval ? 'pending' : `claimed=${task.id}`;
  res.redirect(`/event/${task.event_id}?${redirectParam}=${task.id}`);
});

// Approve claim (via email link or dashboard)
app.get('/organizer/:token/approve-claim/:claimId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND event_id = ?').get(req.params.claimId, event.id);
  if (!claim) return res.status(404).send('Claim not found');
  db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('approved', claim.id);
  recalcClaimed(claim.task_id);
  res.redirect(`/organizer/${req.params.token}?approved=${claim.id}`);
});

// Deny claim
app.get('/organizer/:token/deny-claim/:claimId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND event_id = ?').get(req.params.claimId, event.id);
  if (!claim) return res.status(404).send('Claim not found');
  db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('denied', claim.id);
  recalcClaimed(claim.task_id);
  res.redirect(`/organizer/${req.params.token}?denied=${claim.id}`);
});

// Toggle task approval requirement
app.post('/organizer/:token/toggle-approval/:taskId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND event_id = ?').get(req.params.taskId, event.id);
  if (!task) return res.status(404).send('Not found');
  db.prepare('UPDATE tasks SET requires_approval = ? WHERE id = ?').run(task.requires_approval ? 0 : 1, task.id);
  res.json({ ok: true });
});

// Toggle event privacy
app.post('/organizer/:token/toggle-privacy', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  db.prepare('UPDATE events SET is_private = ? WHERE id = ?').run(event.is_private ? 0 : 1, event.id);
  res.redirect(`/organizer/${req.params.token}`);
});

// Organizer dashboard
app.get('/organizer/:token', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).render('404');
  const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ? ORDER BY sort_order').all(event.id);
  const allClaims = db.prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY created_at DESC').all(event.id);
  const claimsByTask = {};
  allClaims.forEach(c => {
    if (!claimsByTask[c.task_id]) claimsByTask[c.task_id] = [];
    claimsByTask[c.task_id].push(c);
  });
  const pendingClaims = allClaims.filter(c => c.status === 'pending');
  const eventUrl = `${BASE_URL}/event/${event.id}`;
  const totalNeeded = tasks.reduce((s, t) => s + t.quantity_needed, 0);
  const totalClaimed = tasks.reduce((s, t) => s + t.quantity_claimed, 0);
  // Build flat people list with task info
  const taskMap = {}; tasks.forEach(t => taskMap[t.id] = t);
  const allClaimsWithTask = allClaims.map(c => ({ ...c, task: taskMap[c.task_id] }));

  res.render('organizer', {
    event, tasks, claimsByTask, pendingClaims, allClaimsWithTask, eventUrl,
    totalNeeded, totalClaimed,
    isNew: req.query.new === '1',
    justApproved: req.query.approved,
    justDenied: req.query.denied,
    saved: req.query.saved === '1',
    uploaded: req.query.uploaded === '1'
  });
});

// Add task
app.post('/organizer/:token/add-task', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { title, description, category, quantity_needed, requires_approval } = req.body;
  if (!title) return res.redirect(`/organizer/${req.params.token}`);
  const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE event_id = ?').get(event.id).c;
  const qtyVal = (req.body.unlimited === '1') ? 0 : (parseInt(quantity_needed) || 1);
  db.prepare(`INSERT INTO tasks (id,event_id,title,description,category,quantity_needed,requires_approval,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
    .run(genId(), event.id, title.trim(), description || '', category || 'people', qtyVal, requires_approval === '1' ? 1 : 0, taskCount);
  res.redirect(`/organizer/${req.params.token}`);
});

// Delete task
app.post('/organizer/:token/delete-task/:taskId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  db.prepare('DELETE FROM claims WHERE task_id = ?').run(req.params.taskId);
  db.prepare('DELETE FROM tasks WHERE id = ? AND event_id = ?').run(req.params.taskId, event.id);
  res.redirect(`/organizer/${req.params.token}`);
});

app.post('/notify', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.redirect('/?subscribed=1');
  const BREVO_LIST_ID = parseInt(process.env.BREVO_LIST_ID || '3');
  try {
    // Add to Brevo contact list
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, listIds: [BREVO_LIST_ID], updateEnabled: true })
    });
    // Confirmation to subscriber
    await sendEmail(email, "You're on the GetRallied waitlist!",
      `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="font-size:22px;font-weight:800;color:#111">You're on the list.</h2>
        <p style="color:#555;line-height:1.6">Thanks for signing up for <strong>GetRallied</strong> — the event task registry that turns big visions into organized action.</p>
        <p style="color:#555;line-height:1.6">We'll reach out when we launch publicly. If you have an event coming up and want early access, just reply to this email.</p>
        <p style="color:#888;font-size:13px;margin-top:32px">— The GetRallied team</p>
      </div>`
    );
    // Notify Jason
    await sendEmail(NOTIFY_EMAIL, '🎉 New GetRallied waitlist signup: ' + email,
      `<p><strong>${email}</strong> just joined the GetRallied waitlist.</p>`
    );
  } catch(e) { console.error('Notify error:', e.message); }
  res.redirect('/?subscribed=1');
});

// Admin
// ── Image Uploads ────────────────────────────────────────────────────────────

const path_mod = require('path');

app.post('/organizer/:token/upload-images',
  upload.fields([{ name: 'org_logo', maxCount: 1 }, { name: 'banner_image', maxCount: 1 }]),
  (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
    if (!event) return res.status(404).send('Not found');

    const updates = {};
    if (req.files?.org_logo?.[0]) {
      const f = req.files.org_logo[0];
      const ext = f.mimetype.split('/')[1].replace('jpeg','jpg');
      const newName = `logo_${event.id}_${Date.now()}.${ext}`;
      require('fs').renameSync(f.path, `./public/uploads/${newName}`);
      updates.org_logo = `/uploads/${newName}`;
    }
    if (req.files?.banner_image?.[0]) {
      const f = req.files.banner_image[0];
      const ext = f.mimetype.split('/')[1].replace('jpeg','jpg');
      const newName = `banner_${event.id}_${Date.now()}.${ext}`;
      require('fs').renameSync(f.path, `./public/uploads/${newName}`);
      updates.banner_image = `/uploads/${newName}`;
    }

    if (updates.org_logo !== undefined) db.prepare('UPDATE events SET org_logo = ? WHERE id = ?').run(updates.org_logo, event.id);
    if (updates.banner_image !== undefined) db.prepare('UPDATE events SET banner_image = ? WHERE id = ?').run(updates.banner_image, event.id);

    res.redirect(`/organizer/${req.params.token}?uploaded=1`);
  }
);


// Update event details (time/location)
app.post('/organizer/:token/update-details', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { date, event_time, location_name, location_address, location_maps_url } = req.body;
  db.prepare(`UPDATE events SET
    date = ?, event_time = ?, location_name = ?, location_address = ?, location_maps_url = ?
    WHERE id = ?`).run(
    date || event.date,
    event_time || null,
    location_name || null,
    location_address || null,
    location_maps_url || null,
    event.id
  );
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});


// Reorder tasks
app.post('/organizer/:token/reorder', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const { order } = req.body; // array of task IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Bad request' });
  const update = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ? AND event_id = ?');
  order.forEach((id, i) => update.run(i, id, event.id));
  res.json({ ok: true });
});


// CSV export
app.get('/organizer/:token/export.csv', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const claims = db.prepare(`
    SELECT c.name, c.email, c.phone, c.note, c.status, c.created_at, t.title as task
    FROM claims c JOIN tasks t ON c.task_id = t.id
    WHERE c.event_id = ? ORDER BY t.sort_order, c.created_at
  `).all(event.id);

  const escape = v => v ? '"' + String(v).replace(/"/g, '""') + '"' : '""';
  const rows = [
    ['Name', 'Email', 'Phone', 'Task', 'Status', 'Note', 'Signed Up'].map(escape).join(','),
    ...claims.map(c => [c.name, c.email, c.phone, c.task, c.status, c.note, c.created_at].map(escape).join(','))
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${event.title.replace(/[^a-z0-9]/gi,'_')}_people.csv"`);
  res.send(rows.join('\n'));
});


// People CRUD (JSON API)

// Add person manually
app.post('/organizer/:token/add-person', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const { name, email, phone, note, task_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const task = task_id ? db.prepare('SELECT * FROM tasks WHERE id = ? AND event_id = ?').get(task_id, event.id) : null;
  const claimId = genId();
  db.prepare(`INSERT INTO claims (id,task_id,event_id,name,email,phone,note,status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(claimId, task_id || '', event.id, name.trim(), email||'', phone||'', note||'', 'approved');
  if (task_id) recalcClaimed(task_id);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  res.json({ ok: true, claim, taskTitle: task ? task.title : '—' });
});

// Edit person
app.post('/organizer/:token/edit-person/:claimId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND event_id = ?').get(req.params.claimId, event.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  const { name, email, phone, note, task_id } = req.body;
  const oldTaskId = claim.task_id;
  db.prepare('UPDATE claims SET name=?,email=?,phone=?,note=?,task_id=? WHERE id=?')
    .run(name||claim.name, email||'', phone||'', note||'', task_id||claim.task_id, claim.id);
  if (oldTaskId) recalcClaimed(oldTaskId);
  if (task_id && task_id !== oldTaskId) recalcClaimed(task_id);
  const task = task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id) : null;
  res.json({ ok: true, taskTitle: task ? task.title : '—' });
});

// Delete person
app.delete('/organizer/:token/person/:claimId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND event_id = ?').get(req.params.claimId, event.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM claims WHERE id = ?').run(claim.id);
  if (claim.task_id) recalcClaimed(claim.task_id);
  res.json({ ok: true });
});

// ── Magic Link Login ─────────────────────────────────────────────────────────

// Login page
app.get('/login', (req, res) => res.render('login', { sent: req.query.sent, error: req.query.error }));

// Send magic link
app.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.redirect('/login?error=1');

  const events = db.prepare("SELECT * FROM events WHERE LOWER(organizer_email) = LOWER(?) ORDER BY created_at DESC").all(email.trim());
  if (!events.length) return res.redirect('/login?error=noevent');

  // Generate token, expires in 1 hour
  const token = genId(32);
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)").run(token, email.toLowerCase().trim(), expires);

  const loginUrl = `${BASE_URL}/auth/${token}`;

  const eventList = events.map(e =>
    `<div style="border:1px solid #eee;padding:14px 16px;margin-bottom:8px">
      <div style="font-weight:700;font-size:15px">${e.title}</div>
      <div style="color:#888;font-size:12px;margin:4px 0">${e.date || 'Date TBD'} · ${e.location || 'Location TBD'}</div>
    </div>`
  ).join('');

  await sendEmail(email.trim(), 'Your GetRallied dashboard link',
    `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
      <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:44px;margin-bottom:28px;display:block">
      <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:8px">Here's your dashboard link.</h2>
      <p style="color:#555;line-height:1.6;margin-bottom:20px">Click below to access your organizer dashboard. This link expires in 1 hour.</p>
      <a href="${loginUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:28px">Open my dashboard →</a>
      <p style="font-size:13px;font-weight:600;color:#111;margin-bottom:8px">Your events:</p>
      ${eventList}
      <p style="color:#aaa;font-size:11px;margin-top:24px">If you didn't request this, you can safely ignore it.</p>
    </div>`
  );

  res.redirect('/login?sent=1');
});

// Auth token handler
app.get('/auth/:token', (req, res) => {
  const row = db.prepare("SELECT * FROM magic_tokens WHERE token = ?").get(req.params.token);
  if (!row || row.used) return res.redirect('/login?error=expired');
  if (new Date(row.expires_at) < new Date()) return res.redirect('/login?error=expired');

  // Mark used
  db.prepare("UPDATE magic_tokens SET used = 1 WHERE token = ?").run(row.token);

  // Find their most recent event and redirect to its dashboard
  const events = db.prepare("SELECT * FROM events WHERE LOWER(organizer_email) = LOWER(?) ORDER BY created_at DESC").all(row.email);
  if (!events.length) return res.redirect('/login?error=noevent');

  if (events.length === 1) {
    return res.redirect(`/organizer/${events[0].organizer_token}`);
  }

  // Multiple events — show picker
  res.render('event-picker', { events, baseUrl: BASE_URL });
});

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return res.set('WWW-Authenticate','Basic realm="GetRallied Admin"').status(401).send('Unauthorized');
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  if (!ADMIN_PASS) return res.status(503).send('Admin not configured');
  const adminUser = process.env.ADMIN_USER || 'admin';
  if (decoded.slice(0, colon) === adminUser && decoded.slice(colon+1) === ADMIN_PASS) return next();
  return res.set('WWW-Authenticate','Basic realm="GetRallied Admin"').status(401).send('Unauthorized');
}

app.get('/admin', adminAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  const taskStats = db.prepare('SELECT event_id, COUNT(*) as total, SUM(quantity_needed) as needed, SUM(quantity_claimed) as claimed FROM tasks GROUP BY event_id').all();
  const claimStats = db.prepare("SELECT event_id, COUNT(*) as total FROM claims WHERE status != 'denied' GROUP BY event_id").all();
  const pendingStats = db.prepare("SELECT event_id, COUNT(*) as total FROM claims WHERE status = 'pending' GROUP BY event_id").all();
  const taskMap = {}; taskStats.forEach(t => taskMap[t.event_id] = t);
  const claimMap = {}; claimStats.forEach(c => claimMap[c.event_id] = c.total);
  const pendingMap = {}; pendingStats.forEach(p => pendingMap[p.event_id] = p.total);
  res.render('admin', { events, taskMap, claimMap, pendingMap, baseUrl: BASE_URL });
});

app.listen(PORT, '127.0.0.1', () => console.log(`GetRallied running on port ${PORT}`));
