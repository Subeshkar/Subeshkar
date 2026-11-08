# Dioma Live

**Dream it. Done.** A personal AI assistant on WhatsApp for UAE students and young professionals.

- **WhatsApp** is the interface: message Dioma in plain words.
- **Claude** understands the request, plans the steps and uses tools.
- **Gmail and Google Calendar**: reads inbox and schedule, drafts replies and events.
- **Approval before action**: sending email or creating events triggers Approve / Cancel / Always allow buttons on WhatsApp. Per-app permissions: Ask me, Always, Off.
- **Reminders, tasks and notes** stored per user.
- **Morning brief** on WhatsApp at the user's chosen time.
- **Dashboard** at `/dashboard`: users, approvals, permissions, activity log.

Setup: see **SETUP.md**.

## Code map

| File | What it does |
| --- | --- |
| `src/server.js` | Web server, WhatsApp webhook, Google connect, dashboard routes |
| `src/agent.js` | Claude tool loop, system prompt, morning brief writer |
| `src/actions.js` | Permission checks, approvals, running approved actions |
| `src/whatsapp.js` | Sending texts, buttons, templates; 24-hour window; signature check |
| `src/google.js` | Google sign-in, Gmail read/send, Calendar read/create |
| `src/scheduler.js` | Every minute: due reminders and morning briefs |
| `src/db.js` | SQLite database |
| `src/pages.js` | Landing page and dashboard in the Dioma style |

Run locally: `npm install`, copy `.env.example` to `.env`, fill it in, `npm start`. WhatsApp needs a public URL, so local testing needs a tunnel (e.g. ngrok) or deploy to Railway.
