require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const multer = require('multer');
const upload = multer({
  dest: '/opt/ourtask/public/uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  }
});
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 19100;
const BASE_URL = process.env.BASE_URL || 'https://getrallied.com';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jason@ercsn.com';
const BREVO_KEY = process.env.BREVO_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) console.warn('⚠️  ADMIN_PASS not set — /admin route is disabled');
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

// DB
const db = new Database('/opt/ourtask/ourtask.db');
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

// Accounts table
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
// Password reset tokens table
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
try { db.exec('ALTER TABLE events ADD COLUMN account_id TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE accounts ADD COLUMN profile_pic TEXT'); } catch(e) {}
try { db.exec("ALTER TABLE events ADD COLUMN status TEXT DEFAULT 'active'"); } catch(e) {}
try { db.exec('ALTER TABLE events ADD COLUMN milestones_sent TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE claims ADD COLUMN account_id TEXT DEFAULT NULL'); } catch(e) {}

// Date validation — machine-readable date for filtering
try { db.exec('ALTER TABLE events ADD COLUMN date_iso TEXT DEFAULT NULL'); } catch(e) {}

// Task comments/updates
db.exec(`
  CREATE TABLE IF NOT EXISTS event_updates (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    message TEXT NOT NULL,
    author_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(event_id) REFERENCES events(id)
  );
`);

// HTML escape helper for safe template literal injection
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function genId(len = 10) {
  return crypto.randomBytes(Math.ceil(len * 0.75)).toString('hex').slice(0, len);
}

function genSecureToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
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
app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));
app.use(bodyParser.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(cookieParser());
app.use(helmet({
  contentSecurityPolicy: false, // EJS inline scripts need this off for now
  crossOriginEmbedderPolicy: false,
}));

// ── CSRF Protection ───────────────────────────────────────────────────────────
function generateCsrf(req) {
  if (!req.cookies?._csrf_secret) {
    req._csrfSecret = crypto.randomBytes(24).toString('hex');
  } else {
    req._csrfSecret = req.cookies._csrf_secret;
  }
  return crypto.createHmac('sha256', req._csrfSecret).update('csrf').digest('hex');
}

function csrfMiddleware(req, res, next) {
  // Set secret cookie if not present
  if (!req.cookies?._csrf_secret) {
    const secret = crypto.randomBytes(24).toString('hex');
    res.cookie('_csrf_secret', secret, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 24 * 60 * 60 * 1000 });
    req.cookies._csrf_secret = secret;
  }
  // Skip check for GET/HEAD/OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Also check DELETE requests
  const token = req.body?._csrf || req.headers['x-csrf-token'];
  const expected = crypto.createHmac('sha256', req.cookies._csrf_secret).update('csrf').digest('hex');
  if (!token || token !== expected) {
    return res.status(403).send('Invalid or missing CSRF token. Please go back and try again.');
  }
  next();
}

// Make csrf token available to all views
app.use((req, res, next) => {
  if (!req.cookies?._csrf_secret) {
    const secret = crypto.randomBytes(24).toString('hex');
    res.cookie('_csrf_secret', secret, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 24 * 60 * 60 * 1000 });
    req.cookies._csrf_secret = secret;
  }
  res.locals.csrfToken = crypto.createHmac('sha256', req.cookies._csrf_secret).update('csrf').digest('hex');
  next();
});

// Apply CSRF to all state-changing routes
app.use(['/create', '/claim', '/signup', '/signin', '/notify', '/account', '/organizer', '/forgot-password', '/reset-password'], csrfMiddleware);

// ── Auth helpers ──────────────────────────────────────────────────────────────
function signPayload(payload) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  return payload + '.' + hmac;
}

function verifyPayload(signed) {
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return payload;
}

function getAccount(req) {
  try {
    const cookie = req.cookies?.gr_auth;
    if (!cookie) return null;
    const payload = verifyPayload(cookie);
    if (!payload) return null;
    const { id } = JSON.parse(Buffer.from(payload, 'base64').toString());
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  } catch(e) { return null; }
}

function setAuthCookie(res, account) {
  const payload = Buffer.from(JSON.stringify({ id: account.id, email: account.email })).toString('base64');
  const signed = signPayload(payload);
  res.cookie('gr_auth', signed, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: true });
}

function requireAuth(req, res, next) {
  const account = getAccount(req);
  if (!account) return res.redirect('/signin?next=' + encodeURIComponent(req.originalUrl));
  req.account = account;
  next();
}

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

