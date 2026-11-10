// LinkedIn personal profile posting (official API: "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn").
// Owner creates a LinkedIn app once, pastes Client ID/Secret on the private page, then signs in with LinkedIn.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpToken } from './mcp.js';

const FILE = () => path.join(process.env.DATA_DIR || './data', 'linkedin.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } };
const store = (o) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(o), { mode: 0o600 }); };
const HOST = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}`;
export const liToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-li').digest('hex').slice(0, 32);
export const liSetupLink = () => `${HOST()}/li/${liToken()}`;
const REDIRECT = () => `${HOST()}/li-callback`;
export const liStatus = () => { const c = load(); return { linked: !!(c.access_token && c.expires > Date.now()), user: c.name || '', expires: c.expires || 0, setup: liSetupLink() }; };

export async function liPost(text) {
  const c = load(); if (!c.access_token || c.expires < Date.now()) throw new Error('LinkedIn is not connected (or the 60-day login expired). Connect again.');
  const r = await fetch('https://api.linkedin.com/v2/ugcPosts', { method: 'POST', headers: { Authorization: 'Bearer ' + c.access_token, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
    body: JSON.stringify({ author: 'urn:li:person:' + c.sub, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: String(text).slice(0, 3000) }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('LinkedIn: ' + (j.message || r.status));
  const id = r.headers.get('x-restli-id') || j.id || '';
  return { ok: true, url: id ? 'https://www.linkedin.com/feed/update/' + id + '/' : '' };
}

const ok = (req, res, next) => { const a = Buffer.from(String(req.params.t)), b = Buffer.from(liToken()); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found'); next(); };
const page = (msg = '') => { const c = load(); const st = liStatus(); return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect LinkedIn</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:600px;margin:auto}h1{font-size:22px}li{margin:8px 0}code{background:#ece8dc;padding:2px 6px;border-radius:6px;word-break:break-all}label{display:block;font-weight:600;margin-top:12px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:15px}button,.b{display:inline-block;margin-top:16px;background:#0a66c2;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600;text-decoration:none}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}</style></head><body><main>
<h1>Connect your LinkedIn profile</h1>${msg ? `<div class="m">${msg}</div>` : ''}
<p>${st.linked ? '✅ Connected as ' + st.user + ' (valid until ' + new Date(st.expires).toDateString() + ').' : 'One time, about 5 minutes. Official LinkedIn API: posts to your personal profile.'}</p>
${c.client_id ? `<a class="b" href="${liSetupLink()}/start">Sign in with LinkedIn</a><p style="font-size:14px;color:#6b6a64">App saved. Tap the button, log in to LinkedIn and Allow.</p><hr style="margin:24px 0">` : ''}
<ol><li>Open <a href="https://www.linkedin.com/developers/apps/new" target="_blank" rel="noopener">linkedin.com/developers/apps/new</a>. App name <b>Dioma</b>, LinkedIn Page: <b>RedexGo</b>, upload any logo, tick the agreement → <b>Create app</b>.</li>
<li>Tab <b>Products</b>: <b>Request access</b> on <b>Share on LinkedIn</b> and on <b>Sign In with LinkedIn using OpenID Connect</b> (both are instant).</li>
<li>Tab <b>Auth</b>: under <b>Authorized redirect URLs</b> add <code>${REDIRECT()}</code> → Update. Copy <b>Client ID</b> and <b>Primary Client Secret</b>.</li>
<li>Paste both below, Save, then tap <b>Sign in with LinkedIn</b>.</li></ol>
<form method="post"><label>Client ID<input name="client_id" required autocomplete="off" value="${c.client_id || ''}"></label><label>Client Secret<input name="client_secret" required autocomplete="off"></label><button style="background:#16181d">Save</button></form>
</main></body></html>`; };

export function mountLinkedIn(app) {
  app.get('/li/:t', ok, (_req, res) => res.set('Cache-Control', 'no-store').send(page()));
  app.post('/li/:t', ok, express.urlencoded({ extended: false }), (req, res) => {
    const id = String((req.body || {}).client_id || '').trim(), sec = String((req.body || {}).client_secret || '').trim();
    if (!id || !sec) return res.send(page('Fill in both.'));
    store({ ...load(), client_id: id, client_secret: sec }); res.send(page('Saved. Now tap “Sign in with LinkedIn”.'));
  });
  app.get('/li/:t/start', ok, (_req, res) => {
    const c = load(); if (!c.client_id) return res.send(page('Save the Client ID and Secret first.'));
    const state = crypto.createHmac('sha256', liToken()).update(String(Math.floor(Date.now() / 600000))).digest('hex').slice(0, 24);
    const u = new URL('https://www.linkedin.com/oauth/v2/authorization');
    u.search = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT(), state, scope: 'openid profile email w_member_social' });
    res.redirect(u.toString());
  });
  app.get('/li-callback', async (req, res) => {
    const okState = [0, 1].some((d) => crypto.createHmac('sha256', liToken()).update(String(Math.floor(Date.now() / 600000) - d)).digest('hex').slice(0, 24) === String(req.query.state || ''));
    if (!okState) return res.status(400).send('Link expired. Open the Connect LinkedIn page again.');
    if (req.query.error) return res.send(page('LinkedIn said: ' + String(req.query.error_description || req.query.error)));
    try {
      const c = load();
      const t = await (await fetch('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: REDIRECT(), client_id: c.client_id, client_secret: c.client_secret }) })).json();
      if (!t.access_token) throw new Error(t.error_description || t.error || 'no token');
      const me = await (await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
      store({ ...c, access_token: t.access_token, expires: Date.now() + (t.expires_in || 5184000) * 1000, sub: me.sub, name: me.name || '' });
      res.send(page(`✅ Connected as ${me.name}. Open Social → LinkedIn in Dioma to post on your profile.`));
    } catch (e) { res.send(page('Could not connect: ' + String(e.message || e))); }
  });
}
