import 'dotenv/config';
import express from 'express';
import { getUser, updateUser, setPerm, alreadyProcessed, logActivity } from './db.js';
import { sendText, markRead, verifySignature, sendProactive } from './whatsapp.js';
import { handleMessage, sendApprovals, writeBrief } from './agent.js';
import { decide } from './actions.js';
import { authUrl, readState, finishAuth } from './google.js';
import { startScheduler } from './scheduler.js';
import { landingPage, dashboardPage, messagePage } from './pages.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

const allowed = (process.env.ALLOWED_NUMBERS || '').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean);
const isAllowed = (phone) => !allowed.length || allowed.includes(phone);

// ---------- Public pages ----------
app.get('/', (_req, res) => res.send(landingPage()));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- WhatsApp webhook ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // answer Meta fast, then work
  const entries = req.body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contactName = value.contacts?.[0]?.profile?.name;
      for (const msg of value.messages || []) {
        processIncoming(msg, contactName).catch((e) => console.error('Process error', e));
      }
    }
  }
});

async function processIncoming(msg, contactName) {
  if (alreadyProcessed(msg.id)) return;
  const phone = msg.from;
  if (!isAllowed(phone)) {
    await sendText(phone, 'Dioma is in private preview. Ask the founder for access.');
    return;
  }
  const user = getUser(phone);
  updateUser(phone, { last_inbound: Date.now(), ...(contactName && !user.name ? { name: contactName } : {}) });
  markRead(msg.id);

  // Approve / Cancel / Always buttons
  const buttonId = msg.interactive?.button_reply?.id || msg.button?.payload;
  if (buttonId && buttonId.includes(':')) {
    const [decision, id] = buttonId.split(':');
    await decide(id, decision);
    return;
  }

  let text = msg.text?.body;
  if (!text && msg.type === 'interactive') text = msg.interactive?.list_reply?.title;
  if (!text) {
    await sendText(phone, 'I can read text messages for now. Voice notes and photos are coming next.');
    return;
  }

  try {
    const { reply, actionIds } = await handleMessage(phone, text.slice(0, 4000));
    await sendText(phone, reply);
    await sendApprovals(actionIds);
  } catch (e) {
    console.error('Agent error', e);
    await sendText(phone, 'Sorry, something went wrong on my side. Please try again in a moment.');
  }
}

// ---------- Google connect ----------
app.get('/auth/google', (req, res) => {
  const phone = readState(req.query.state);
  if (!phone) return res.status(400).send(messagePage('Link expired', 'Ask Dioma on WhatsApp for a new connect link.', false));
  res.redirect(authUrl(req.query.state));
});

app.get('/auth/google/callback', async (req, res) => {
  const phone = readState(req.query.state);
  if (!phone || !req.query.code) return res.status(400).send(messagePage('Link expired', 'Ask Dioma on WhatsApp for a new connect link.', false));
  try {
    const email = await finishAuth(phone, String(req.query.code));
    logActivity(phone, `Connected Google${email ? ` (${email})` : ''}`, 'ALLOWED');
    await sendText(phone, `Google connected${email ? ` (${email})` : ''}. Try: "what's on my calendar tomorrow?" or "summarise my unread emails".`).catch(() => {});
    res.send(messagePage('You are connected', 'Gmail and Google Calendar are linked. Go back to WhatsApp and tell Dioma what you need.'));
  } catch (e) {
    console.error('Google auth error', e);
    res.status(500).send(messagePage('Could not connect', 'Google did not finish the connection. Try the link again from WhatsApp.', false));
  }
});

// ---------- Dashboard (password protected) ----------
function adminOnly(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(503).send('Set ADMIN_PASSWORD to use the dashboard.');
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const given = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    if (given === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dioma dashboard"').status(401).send('Password needed.');
}

app.get('/dashboard', adminOnly, (_req, res) => res.send(dashboardPage()));
app.post('/dashboard/perm', adminOnly, (req, res) => { setPerm(req.body.phone, req.body.app, req.body.mode); res.redirect('/dashboard'); });
app.post('/dashboard/decide', adminOnly, async (req, res) => { await decide(req.body.id, req.body.decision); res.redirect('/dashboard'); });
app.post('/dashboard/brief', adminOnly, async (req, res) => {
  try {
    const user = getUser(req.body.phone);
    await sendProactive(user, await writeBrief(user));
    logActivity(user.phone, 'Morning brief (sent from dashboard)', 'SENT');
  } catch (e) { console.error(e); }
  res.redirect('/dashboard');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Dioma running on port ${port}`);
  startScheduler();
});