// ── Milestone Notifications ───────────────────────────────────────────────────
async function checkAndSendMilestones(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event || !event.organizer_email) return;

  // Only count tasks where qty_needed > 0
  const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ? AND quantity_needed > 0').all(eventId);
  if (tasks.length === 0) return;

  const totalNeeded = tasks.reduce((sum, t) => sum + t.quantity_needed, 0);
  const totalClaimed = tasks.reduce((sum, t) => sum + t.quantity_claimed, 0);
  const fillPercentage = totalNeeded > 0 ? (totalClaimed / totalNeeded) * 100 : 0;
  const spotsRemaining = totalNeeded - totalClaimed;

  const sent = event.milestones_sent ? event.milestones_sent.split(',') : [];
  const dashboardUrl = `${BASE_URL}/organizer/${event.organizer_token}`;

  // Check 50% milestone
  if (fillPercentage >= 50 && !sent.includes('50')) {
    await sendEmail(event.organizer_email,
      `🎉 ${esc(event.title)} is halfway there!`,
      `<h2>🎉 Congratulations!</h2>
       <p>Your event <strong>${esc(event.title)}</strong> just hit the <strong>50% mark</strong>!</p>
       <p>${totalClaimed} out of ${totalNeeded} volunteer spots are now filled.</p>
       <p>Keep the momentum going! <a href="${dashboardUrl}" style="color:#111;font-weight:bold">View your dashboard →</a></p>`
    );
    sent.push('50');
  }

  // Check "almost full" milestone (3 or fewer spots remaining)
  if (spotsRemaining > 0 && spotsRemaining <= 3 && !sent.includes('almost')) {
    await sendEmail(event.organizer_email,
      `🔥 ${esc(event.title)} is almost fully staffed!`,
      `<h2>🔥 Almost there!</h2>
       <p>Your event <strong>${esc(event.title)}</strong> is <strong>almost fully staffed</strong>!</p>
       <p>Only <strong>${spotsRemaining} volunteer spot${spotsRemaining === 1 ? '' : 's'}</strong> remaining.</p>
       <p><a href="${dashboardUrl}" style="color:#111;font-weight:bold">View your dashboard →</a></p>`
    );
    sent.push('almost');
  }

  // Check 100% milestone
  if (fillPercentage >= 100 && !sent.includes('100')) {
    await sendEmail(event.organizer_email,
      `🎊 ${esc(event.title)} is fully staffed!`,
      `<h2>🎊 You did it!</h2>
       <p>Your event <strong>${esc(event.title)}</strong> is now <strong>100% fully staffed</strong>!</p>
       <p>All ${totalNeeded} volunteer spots are filled. Time to celebrate! 🎉</p>
       <p><a href="${dashboardUrl}" style="color:#111;font-weight:bold">View your dashboard →</a></p>`
    );
    sent.push('100');
  }

  // Update milestones_sent if anything was sent
  if (sent.length > (event.milestones_sent ? event.milestones_sent.split(',').length : 0)) {
    db.prepare('UPDATE events SET milestones_sent = ? WHERE id = ?').run(sent.join(','), eventId);
  }
}

