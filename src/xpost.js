// X (Twitter) posting for Dioma. The owner creates a free X developer app once and pastes its 4 keys
// on the private setup page; the server then posts tweets he approves in Dioma (X API v2, OAuth 1.0a).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpToken } from './mcp.js';

const FILE = () => path.join(process.env.DATA_DIR || './data', 'x.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } };
const store = (o) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(o), { mode: 0o600 }); };
export const xToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-x').digest('hex').slice(0, 32);
export const xSetupLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/x/${xToken()}`;
export const xStatus = () => { const c = load(); return { linked: !!c.access_token, user: c.username || '', setup: xSetupLink() }; };

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
function authHeader(c, method, url, extra = {}) {
  const o = { oauth_consumer_key: c.api_key, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: c.access_token, oauth_version: '1.0' };
  const all = { ...o, ...extra };
  const base = [method, enc(url), enc(Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&'))].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${enc(c.api_secret)}&${enc(c.access_secret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(', ');
}
async function me(c) {
  const url = 'https://api.twitter.com/2/users/me';
  const r = await fetch(url, { headers: { Authorization: authHeader(c, 'GET', url) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.title || j.detail || 'X said ' + r.status) + (r.status === 401 ? ' (check the 4 keys and that the app has Read and Write permission)' : ''));
  return j.data || {};
}
export async function xPost(text) {
  const c = load(); if (!c.access_token) throw new Error('X is not connected yet.');
  const url = 'https://api.twitter.com/2/tweets';
  const r = await fetch(url, { method: 'POST', headers: { Authorization: authHeader(c, 'POST', url), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text).slice(0, 280) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.title || 'X said ' + r.status);
  return { ok: true, id: j.data && j.data.id, url: j.data && c.username ? `https://x.com/${c.username}/status/${j.data.id}` : '' };
}

const ok = (req, res, next) => { const a = Buffer.from(String(req.params.t)), b = Buffer.from(xToken()); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found'); next(); };
const page = (msg = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect X</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:560px;margin:auto}h1{font-size:22px}li{margin:8px 0}label{display:block;font-weight:600;margin-top:12px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:15px}button{margin-top:18px;background:#16181d;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}</style></head><body><main>
<h1>Connect X (Twitter) to Dioma</h1>${msg ? `<div class="m">${msg}</div>` : ''}<p>${xStatus().linked ? '✅ Connected as @' + xStatus().user + '. Connect again below to replace it.' : 'One time, about 5 minutes. X charges about US$0.015 per post from your X developer credits (console.x.com → Credits).'}</p>
<ol><li>Open <a href="https://console.x.com" target="_blank" rel="noopener">console.x.com</a>, sign in with your X account, open <b>Apps</b> and your app (create one if there is none), and add a few dollars under <b>Credits</b>.</li>
<li>In your Project's App → <b>User authentication settings</b> → Set up: App permissions <b>Read and write</b>, Type <b>Web App</b>, Callback URL and Website: <code>https://redexgo.com</code> → Save.</li>
<li>Open <b>Keys and tokens</b>: copy the <b>API Key</b> and <b>API Key Secret</b>, then under Access Token tap <b>Generate</b> (after setting Read and write) and copy the <b>Access Token</b> and <b>Access Token Secret</b>.</li>
<li>Paste all four below and tap Connect.</li></ol>
<form method="post"><label>API Key<input name="api_key" required autocomplete="off"></label><label>API Key Secret<input name="api_secret" required autocomplete="off"></label><label>Access Token<input name="access_token" required autocomplete="off"></label><label>Access Token Secret<input name="access_secret" required autocomplete="off"></label><button>Connect</button></form></main></body></html>`;
export function mountX(app) {
  app.get('/x/:t', ok, (_req, res) => res.set('Cache-Control', 'no-store').send(page()));
  app.post('/x/:t', ok, express.urlencoded({ extended: false }), async (req, res) => {
    const c = Object.fromEntries(['api_key', 'api_secret', 'access_token', 'access_secret'].map((k) => [k, String((req.body || {})[k] || '').trim()]));
    if (Object.values(c).some((v) => !v)) return res.send(page('Please fill in all four.'));
    try { const u = await me(c); store({ ...c, username: u.username || '', name: u.name || '' }); res.send(page(`✅ Connected as @${u.username}. You can post on X from Dioma now. Close this page.`)); }
    catch (e) { res.send(page('Could not connect: ' + String(e.message || e))); }
  });
}

// Act on X posts from Dioma (each call uses X credits).
async function myId(c) { if (c.user_id) return c.user_id; const m = await me(c); c.user_id = m.id; store(c); return m.id; }
async function xCall(method, url, body) {
  const c = load(); if (!c.access_token) throw new Error('X is not connected yet.');
  const r = await fetch(url, { method, headers: { Authorization: authHeader(c, method, url), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.detail || j.title || 'X said ' + r.status) + (r.status === 402 ? ' (add credits at console.x.com)' : ''));
  return j;
}
export async function xLike(tweetId) { const c = load(); const id = await myId(c); await xCall('POST', `https://api.twitter.com/2/users/${id}/likes`, { tweet_id: String(tweetId) }); return { ok: true }; }
export async function xReply(tweetId, text) { const j = await xCall('POST', 'https://api.twitter.com/2/tweets', { text: String(text).slice(0, 280), reply: { in_reply_to_tweet_id: String(tweetId) } }); return { ok: true, id: j.data && j.data.id }; }
export async function xFollow(userId) { const c = load(); const id = await myId(c); await xCall('POST', `https://api.twitter.com/2/users/${id}/following`, { target_user_id: String(userId) }); return { ok: true }; }
export async function xSearch(q) {
  const c = load(); if (!c.access_token) throw new Error('X is not connected yet.');
  const base = 'https://api.twitter.com/2/tweets/search/recent';
  const params = { query: q + ' -is:retweet', max_results: '10', sort_order: 'relevancy', 'tweet.fields': 'public_metrics,created_at', expansions: 'author_id', 'user.fields': 'username,name,profile_image_url' };
  const url = base + '?' + Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const r = await fetch(url, { headers: { Authorization: authHeader(c, 'GET', base, params) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.detail || j.title || 'X said ' + r.status) + (r.status === 402 ? ' (add credits at console.x.com)' : ''));
  const users = Object.fromEntries(((j.includes || {}).users || []).map((u) => [u.id, u]));
  return { posts: (j.data || []).map((t) => { const u = users[t.author_id] || {}; return { id: t.id, text: t.text, at: t.created_at, likes: (t.public_metrics || {}).like_count || 0, replies: (t.public_metrics || {}).reply_count || 0, user_id: t.author_id, user: u.username || '', name: u.name || '', avatar: u.profile_image_url || '', url: `https://x.com/${u.username || 'i'}/status/${t.id}` }; }) };
}
