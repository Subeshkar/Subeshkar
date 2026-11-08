import crypto from 'node:crypto';
import { google } from 'googleapis';
import { updateUser } from './db.js';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events'
];

function oauth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
}

// Signed, expiring state so a connect link only works for the phone it was made for.
function sign(data) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(data).digest('hex').slice(0, 32);
}

export function connectLink(phone) {
  const exp = Date.now() + 30 * 60 * 1000;
  const data = `${phone}.${exp}`;
  return `${process.env.BASE_URL}/auth/google?state=${encodeURIComponent(`${data}.${sign(data)}`)}`;
}

export function readState(state) {
  const [phone, exp, sig] = String(state || '').split('.');
  if (!phone || !exp || !sig) return null;
  if (sign(`${phone}.${exp}`) !== sig || Date.now() > Number(exp)) return null;
  return phone;
}

export function authUrl(state) {
  return oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

export async function finishAuth(phone, code) {
  const client = oauth();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email = null;
  try {
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = info.data.email;
  } catch { /* email is optional */ }
  updateUser(phone, { google_tokens: JSON.stringify(tokens), google_email: email });
  return email;
}

export function isConnected(user) {
  return !!user.google_tokens;
}

function clientFor(user) {
  if (!user.google_tokens) throw new Error('GOOGLE_NOT_CONNECTED');
  const client = oauth();
  const saved = JSON.parse(user.google_tokens);
  client.setCredentials(saved);
  client.on('tokens', (t) => {
    updateUser(user.phone, { google_tokens: JSON.stringify({ ...saved, ...t }) });
  });
  return client;
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

export async function listEmails(user, { query = 'in:inbox is:unread', max = 8 } = {}) {
  const gmail = google.gmail({ version: 'v1', auth: clientFor(user) });
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: Math.min(max, 15) });
  const out = [];
  for (const m of list.data.messages || []) {
    const r = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    out.push({ id: m.id, threadId: r.data.threadId, from: header(r.data, 'From'), subject: header(r.data, 'Subject'), date: header(r.data, 'Date'), snippet: r.data.snippet });
  }
  return out;
}

function decode(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
  for (const p of part.parts || []) { const t = findText(p); if (t) return t; }
  if (part.mimeType === 'text/html' && part.body?.data) return decode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return '';
}

export async function readEmail(user, id) {
  const gmail = google.gmail({ version: 'v1', auth: clientFor(user) });
  const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return {
    id, threadId: r.data.threadId,
    from: header(r.data, 'From'), to: header(r.data, 'To'), subject: header(r.data, 'Subject'),
    date: header(r.data, 'Date'), messageId: header(r.data, 'Message-ID'),
    body: findText(r.data.payload).slice(0, 4000)
  };
}

const encodeHeader = (s) => /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

export async function sendEmail(user, { to, subject, body, replyToId }) {
  const gmail = google.gmail({ version: 'v1', auth: clientFor(user) });
  let threadId, inReplyTo;
  if (replyToId) {
    try { const orig = await readEmail(user, replyToId); threadId = orig.threadId; inReplyTo = orig.messageId; } catch { /* send as new */ }
  }
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const raw = Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
  return r.data.id;
}

export async function listEvents(user, { daysAhead = 1, fromIso } = {}) {
  const cal = google.calendar({ version: 'v3', auth: clientFor(user) });
  const start = fromIso ? new Date(fromIso) : new Date();
  const end = new Date(start.getTime() + Math.max(1, daysAhead) * 24 * 3600 * 1000);
  const r = await cal.events.list({
    calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: true, orderBy: 'startTime', maxResults: 25, timeZone: user.timezone
  });
  return (r.data.items || []).map((e) => ({
    title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || ''
  }));
}

export async function createEvent(user, { title, start, end, location, description }) {
  const cal = google.calendar({ version: 'v3', auth: clientFor(user) });
  const r = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title, location, description: description || 'Created by Dioma with your approval.',
      start: { dateTime: start, timeZone: user.timezone },
      end: { dateTime: end, timeZone: user.timezone }
    }
  });
  return r.data.htmlLink;
}