// ── SEO Routes ──────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Allow: /explore
Allow: /event/
Disallow: /organizer/
Disallow: /admin
Disallow: /account
Disallow: /dashboard
Sitemap: ${BASE_URL}/sitemap.xml`);
});

app.get('/sitemap.xml', (req, res) => {
  const events = db.prepare("SELECT id, created_at FROM events WHERE is_private = 0 ORDER BY created_at DESC").all();
  const urls = [
    { loc: BASE_URL + '/', priority: '1.0', changefreq: 'weekly' },
    { loc: BASE_URL + '/explore', priority: '0.9', changefreq: 'daily' },
    { loc: BASE_URL + '/signup', priority: '0.7', changefreq: 'monthly' },
    ...events.map(e => ({
      loc: BASE_URL + '/event/' + e.id,
      priority: '0.8',
      changefreq: 'weekly',
      lastmod: e.created_at ? e.created_at.split(' ')[0] : undefined
    }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <priority>${u.priority}</priority>
    <changefreq>${u.changefreq}</changefreq>${u.lastmod ? '\n    <lastmod>' + u.lastmod + '</lastmod>' : ''}
  </url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

// ── Event Templates ─────────────────────────────────────────────────────────
const EVENT_TEMPLATES = [
  {
    id: 'beach-cleanup',
    name: '🏖️ Beach Cleanup',
    vision: 'Organize a beach cleanup day. We need people to bring trash bags and grabbers, coordinate with the city for dumpster placement, set up a check-in table, provide water and snacks for volunteers, and take before/after photos for social media.',
    defaults: { is_private: '0' }
  },
  {
    id: 'block-party',
    name: '🎉 Block Party',
    vision: 'Plan a neighborhood block party. We need someone to handle the city street closure permit, set up tables and chairs, coordinate a potluck sign-up, arrange music/DJ or a playlist, organize kids activities, and handle cleanup afterward.',
    defaults: { is_private: '0' }
  },
  {
    id: 'fundraiser',
    name: '💰 Fundraiser',
    vision: 'Run a community fundraiser event. We need people to handle venue setup, manage ticket sales or donations at the door, coordinate food and beverages, arrange entertainment or speakers, handle social media promotion, and manage thank-you notes to donors.',
    defaults: { is_private: '0' }
  },
  {
    id: 'protest-march',
    name: '✊ Rally / March',
    vision: 'Organize a peaceful rally or march. We need a route coordinator, someone to handle city permits, volunteer marshals for crowd safety, a sound system operator, sign-making materials and distribution, a first aid volunteer, and someone to handle media/press coordination.',
    defaults: { is_private: '0' }
  },
  {
    id: 'potluck',
    name: '🍕 Potluck',
    vision: 'Host a community potluck gathering. We need people to bring main dishes, sides, desserts, and drinks. Someone should handle plates/cups/utensils, table setup, and cleanup. We also need someone to coordinate the dish sign-up so we get variety.',
    defaults: { is_private: '0' }
  },
  {
    id: 'volunteer-day',
    name: '🤝 Volunteer Day',
    vision: 'Coordinate a volunteer service day. We need a project lead to define work areas, tool and supply coordinators, a safety briefer, someone to handle volunteer sign-in and waivers, provide lunch and water, and a photographer to document the day.',
    defaults: { is_private: '0' }
  },
  {
    id: 'meetup',
    name: '☕ Meetup / Hangout',
    vision: 'Organize a casual meetup. We need someone to reserve the venue or pick a spot, handle the headcount RSVP, coordinate food/drink orders, and spread the word on social media.',
    defaults: { is_private: '1' }
  }
];

app.get('/api/templates', (req, res) => {
  res.json(EVENT_TEMPLATES.map(t => ({ id: t.id, name: t.name, vision: t.vision })));
});

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

const claimLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'Too many claims. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Event creation limit reached. Try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/signin', authLimiter);
app.use('/signup', authLimiter);
app.use('/login', authLimiter);
app.use('/claim', claimLimiter);
app.use('/create', createLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.render('home', { account: getAccount(req) }));

// Create event form
app.get('/create', requireAuth, (req, res) => {
  res.render('create', { account: req.account, csrfToken: res.locals.csrfToken });
});

// Create event
app.post('/create', async (req, res) => {
  const { title, vision, date, location, organizer_name, organizer_email, is_private } = req.body;
  if (!title || !vision) return res.status(400).send('Title and vision required');
  try {
    let breakdown = { tasks: [] };
    try {
      breakdown = await breakdownVision(vision, title, date || 'TBD', location || 'TBD');
    } catch(aiErr) {
      console.error('AI task breakdown failed (continuing without tasks):', aiErr.message);
    }
    const eventId = genId(8);
    const organizerToken = genSecureToken(24);
    const isPrivate = is_private === '1' ? 1 : 0;

    const account = getAccount(req);
    db.prepare(`INSERT INTO events (id,organizer_token,title,description,vision,date,location,organizer_name,organizer_email,is_private,account_id,date_iso,location_address) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(eventId, organizerToken, title.trim(), '', vision.trim(), date || '', location || '', organizer_name || '', organizer_email || NOTIFY_EMAIL, isPrivate, account ? account.id : null, date || null, location || null);

    (breakdown.tasks || []).forEach((t, i) => {
      db.prepare(`INSERT INTO tasks (id,event_id,title,description,category,quantity_needed,requires_approval,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
        .run(genId(), eventId, t.title, t.description || '', t.category || 'people', t.quantity_needed || 1, t.requires_approval ? 1 : 0, i);
    });

    const dashUrl = `${BASE_URL}/organizer/${organizerToken}`;
    const eventUrl = `${BASE_URL}/event/${eventId}`;
    await sendEmail(organizer_email || NOTIFY_EMAIL, `Your GetRallied registry is live: ${esc(title)}`,
      `<h2>Your event registry is live!</h2>
       <p>${isPrivate ? '🔒 <strong>Private event</strong> — only people with the link can see it.' : '🌐 Public event'}</p>
       <p><a href="${eventUrl}">Share this link with your people →</a></p>
       <p><a href="${dashUrl}">Your organizer dashboard →</a></p>`);

    res.redirect(`/organizer/${organizerToken}?new=1`);
  } catch (e) {
    console.error('Create error:', e);
    res.status(500).send('Something went wrong creating your event. Please try again.');
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
  const ogTotalNeeded = tasks.filter(t => t.quantity_needed > 0).reduce((s,t) => s + t.quantity_needed, 0);
  const ogTotalClaimed = tasks.filter(t => t.quantity_needed > 0).reduce((s,t) => s + t.quantity_claimed, 0);
  const ogPct = ogTotalNeeded > 0 ? Math.round(ogTotalClaimed / ogTotalNeeded * 100) : 0;
  const uniquePeople = db.prepare("SELECT COUNT(DISTINCT LOWER(email)) as c FROM claims WHERE event_id = ? AND status = 'approved' AND email != ''").get(event.id).c;
  const totalPeople = db.prepare("SELECT COUNT(*) as c FROM claims WHERE event_id = ? AND status = 'approved'").get(event.id).c;
  const eventUpdates = db.prepare('SELECT * FROM event_updates WHERE event_id = ? ORDER BY created_at DESC').all(event.id);
  res.render('event', { event, tasks, claimsByTask, pendingByTask, qrDataUrl, eventUrl, claimed: req.query.claimed, pending: req.query.pending, account: getAccount(req), baseUrl: BASE_URL, ogPct, ogTotalClaimed, ogTotalNeeded, peopleCount: uniquePeople || totalPeople, eventUpdates });
});

// Claim a task
app.post('/claim/:taskId', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).send('Task not found');
  const { name, email, phone, note } = req.body;
  if (!name) return res.redirect(`/event/${task.event_id}?error=name`);

  // Check for duplicate claim (same email + same task)
  if (email) {
    const existing = db.prepare("SELECT id FROM claims WHERE task_id = ? AND LOWER(email) = LOWER(?) AND status != 'denied'").get(task.id, email.trim());
    if (existing) return res.redirect(`/event/${task.event_id}?error=duplicate`);
  }

  // Check if task is full (race condition guard)
  if (!isUnlimited(task) && task.quantity_claimed >= task.quantity_needed) {
    return res.redirect(`/event/${task.event_id}?error=full`);
  }

  const claimId = genId();
  const needsApproval = task.requires_approval === 1;
  const status = needsApproval ? 'pending' : 'approved';
  const claimAccount = getAccount(req);

  db.prepare(`INSERT INTO claims (id,task_id,event_id,name,email,phone,note,status,account_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(claimId, task.id, task.event_id, name.trim(), email || '', phone || '', note || '', status, claimAccount ? claimAccount.id : null);

  if (!needsApproval) {
    recalcClaimed(task.id);
    await checkAndSendMilestones(task.event_id);
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(task.event_id);
  if (event) {
    if (needsApproval) {
      const approveUrl = `${BASE_URL}/organizer/${event.organizer_token}/approve-claim/${claimId}`;
      const denyUrl = `${BASE_URL}/organizer/${event.organizer_token}/deny-claim/${claimId}`;
      await sendEmail(event.organizer_email || NOTIFY_EMAIL,
        `⏳ Approval needed: ${esc(name)} wants "${esc(task.title)}"`,
        `<h3>Someone wants to claim a role that needs your approval.</h3>
         <p><strong>${esc(name)}</strong> wants to claim <strong>${esc(task.title)}</strong> for <em>${esc(event.title)}</em>.</p>
         ${email ? `<p>📧 ${esc(email)}${phone ? ' &nbsp;·&nbsp; 📞 ' + phone : ''}</p>` : ''}
         ${note ? `<p>📝 "${esc(note)}"</p>` : ''}
         <p style="margin-top:20px">
           <a href="${approveUrl}" style="background:#C8621A;color:#fff;padding:10px 20px;text-decoration:none;font-weight:bold;margin-right:12px">✅ Approve</a>
           <a href="${denyUrl}" style="background:#666;color:#fff;padding:10px 20px;text-decoration:none;font-weight:bold">✗ Decline</a>
         </p>
         <p style="font-size:12px;color:#999">Or manage all approvals on your <a href="${BASE_URL}/organizer/${event.organizer_token}">dashboard →</a></p>`
      );
    } else {
      await sendEmail(event.organizer_email || NOTIFY_EMAIL,
        `🙋 ${esc(name)} claimed "${esc(task.title)}"`,
        `<p><strong>${esc(name)}</strong> claimed <strong>${esc(task.title)}</strong> for <em>${esc(event.title)}</em>.</p>
         ${email ? `<p>Contact: ${esc(email)}${phone ? ' / ' + phone : ''}</p>` : ''}
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
          `Your request for "${esc(task.title)}" is pending`,
          `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:40px;margin-bottom:24px;display:block">
            <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:8px">You're in the queue.</h2>
            <p style="color:#555;line-height:1.6;margin-bottom:20px">Your request to claim <strong>${esc(task.title)}</strong> for <strong>${esc(event.title)}</strong> has been sent to the organizer. They'll confirm your spot shortly.</p>
            ${dateStr ? `<p style="color:#888;font-size:13px;margin-bottom:4px">📅 ${dateStr}</p>` : ''}
            ${locStr ? `<p style="color:#888;font-size:13px;margin-bottom:20px">📍 ${locStr}</p>` : ''}
            <a href="${eventUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;font-weight:700;font-size:14px;text-decoration:none">View event →</a>
            <p style="color:#bbb;font-size:11px;margin-top:28px">You'll hear back from the organizer soon.</p>
          </div>`
        );
      } else {
        await sendEmail(email,
          `You're confirmed for "${esc(task.title)}" — ${esc(event.title)}`,
          `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:40px;margin-bottom:24px;display:block">
            <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:8px">You're in. 🙌</h2>
            <p style="color:#555;line-height:1.6;margin-bottom:6px">You've claimed <strong>${esc(task.title)}</strong> for:</p>
            <p style="font-size:18px;font-weight:800;color:#111;margin-bottom:20px">${esc(event.title)}</p>
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
  const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(claim.task_id);
  // Show confirmation page instead of auto-approving via GET
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve Claim</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{max-width:400px;border:1.5px solid #e5e2dc;border-radius:8px;padding:32px;text-align:center}
    h2{font-size:18px;font-weight:800;margin-bottom:12px}p{color:#777;font-size:14px;margin-bottom:20px;line-height:1.5}
    .btn{display:inline-block;padding:12px 28px;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:inherit;text-decoration:none;margin:4px}
    .approve{background:#111;color:#fff}.deny{background:#fff;color:#777;border:1.5px solid #e5e2dc}</style></head>
    <body><div class="card"><h2>Approve this claim?</h2>
    <p><strong>${esc(claim.name)}</strong> wants to claim <strong>${task ? esc(task.title) : 'a task'}</strong></p>
    <form method="POST" action="/organizer/${req.params.token}/approve-claim/${claim.id}" style="display:inline">
      <input type="hidden" name="_csrf" value="${res.locals.csrfToken}">
      <button type="submit" class="btn approve">✅ Approve</button>
    </form>
    <form method="POST" action="/organizer/${req.params.token}/deny-claim/${claim.id}" style="display:inline">
      <input type="hidden" name="_csrf" value="${res.locals.csrfToken}">
      <button type="submit" class="btn deny">✗ Decline</button>
    </form></div></body></html>`);
});
app.post('/organizer/:token/approve-claim/:claimId', async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const claim = db.prepare('SELECT * FROM claims WHERE id = ? AND event_id = ?').get(req.params.claimId, event.id);
  if (!claim) return res.status(404).send('Claim not found');
  db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('approved', claim.id);
  recalcClaimed(claim.task_id);
  await checkAndSendMilestones(event.id);
  res.redirect(`/organizer/${req.params.token}?approved=${claim.id}`);
});

// Deny claim
app.post('/organizer/:token/deny-claim/:claimId', (req, res) => {
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

  const eventUpdates = db.prepare('SELECT * FROM event_updates WHERE event_id = ? ORDER BY created_at DESC').all(event.id);

  const __account = getAccount(req);
    res.render('organizer', {
      account: __account,
      csrfToken: res.locals.csrfToken,
    event, tasks, claimsByTask, pendingClaims, allClaimsWithTask, eventUrl, eventUpdates,
    totalNeeded, totalClaimed,
    isNew: req.query.new === '1',
    justApproved: req.query.approved,
    justDenied: req.query.denied,
    saved: req.query.saved === '1',
    emailed: req.query.emailed || null,
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
      `<p><strong>${esc(email)}</strong> just joined the GetRallied waitlist.</p>`
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
      require('fs').renameSync(f.path, `/opt/ourtask/public/uploads/${newName}`);
      updates.org_logo = `/uploads/${newName}`;
    }
    if (req.files?.banner_image?.[0]) {
      const f = req.files.banner_image[0];
      const ext = f.mimetype.split('/')[1].replace('jpeg','jpg');
      const newName = `banner_${event.id}_${Date.now()}.${ext}`;
      require('fs').renameSync(f.path, `/opt/ourtask/public/uploads/${newName}`);
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
  const { date, date_iso, event_time, location_name, location_address, location_maps_url } = req.body;
  // Validate date_iso isn't in the past
  if (date_iso) {
    const today = new Date().toISOString().split('T')[0];
    if (date_iso < today) return res.redirect(`/organizer/${req.params.token}?error=Date cannot be in the past`);
  }
  db.prepare(`UPDATE events SET
    date = ?, date_iso = ?, event_time = ?, location_name = ?, location_address = ?, location_maps_url = ?
    WHERE id = ?`).run(
    date || event.date,
    date_iso || event.date_iso || null,
    event_time || null,
    location_name || null,
    location_address || null,
    location_maps_url || null,
    event.id
  );
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});


// Update event status (active/completed/cancelled)
app.post('/organizer/:token/update-status', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { status } = req.body;
  if (!['active', 'completed', 'cancelled'].includes(status)) return res.status(400).send('Invalid status');
  db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});

// Update event info (title, vision, description)
app.post('/organizer/:token/update-info', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { title, vision, description } = req.body;
  if (!title || !title.trim()) return res.redirect(`/organizer/${req.params.token}?error=Title is required`);
  db.prepare('UPDATE events SET title = ?, vision = ?, description = ? WHERE id = ?')
    .run(title.trim(), (vision || '').trim(), (description || '').trim(), event.id);
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});

// Duplicate event (copies event + tasks, resets claims)
app.post('/organizer/:token/duplicate', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');

  const newEventId = genId();
  const newOrganizerToken = genSecureToken();

  // Copy event (title, description, vision, location, organizer info, account_id)
  // Do NOT copy: date, is_private (defaults to 0), milestones_sent, status
  db.prepare(`INSERT INTO events 
    (id, organizer_token, title, description, vision, location, organizer_name, organizer_email, account_id, is_private)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    newEventId,
    newOrganizerToken,
    event.title,
    event.description,
    event.vision,
    event.location,
    event.organizer_name,
    event.organizer_email,
    event.account_id
  );

  // Copy all tasks from original event, reset quantity_claimed to 0
  const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ?').all(event.id);
  tasks.forEach(task => {
    db.prepare(`INSERT INTO tasks
      (id, event_id, title, description, category, quantity_needed, quantity_claimed, requires_approval, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      genId(),
      newEventId,
      task.title,
      task.description,
      task.category,
      task.quantity_needed,
      task.requires_approval,
      task.sort_order
    );
  });

  // Redirect to the new event's organizer page
  res.redirect(`/organizer/${newOrganizerToken}`);
});

// Email all volunteers
app.post('/organizer/:token/email-volunteers', async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { subject, message } = req.body;
  if (!subject || !message) return res.redirect(`/organizer/${req.params.token}?error=Subject and message required`);

  // Get unique volunteer emails
  const volunteers = db.prepare(`
    SELECT DISTINCT LOWER(email) as email, name FROM claims
    WHERE event_id = ? AND status = 'approved' AND email != ''
  `).all(event.id);

  if (volunteers.length === 0) return res.redirect(`/organizer/${req.params.token}?error=No volunteers with email addresses`);

  const eventUrl = `${BASE_URL}/event/${event.id}`;
  const dateStr = [event.date, event.event_time].filter(Boolean).join(' · ');
  const locStr = [event.location_name || event.location, event.location_address].filter(Boolean).join(', ');

  let sent = 0;
  for (const v of volunteers) {
    try {
      await sendEmail(v.email,
        subject,
        `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:36px;margin-bottom:24px;display:block">
          <h2 style="font-size:18px;font-weight:800;color:#111;margin-bottom:4px">${esc(event.title)}</h2>
          ${dateStr ? '<p style="color:#888;font-size:13px;margin-bottom:16px">📅 ' + dateStr + (locStr ? ' · 📍 ' + locStr : '') + '</p>' : ''}
          <div style="color:#333;font-size:15px;line-height:1.6;margin-bottom:24px;white-space:pre-wrap">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <a href="${eventUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;font-weight:700;font-size:14px;text-decoration:none">View event →</a>
          <p style="color:#bbb;font-size:11px;margin-top:28px">You're receiving this because you signed up for ${esc(event.title)} on GetRallied.</p>
        </div>`
      );
      sent++;
    } catch(e) { console.error('Email failed for', v.email, e.message); }
  }

  res.redirect(`/organizer/${req.params.token}?emailed=${sent}`);
});

// Delete event and all associated data
app.post('/organizer/:token/delete-event', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  db.prepare('DELETE FROM event_updates WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM claims WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM tasks WHERE event_id = ?').run(event.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  // Clean up uploaded images
  const fs = require('fs');
  if (event.org_logo) try { fs.unlinkSync('/opt/ourtask/public' + event.org_logo); } catch(e) {}
  if (event.banner_image) try { fs.unlinkSync('/opt/ourtask/public' + event.banner_image); } catch(e) {}
  const account = getAccount(req);
  res.redirect(account ? '/dashboard' : '/');
});

// Post event update
app.post('/organizer/:token/post-update', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  const { message } = req.body;
  if (!message || !message.trim()) return res.redirect(`/organizer/${req.params.token}`);
  db.prepare('INSERT INTO event_updates (id, event_id, message, author_name) VALUES (?,?,?,?)')
    .run(genId(), event.id, message.trim(), event.organizer_name || 'Organizer');
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});

