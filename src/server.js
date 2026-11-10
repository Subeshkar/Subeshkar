import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { getUser, updateUser, setPerm, alreadyProcessed, logActivity } from './db.js';
import { sendText, markRead, verifySignature, sendProactive } from './whatsapp.js';
import { handleMessage, sendApprovals, writeBrief } from './agent.js';
import { decide } from './actions.js';
import { authUrl, readState, finishAuth } from './google.js';
import { startScheduler } from './scheduler.js';
import { landingPage, dashboardPage, messagePage, personalPage, loginPage } from './pages.js';
import { startPersonal, stopPersonal, resumePersonal, personalStatus } from './wa-personal.js';
import { startPersonal as startBusiness, stopPersonal as stopBusiness, resumePersonal as resumeBusiness, personalStatus as businessStatus } from './wa-business.js';
import { mountMcp, mcpToken } from './mcp.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
const sessionSig = (v) => crypto.createHmac('sha256', (process.env.SESSION_SECRET || 'dev-secret') + (process.env.ADMIN_PASSWORD || '')).update(v).digest('hex');
function hasSession(req) {
  const m = /(?:^|;\s*)dioma_admin=([^;]+)/.exec(req.get('cookie') || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  return Number(exp) > Date.now() && sig === sessionSig(exp);
}
function adminOnly(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (hasSession(req)) return next();
  if (!pass) return res.status(401).send(messagePage('Use your setup link', 'Open the private setup link from the server logs.', false));
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const given = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    if (given === pass) return next();
  }
  if (req.method === 'GET') return res.status(401).send(loginPage(req.originalUrl, req.query.bad === '1'));
  res.status(401).send('Password needed.');
}
// Private setup link (printed in the server logs) that logs the owner in without typing the password.
app.get('/setup/:token', (req, res) => {
  const t = mcpToken();
  if (String(req.params.token).length !== t.length || !crypto.timingSafeEqual(Buffer.from(String(req.params.token)), Buffer.from(t))) return res.status(404).send(messagePage('Link not valid', 'Ask for a new setup link.', false));
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  res.set('Set-Cookie', `dioma_admin=${encodeURIComponent(exp + '.' + sessionSig(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  res.redirect('/personal');
});
app.post('/login', (req, res) => {
  const next = String(req.body.next || '/personal');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/personal';
  if (process.env.ADMIN_PASSWORD && String(req.body.password || '').trim() === process.env.ADMIN_PASSWORD.trim()) {
    const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
    res.set('Set-Cookie', `dioma_admin=${encodeURIComponent(exp + '.' + sessionSig(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    return res.redirect(safeNext);
  }
  res.redirect(`${safeNext}${safeNext.includes('?') ? '&' : '?'}bad=1`);
});

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

// ---------- Personal WhatsApp (QR link) ----------
const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const mcpUrl = (req) => `${baseUrl(req)}/mcp/${mcpToken()}`;
app.get('/personal', adminOnly, (req, res) => res.send(personalPage(personalStatus(), mcpUrl(req), { other: ['/business', 'Business WhatsApp'] })));
app.get('/business', adminOnly, (req, res) => res.send(personalPage(businessStatus(), mcpUrl(req), { base: '/business', title: 'Business WhatsApp', phone: '', other: ['/personal', 'Personal WhatsApp'] })));
app.post('/business/pair', adminOnly, async (req, res) => { await startBusiness({ pairPhone: req.body.phone || '', restart: true }); setTimeout(() => res.redirect('/business'), 6000); });
app.post('/business/start', adminOnly, async (_req, res) => { await startBusiness({ pairPhone: '', restart: true }); setTimeout(() => res.redirect('/business'), 3000); });
app.post('/business/unlink', adminOnly, async (_req, res) => { await stopBusiness(true); res.redirect('/business'); });
app.get('/personal/status', adminOnly, (_req, res) => { const s = personalStatus(); res.json({ ...s, qr: !!s.qr }); });
app.post('/personal/start', adminOnly, async (_req, res) => { await startPersonal({ pairPhone: '', restart: true }); setTimeout(() => res.redirect('/personal'), 3000); });
app.post('/personal/pair', adminOnly, async (req, res) => { await startPersonal({ pairPhone: req.body.phone || '', restart: true }); setTimeout(() => res.redirect('/personal'), 5000); });
app.post('/personal/unlink', adminOnly, async (_req, res) => { await stopPersonal(true); res.redirect('/personal'); });
mountMcp(app);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Dioma running on port ${port}`);
  const base = (process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, '');
  console.log(`Setup link (private): ${base}/setup/${mcpToken()}`);
  startScheduler();
  resumePersonal();
  setTimeout(resumeBusiness, 4000);
});
