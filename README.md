# GetRallied

**Organize anything. Together.**

Describe your vision. AI breaks it into tasks. People commit and show up knowing their role. Any event. Any cause.

---

## What It Does

You have a block party, a protest, a neighborhood cleanup — whatever. You shouldn't need a project manager to pull it off.

GetRallied takes your vision and turns it into a structured task registry. Share one link. People see what needs doing, claim a task, and show up ready.

## Features

- 🧠 **AI task breakdown** — Describe your event vision, Claude generates 6-16 specific, categorized tasks
- 📋 **Claimable tasks** — People browse and commit to what they can do
- ✅ **Approval workflow** — Some tasks auto-approve, leadership roles need organizer sign-off
- 🔗 **One link to share** — QR code included, works on any device
- 📧 **Email notifications** — Organizer gets notified on every claim, claimants get confirmation
- 🔒 **Public or private** — Toggle event visibility
- 🔑 **Magic link login** — Organizers access their dashboard via email, no passwords
- 📤 **CSV export** — Download your full volunteer list
- 🖼️ **Custom branding** — Upload event logo and banner
- 🎯 **Admin panel** — Overview of all events, tasks, and people

## Quick Start

```bash
git clone https://github.com/getrallied/getrallied.git
cd getrallied
npm install
cp .env.example .env
# Edit .env with your API keys
npm start
```

Open `http://localhost:19100` — you're live.

### Docker

```bash
cp .env.example .env
# Edit .env
docker compose up -d
```

## How It Works

### 1. Describe your vision
*"I want to organize a neighborhood cleanup on March 28. We need people to bring tools, handle refreshments, coordinate with the city, and manage sign-in."*

### 2. AI breaks it down
GetRallied generates specific tasks:
- 🧹 Bring rakes and trash bags (5 needed)
- 🍕 Handle food and drinks (2 needed)
- 📋 Manage check-in table (1 needed, requires approval)
- 🚛 Coordinate city dumpster drop-off (1 needed, requires approval)
- ...and more

### 3. People claim and commit
Share one link. Volunteers see the full task list, claim what they can do, and get confirmation. Organizer sees everything on their dashboard.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 19100) |
| `BASE_URL` | Yes* | Public URL (default: http://localhost:PORT) |
| `ANTHROPIC_KEY` | Yes | Claude API key for AI task breakdown |
| `BREVO_KEY` | No | Brevo API key for email notifications |
| `BREVO_LIST_ID` | No | Brevo contact list ID for waitlist signups |
| `NOTIFY_EMAIL` | No | Fallback email for organizer notifications |
| `ADMIN_USER` | No | Admin dashboard username (default: admin) |
| `ADMIN_PASS` | Yes** | Admin dashboard password |
| `DB_PATH` | No | SQLite database path (default: ./data/getrallied.db) |

\* Required for email links to work correctly in production  
\** Required to access /admin

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** SQLite (better-sqlite3) — zero config, single file
- **Templates:** EJS
- **AI:** Claude (Anthropic API) — task breakdown
- **Email:** Brevo (optional)
- **Style:** Vanilla CSS, Inter font, black & white minimal design

No build step. No React. No webpack. Just a server that runs.

## Project Structure

```
getrallied/
├── server.js           # The entire app (~640 lines)
├── views/
│   ├── home.ejs        # Landing page
│   ├── event.ejs       # Public event page
│   ├── organizer.ejs   # Organizer dashboard
│   ├── admin.ejs       # Admin panel
│   ├── login.ejs       # Magic link login
│   └── event-picker.ejs
├── public/
│   ├── logo.png
│   └── uploads/        # Event images
├── data/
│   └── getrallied.db   # SQLite database (auto-created)
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Contributing

PRs welcome. Keep it simple — this is intentionally a single-file server. If your change needs a build step, it probably doesn't belong here.

1. Fork it
2. Create your branch (`git checkout -b feature/my-thing`)
3. Commit (`git commit -am 'Add my thing'`)
4. Push (`git push origin feature/my-thing`)
5. Open a PR

## License

MIT — do whatever you want with it.

---

**GetRallied** — built for people who organize things.