// Delete event update
app.post('/organizer/:token/delete-update/:updateId', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).send('Not found');
  db.prepare('DELETE FROM event_updates WHERE id = ? AND event_id = ?').run(req.params.updateId, event.id);
  res.redirect(`/organizer/${req.params.token}?saved=1`);
});

// Reorder tasks
app.post('/organizer/:token/reorder', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE organizer_token = ?').get(req.params.token);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const { order } = req.body; // array of task IDs in new order
  if (!Array.isArray(order) || order.length > 100) return res.status(400).json({ error: 'Bad request' });
  const update = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ? AND event_id = ?');
  order.forEach((id, i) => {
    if (typeof id === 'string' && /^[a-f0-9]+$/.test(id)) update.run(i, id, event.id);
  });
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

  const escape = v => {
    if (!v) return '""';
    let s = String(v);
    // Prevent CSV formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
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
  if (!events.length) return res.redirect('/login?sent=1'); // Don't reveal whether email exists

  // Generate token, expires in 1 hour
  const token = genSecureToken(32);
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
  res.render('event-picker', { events, baseUrl: BASE_URL, account: getAccount(req) });
});


// ── Signup / Signin / Dashboard / Explore ─────────────────────────────────────

app.get('/signup', (req, res) => {
  const account = getAccount(req);
  if (account) return res.redirect('/dashboard');
  res.render('signup', { error: req.query.error || null });
});

