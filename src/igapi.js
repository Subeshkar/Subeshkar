// Instagram DMs the official way: Meta's "Instagram API with Instagram Login".
// The owner creates a Meta app once, generates an access token for his Instagram professional account
// and pastes it on the private setup page. Long-lived tokens (60 days) are refreshed automatically.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpToken } from './mcp.js';

const G = 'https://graph.instagram.com/v21.0';
const FILE = () => path.join(process.env.DATA_DIR || './data', 'igapi.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } };
const store = (o) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(o), { mode: 0o600 }); };
export const igapiToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-igapi').digest('hex').slice(0, 32);
export const igapiSetupLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/igapi/${igapiToken()}`;

async function call(p, opts = {}) {
  const c = load(); if (!c.token) throw new Error('Instagram messages are not connected yet.');
  if (c.refreshed && Date.now() - c.refreshed > 20 * 864e5) { try { const r = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${c.token}`)).json(); if (r.access_token) { c.token = r.access_token; c.refreshed = Date.now(); store(c); } } catch { /* keep old */ } }
  const sep = p.includes('?') ? '&' : '?';
  const res = await fetch(`${G}${p}${sep}access_token=${encodeURIComponent(c.token)}`, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('Instagram: ' + ((j.error && (j.error.error_user_msg || j.error.message)) || res.status));
  return j;
}
export function igapiStatus() { const c = load(); return { linked: !!c.token, user: c.username || '', id: c.id || '', setup: igapiSetupLink() }; }
export async function igapiInbox() {
  const j = await call('/me/conversations?platform=instagram&fields=participants,updated_time,messages.limit(1){message,from,created_time}&limit=40');
  const me = load().id;
  return (j.data || []).map((t) => { const other = (t.participants && t.participants.data || []).find((u) => String(u.id) !== String(me)) || {}; const m = (t.messages && t.messages.data || [])[0] || {}; return { id: t.id, name: other.username || 'Instagram user', user_id: other.id, last: m.message || '', last_from_me: m.from && String(m.from.id) === String(me), at: t.updated_time }; });
}
export async function igapiThread(id) {
  const j = await call(`/${id}?fields=messages.limit(30){message,from,created_time}`);
  const me = load().id;
  return ((j.messages && j.messages.data) || []).reverse().map((m) => ({ me: m.from && String(m.from.id) === String(me), text: m.message || '[attachment]', at: m.created_time }));
}
export async function igapiSend(userId, text) {
  await call('/me/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: userId }, message: { text: String(text).slice(0, 1000) } }) });
  return { ok: true };
}
export async function igapiMyPosts() {
  const j = await call('/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=20');
  return (j.data || []).map((m) => ({ id: m.id, caption: (m.caption || '').slice(0, 600), image: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url, link: m.permalink, at: m.timestamp, likes: m.like_count || 0, comments: m.comments_count || 0 }));
}
export async function igapiComments(mediaId) { const j = await call(`/${mediaId}/comments?fields=id,text,username,timestamp&limit=40`); return (j.data || []).map((c) => ({ id: c.id, user: c.username, text: c.text, at: c.timestamp })); }
export async function igapiReply(commentId, text) { await call(`/${commentId}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: String(text).slice(0, 2000) }) }); return { ok: true }; }

const ok = (req, res, next) => { const a = Buffer.from(String(req.params.t)), b = Buffer.from(igapiToken()); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found'); next(); };
const page = (msg = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Instagram messages</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:600px;margin:auto}h1{font-size:22px}li{margin:8px 0}code{background:#ece8dc;padding:2px 6px;border-radius:6px}label{display:block;font-weight:600;margin-top:12px}textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:14px;min-height:90px}button{margin-top:16px;background:#16181d;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}</style></head><body><main>
<h1>Connect Instagram messages (official)</h1>${msg ? `<div class="m">${msg}</div>` : ''}<p>${igapiStatus().linked ? '✅ Connected as @' + igapiStatus().user + '.' : 'One time, about 10 minutes. Uses Meta’s official Instagram API, so there is no ban risk.'}</p>
<ol>
<li>Open <a href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener">developers.facebook.com/apps/creation</a> (log in with your Facebook). Name: <b>Dioma</b>. Use case: <b>Manage messaging and content on Instagram</b>. Business: your RedexGo business portfolio (or none) → <b>Create app</b>.</li>
<li>In the app: <b>Instagram</b> → <b>API setup with Instagram login</b>.</li>
<li>Step <b>1. Generate access tokens</b> → <b>Add account</b> → log in as <b>cr_subesh</b> (must be a Business or Creator account) → allow everything.</li>
<li>Tap <b>Generate token</b> next to cr_subesh → tick the box → copy the long token.</li>
<li>Paste it below and tap Connect.</li></ol>
<form method="post"><label>Access token<textarea name="token" required autocomplete="off"></textarea></label><button>Connect</button></form>
<p style="font-size:14px;color:#6b6a64">While the app is in development mode it works for your own account. Instagram only lets businesses reply within 24 hours of the customer's last message.</p>
</main></body></html>`;
export function mountIgApi(app) {
  app.get('/igapi/:t', ok, (_req, res) => res.set('Cache-Control', 'no-store').send(page()));
  app.post('/igapi/:t', ok, express.urlencoded({ extended: false }), async (req, res) => {
    const token = String((req.body || {}).token || '').trim(); if (!token) return res.send(page('Paste the token.'));
    try {
      const r = await (await fetch(`${G}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`)).json();
      if (!r.username) throw new Error((r.error && r.error.message) || 'token not accepted');
      store({ token, id: r.user_id || r.id, username: r.username, refreshed: Date.now() });
      res.send(page(`✅ Connected as @${r.username}. Open Social → Instagram → Messages in Dioma.`));
    } catch (e) { res.send(page('Could not connect: ' + String(e.message || e))); }
  });
}
