// Each customer connects their OWN Google account (read-only Gmail + Calendar).
// Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PUBLIC_URL. Refresh tokens are stored encrypted (seal/open).
import { seal, open, token } from './crypto.js';
import { one, run } from './db.js';

export const OWNER_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'];
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'];
export const enabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirect = () => `${(process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '')}/auth/google/callback`;

const states = new Map(); // state -> { uid, exp }
export function authUrl(uid, extra = []) {
  const state = token(18);
  states.set(state, { uid, exp: Date.now() + 10 * 60e3 });
  const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect(), response_type: 'code', scope: [...SCOPES, ...extra].join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// Finishes Google sign-in/connect. state.uid is set when a signed-in user connects Google;
// it is null for "Continue with Google" sign-in, where the Google email picks (or creates) the account.
export async function finish(state, code, uid) {
  const s = states.get(state); states.delete(state);
  if (!s || s.exp < Date.now() || (s.uid && s.uid !== uid)) throw new Error('This link expired. Please try again.');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect(), grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(j.error_description || 'Google did not return access. Please try again.');
  let account = '';
  let verified = false;
  try { const c = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString()); account = (c.email || '').toLowerCase(); verified = !!c.email_verified; } catch {}
  if (!s.uid) {
    if (!account || !verified) throw new Error('Google did not share a verified email.');
    let u = one('SELECT id FROM users WHERE email = ?', account);
    if (!u) {
      if (one('SELECT COUNT(*) n FROM users').n >= Number(process.env.MAX_USERS || 100)) { run('INSERT OR IGNORE INTO waitlist (email, created) VALUES (?, ?)', account, Date.now()); throw Object.assign(new Error('Early access is full. You are on the waitlist.'), { waitlist: true }); }
      run('INSERT INTO users (email, created) VALUES (?, ?)', account, Date.now()); u = one('SELECT id FROM users WHERE email = ?', account);
    }
    uid = u.id;
  }
  run(`INSERT INTO connections (user_id, kind, account, secret, created) VALUES (?, 'google', ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET account = excluded.account, secret = excluded.secret, created = excluded.created`, uid, account, seal({ refresh: j.refresh_token, scope: j.scope }), Date.now());
  access.set(uid, { tok: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1e3 });
  return { uid, account };
}

export async function disconnect(uid) {
  const c = one(`SELECT secret FROM connections WHERE user_id = ? AND kind = 'google'`, uid);
  if (c) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(open(c.secret).refresh)}`, { method: 'POST' }); } catch {} }
  run(`DELETE FROM connections WHERE user_id = ? AND kind = 'google'`, uid);
  access.delete(uid); cache.delete(uid);
}

const access = new Map();
async function bearer(uid) {
  const a = access.get(uid);
  if (a && a.exp > Date.now()) return a.tok;
  const c = one(`SELECT secret FROM connections WHERE user_id = ? AND kind = 'google'`, uid);
  if (!c) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: open(c.secret).refresh, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) { if (j.error === 'invalid_grant') run(`DELETE FROM connections WHERE user_id = ? AND kind = 'google'`, uid); return null; }
  access.set(uid, { tok: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1e3 });
  return j.access_token;
}
export async function gfetch(uid, url, opts = {}) {
  const t = await bearer(uid);
  if (!t) throw Object.assign(new Error('Google is not connected.'), { code: 'server_not_connected' });
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `Google ${r.status}`), { code: 'tool_error' });
  return j;
}
async function gget(uid, url) {
  const t = await bearer(uid);
  if (!t) return null;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return r.json();
}

// Day window in the user's time zone.
export function dayWindow(tz, d = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = off.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const sign = m ? (m[1] === '-' ? '-' : '+') : '+';
  const iso = m ? `${sign}${m[2]}:${m[3] || '00'}` : 'Z';
  return { ymd, min: `${ymd}T00:00:00${iso}`, max: `${ymd}T23:59:59${iso}` };
}

const cache = new Map(); // uid -> { at, data }
export async function snapshot(uid, tz) {
  const c = cache.get(uid);
  if (c && Date.now() - c.at < 5 * 60e3) return c.data;
  if (!one(`SELECT 1 FROM connections WHERE user_id = ? AND kind = 'google'`, uid)) return null;
  const w = dayWindow(tz);
  const [cal, list] = await Promise.all([
    gget(uid, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: w.min, timeMax: w.max, singleEvents: 'true', orderBy: 'startTime', maxResults: '20' })}`).catch(() => null),
    gget(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread in:inbox category:primary newer_than:7d', maxResults: '12' })}`).catch(() => null),
  ]);
  const events = (cal?.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    id: e.id, title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
    allDay: !e.start?.dateTime, where: e.location || '', link: e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || '',
    who: (e.attendees || []).filter((a) => !a.self).map((a) => a.displayName || a.email).filter(Boolean).slice(0, 6).join(', '), emails: (e.attendees || []).filter((a) => !a.self && a.email).map((a) => a.email).slice(0, 20),
  }));
  const ids = (list?.messages || []).map((m) => m.id);
  const mail = (await Promise.all(ids.map((id) => gget(uid, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null))))
    .filter(Boolean).map((m) => {
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      return { id: m.id, thread: m.threadId, from: (h.from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || h.from, subject: h.subject || '(no subject)', snippet: decode(m.snippet || ''), at: Number(m.internalDate) };
    });
  const data = { events, mail, at: Date.now() };
  cache.set(uid, { at: Date.now(), data });
  return data;
}
export const forget = (uid) => cache.delete(uid);
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