app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password || password.length < 6) return res.redirect('/signup?error=Password must be at least 6 characters');
  const existing = db.prepare('SELECT id FROM accounts WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (existing) return res.redirect('/signup?error=An account with that email already exists');
  const id = genId(12);
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO accounts (id, email, password_hash, name) VALUES (?,?,?,?)').run(id, email.toLowerCase().trim(), hash, (name || '').trim());
  // Link any existing events by this email to the new account
  db.prepare('UPDATE events SET account_id = ? WHERE LOWER(organizer_email) = LOWER(?) AND account_id IS NULL').run(id, email.trim());
  // Link any existing claims by this email to the new account
  db.prepare('UPDATE claims SET account_id = ? WHERE LOWER(email) = LOWER(?) AND account_id IS NULL').run(id, email.trim());
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  setAuthCookie(res, account);
  res.redirect('/dashboard');
});

app.get('/signin', (req, res) => {
  const account = getAccount(req);
  if (account) return res.redirect('/dashboard');
  res.render('signin', { error: req.query.error || null, next: req.query.next || '' });
});

app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  const next = req.body.next || '/dashboard';
  if (!email || !password) return res.redirect('/signin?error=Email and password required');
  const account = db.prepare('SELECT * FROM accounts WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (!account || !bcrypt.compareSync(password, account.password_hash)) return res.redirect('/signin?error=Invalid email or password');
  // Link any unclaimed claims to this account
  db.prepare('UPDATE claims SET account_id = ? WHERE LOWER(email) = LOWER(?) AND account_id IS NULL').run(account.id, account.email);
  setAuthCookie(res, account);
  // Prevent open redirect — only allow local paths
  const safePath = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/dashboard';
  res.redirect(safePath);
});

app.get('/signout', (req, res) => { res.clearCookie('gr_auth'); res.redirect('/'); });

// ── Password Reset ────────────────────────────────────────────────────────────

// Rate limiter: 5 requests per hour per IP
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { sent: req.query.sent, error: req.query.error });
});

app.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) return res.redirect('/forgot-password?error=Email is required');

  const account = db.prepare('SELECT * FROM accounts WHERE LOWER(email) = LOWER(?)').get(email.trim());
  
  // Always show success message (prevent email enumeration)
  if (!account) {
    return res.redirect('/forgot-password?sent=1');
  }

  // Generate reset token (1 hour expiry)
  const resetToken = genSecureToken(32);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now

  db.prepare('INSERT INTO password_reset_tokens (token, email, expires_at) VALUES (?, ?, ?)')
    .run(resetToken, account.email, expiresAt);

  // Send reset email
  const resetUrl = `${BASE_URL}/reset-password?token=${resetToken}`;
  await sendEmail(account.email,
    'Reset your GetRallied password',
    `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
      <img src="${BASE_URL}/logo.png" alt="GetRallied" style="height:40px;margin-bottom:24px;display:block">
      <h2 style="font-size:20px;font-weight:800;color:#111;margin-bottom:12px">Reset your password</h2>
      <p style="color:#555;line-height:1.6;margin-bottom:20px">You requested a password reset for your GetRallied account.</p>
      <p style="margin-bottom:24px">
        <a href="${resetUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;font-weight:700;font-size:14px;text-decoration:none;border-radius:4px">Reset password →</a>
      </p>
      <p style="color:#999;font-size:13px;line-height:1.6">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      <p style="color:#bbb;font-size:12px;margin-top:20px">Or copy this link: ${resetUrl}</p>
    </div>`
  );

  res.redirect('/forgot-password?sent=1');
});

app.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/signin?error=Invalid reset link');

  const resetToken = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(token);
  if (!resetToken) return res.redirect('/signin?error=Invalid or expired reset link');

  // Check if token is expired
  if (new Date(resetToken.expires_at) < new Date()) {
    return res.redirect('/signin?error=Reset link has expired');
  }

  res.render('reset-password', { token, error: req.query.error });
});

app.post('/reset-password', async (req, res) => {
  const { token, password, password_confirm } = req.body;
  if (!token || !password) return res.redirect(`/reset-password?token=${token}&error=All fields required`);
  if (password !== password_confirm) return res.redirect(`/reset-password?token=${token}&error=Passwords do not match`);
  if (password.length < 8) return res.redirect(`/reset-password?token=${token}&error=Password must be at least 8 characters`);

  const resetToken = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(token);
  if (!resetToken || new Date(resetToken.expires_at) < new Date()) {
    return res.redirect('/signin?error=Invalid or expired reset link');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE LOWER(email) = LOWER(?)').get(resetToken.email);
  if (!account) return res.redirect('/signin?error=Account not found');

  // Update password
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, account.id);

  // Mark token as used
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);

  // Auto sign in
  setAuthCookie(res, account);
  res.redirect('/dashboard?reset=1');
});

app.get('/dashboard', requireAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE account_id = ? OR LOWER(organizer_email) = LOWER(?) ORDER BY created_at DESC').all(req.account.id, req.account.email);
  // Stats for each event
  const eventData = events.map(e => {
    const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ?').all(e.id);
    const claimCount = db.prepare("SELECT COUNT(*) as c FROM claims WHERE event_id = ? AND status != 'denied'").get(e.id).c;
    const pendingCount = db.prepare("SELECT COUNT(*) as c FROM claims WHERE event_id = ? AND status = 'pending'").get(e.id).c;
    const totalNeeded = tasks.filter(t => t.quantity_needed > 0).reduce((s, t) => s + t.quantity_needed, 0);
    const totalClaimed = tasks.filter(t => t.quantity_needed > 0).reduce((s, t) => s + t.quantity_claimed, 0);
    return { ...e, taskCount: tasks.length, claimCount, pendingCount, totalNeeded, totalClaimed };
  });
  res.render('dashboard', { account: req.account, events: eventData });
});


// ── Account Settings ──────────────────────────────────────────────────────────

app.get('/account', requireAuth, (req, res) => {
  res.render('account', { account: req.account, saved: req.query.saved, error: req.query.error, _navActive: 'account' });
});

app.post('/account', requireAuth, (req, res) => {
  const { name, email } = req.body;
  if (!email || !email.trim()) return res.redirect('/account?error=Email is required');
  // Check if email is taken by another account
  const existing = db.prepare('SELECT id FROM accounts WHERE LOWER(email) = LOWER(?) AND id != ?').get(email.trim(), req.account.id);
  if (existing) return res.redirect('/account?error=That email is already in use');
  db.prepare('UPDATE accounts SET name = ?, email = ? WHERE id = ?').run((name || '').trim(), email.toLowerCase().trim(), req.account.id);
  // Update auth cookie with new email
  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.account.id);
  setAuthCookie(res, updated);
  res.redirect('/account?saved=1');
});

app.post('/account/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.redirect('/account?error=All password fields are required');
  if (!bcrypt.compareSync(current_password, req.account.password_hash)) return res.redirect('/account?error=Current password is incorrect');
  if (new_password.length < 6) return res.redirect('/account?error=New password must be at least 6 characters');
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, req.account.id);
  res.redirect('/account?saved=1');
});

app.post('/account/photo', requireAuth, (req, res) => {
  const upload = require('multer')({ dest: 'public/uploads/', limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (r, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype))
  }).single('photo');
  upload(req, res, (err) => {
    if (err) return res.redirect('/account?error=Upload failed');
    if (!req.file) return res.redirect('/account?error=No image selected');
    const ext = req.file.originalname.split('.').pop();
    const newPath = 'public/uploads/profile_' + req.account.id + '.' + ext;
    require('fs').renameSync(req.file.path, newPath);
    const url = '/uploads/profile_' + req.account.id + '.' + ext;
    db.prepare('UPDATE accounts SET profile_pic = ? WHERE id = ?').run(url, req.account.id);
    res.redirect('/account?saved=1');
  });
});

// Delete account and all associated data
app.post('/account/delete', requireAuth, (req, res) => {
  const { confirm_email } = req.body;
  if (!confirm_email || confirm_email.toLowerCase().trim() !== req.account.email.toLowerCase()) {
    return res.redirect('/account?error=Email confirmation did not match');
  }
  // Delete all claims by this account
  db.prepare('DELETE FROM claims WHERE account_id = ?').run(req.account.id);
  // Delete all event updates for events owned by this account
  const events = db.prepare('SELECT id FROM events WHERE account_id = ?').all(req.account.id);
  for (const e of events) {
    db.prepare('DELETE FROM event_updates WHERE event_id = ?').run(e.id);
    db.prepare('DELETE FROM claims WHERE event_id = ?').run(e.id);
    db.prepare('DELETE FROM tasks WHERE event_id = ?').run(e.id);
  }
  db.prepare('DELETE FROM events WHERE account_id = ?').run(req.account.id);
  // Delete profile photo
  if (req.account.profile_pic) {
    try { require('fs').unlinkSync('public' + req.account.profile_pic); } catch(e) {}
  }
  // Delete the account
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.account.id);
  res.clearCookie('gr_auth');
  res.redirect('/?deleted=1');
});

app.post('/account/photo/remove', requireAuth, (req, res) => {
  const pic = req.account.profile_pic;
  if (pic) {
    try { require('fs').unlinkSync('public' + pic); } catch(e) {}
    db.prepare('UPDATE accounts SET profile_pic = NULL WHERE id = ?').run(req.account.id);
  }
  res.redirect('/account?saved=1');
});

// ── My Claims (volunteer lookup) ────────────────────────────────────────────
app.get('/my-claims', requireAuth, (req, res) => {
  const claims = db.prepare(`
    SELECT c.*, t.title as task_title, t.description as task_desc,
           e.title as event_title, e.date as event_date, e.location as event_location,
           e.id as event_id, e.event_time, e.location_name, e.banner_image
    FROM claims c
    JOIN tasks t ON c.task_id = t.id
    JOIN events e ON c.event_id = e.id
    WHERE c.account_id = ? AND c.status != 'denied'
    ORDER BY e.date DESC, c.created_at DESC
  `).all(req.account.id);
  res.render('my-claims', { claims, account: req.account });
});

app.get('/explore', (req, res) => {
  const q = req.query.q || '';
  const sort = req.query.sort || 'newest';
  let query = "SELECT * FROM events WHERE is_private = 0 AND (status IS NULL OR status = 'active') AND (date_iso IS NULL OR date_iso >= date('now', '-1 day'))";
  const params = [];
  if (q) {
    query += " AND (LOWER(title) LIKE ? OR LOWER(location) LIKE ? OR LOWER(vision) LIKE ?)";
    const like = '%' + q.toLowerCase() + '%';
    params.push(like, like, like);
  }
  switch(sort) {
    case 'soonest': query += " ORDER BY COALESCE(date_iso, '9999-12-31') ASC"; break;
    case 'upcoming': query += " AND (date_iso IS NULL OR date_iso >= date('now')) ORDER BY COALESCE(date_iso, '9999-12-31') ASC"; break;
    case 'popular': query += " ORDER BY (SELECT COUNT(*) FROM claims WHERE claims.event_id = events.id AND status != 'denied') DESC"; break;
    default: query += " ORDER BY created_at DESC";
  }
  const events = db.prepare(query).all(...params);
  const eventData = events.map(e => {
    const tasks = db.prepare('SELECT * FROM tasks WHERE event_id = ?').all(e.id);
    const claimCount = db.prepare("SELECT COUNT(*) as c FROM claims WHERE event_id = ? AND status != 'denied'").get(e.id).c;
    const totalNeeded = tasks.filter(t => t.quantity_needed > 0).reduce((s, t) => s + t.quantity_needed, 0);
    const totalClaimed = tasks.filter(t => t.quantity_needed > 0).reduce((s, t) => s + t.quantity_claimed, 0);
    return { ...e, taskCount: tasks.length, claimCount, totalNeeded, totalClaimed };
  });
  const account = getAccount(req);
  res.render('explore', { events: eventData, q, sort, account });
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

function adminAuth(req, res, next) {
  if (!ADMIN_PASS) return res.status(503).send('Admin panel disabled — set ADMIN_PASS env var');
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return res.set('WWW-Authenticate','Basic realm="GetRallied Admin"').status(401).send('Unauthorized');
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  const passHash = crypto.createHash('sha256').update(pass).digest();
  const expectedHash = crypto.createHash('sha256').update(ADMIN_PASS).digest();
  if (user === (process.env.ADMIN_USER || 'admin') && pass.length > 0 && crypto.timingSafeEqual(passHash, expectedHash)) return next();
  return res.set('WWW-Authenticate','Basic realm="GetRallied Admin"').status(401).send('Unauthorized');
}

app.use('/admin', adminLimiter);

app.get('/admin', adminAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  const taskStats = db.prepare('SELECT event_id, COUNT(*) as total, SUM(CASE WHEN quantity_needed > 0 THEN quantity_needed ELSE 0 END) as needed, SUM(CASE WHEN quantity_needed > 0 THEN quantity_claimed ELSE 0 END) as claimed FROM tasks GROUP BY event_id').all();
  const claimStats = db.prepare("SELECT event_id, COUNT(*) as total FROM claims WHERE status != 'denied' GROUP BY event_id").all();
  const pendingStats = db.prepare("SELECT event_id, COUNT(*) as total FROM claims WHERE status = 'pending' GROUP BY event_id").all();
  const taskMap = {}; taskStats.forEach(t => taskMap[t.event_id] = t);
  const claimMap = {}; claimStats.forEach(c => claimMap[c.event_id] = c.total);
  const pendingMap = {}; pendingStats.forEach(p => pendingMap[p.event_id] = p.total);
  res.render('admin', { events, taskMap, claimMap, pendingMap, baseUrl: BASE_URL, account: getAccount(req) });
});

// Global error handler — never leak stack traces
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).send('Something went wrong. Please try again.');
});

// Prune expired magic tokens every hour
setInterval(() => {
  try {
    db.prepare("DELETE FROM magic_tokens WHERE used = 1 OR expires_at < datetime('now')").run();
  } catch(e) {}
}, 60 * 60 * 1000);

app.listen(PORT, '127.0.0.1', () => console.log(`GetRallied running on port ${PORT}`));
