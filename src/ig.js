// Instagram for Dioma, WhatsApp-style: the server logs in to the owner's Instagram (unofficial private API,
// owner accepted the risk) and keeps only the session (never the password). Dioma then shows feed, DMs and
// posts, and sends DMs / comments the owner approves.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';
import { mcpToken } from './mcp.js';
const require = createRequire(import.meta.url);
const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');

const FILE = () => path.join(process.env.DATA_DIR || './data', 'ig-session.json');
let ig = null, me = null, pending = null; // pending: { kind: '2fa'|'checkpoint', username, info }
export const igToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-ig').digest('hex').slice(0, 32);
export const igSetupLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/ig/${igToken()}`;

function client(username) { const c = new IgApiClient(); c.state.generateDevice(username); return c; }
async function saveSession(c) { const st = await c.state.serialize(); delete st.constants; fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify({ username: me && me.username, state: st }), { mode: 0o600 }); }
async function resume() {
  if (ig) return ig;
  let saved; try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return null; }
  const c = client(saved.username || 'dioma'); await c.state.deserialize(saved.state);
  try { me = await c.account.currentUser(); ig = c; return ig; } catch { return null; }
}
export async function igStatus() { const c = await resume().catch(() => null); return { linked: !!c, user: me ? me.username : '', pending: pending ? pending.kind : null, setup: igSetupLink() }; }
async function need() { const c = await resume(); if (!c) throw new Error('Instagram is not connected. Open the Connect Instagram page.'); return c; }
const after = async (c) => { await saveSession(c).catch(() => {}); };

const pic = (m) => { const it = m.image_versions2 || (m.carousel_media && m.carousel_media[0] && m.carousel_media[0].image_versions2); const c = it && it.candidates; return c && c.length ? (c.find((x) => x.width <= 640) || c[c.length - 1]).url : ''; };
const post = (m) => ({ id: m.id, pk: String(m.pk), code: m.code, link: m.code ? 'https://www.instagram.com/p/' + m.code + '/' : '', user: m.user && m.user.username, name: m.user && m.user.full_name, caption: (m.caption && m.caption.text || '').slice(0, 600), likes: m.like_count || 0, comments: m.comment_count || 0, at: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : '', image: pic(m), video: !!m.video_versions });

export async function igFeed(kind = 'timeline', arg = '') {
  const c = await need(); let items = [];
  if (kind === 'tag') { const f = c.feed.tags(String(arg).replace(/^#/, ''), 'top'); items = await f.items(); }
  else if (kind === 'me') { const f = c.feed.user(me.pk); items = await f.items(); }
  else if (kind === 'user') { const id = await c.user.getIdByUsername(String(arg).replace(/^@/, '')); items = await c.feed.user(id).items(); }
  else { const f = c.feed.timeline(); items = await f.items(); }
  await after(c);
  return items.filter((m) => m && m.id && !m.ad_id && !m.injected).slice(0, 24).map(post);
}
export async function igComments(mediaId) { const c = await need(); const f = c.feed.mediaComments(mediaId); const items = await f.items(); await after(c); return items.slice(0, 40).map((x) => ({ id: x.pk, user: x.user && x.user.username, text: x.text, at: x.created_at ? new Date(x.created_at * 1000).toISOString() : '' })); }
export async function igComment(mediaId, text, replyTo) { const c = await need(); const r = await c.media.comment({ mediaId, text: String(text).slice(0, 2000), replyToCommentId: replyTo || undefined }); await after(c); return { ok: true, id: r && r.pk }; }
export async function igInbox() {
  const c = await need(); const threads = await c.feed.directInbox().items(); await after(c);
  return threads.slice(0, 40).map((t) => { const last = (t.items || [])[0] || {}; return { id: t.thread_id, name: t.thread_title || (t.users || []).map((u) => u.username).join(', '), users: (t.users || []).map((u) => u.username), last: last.text || (last.item_type ? '[' + last.item_type + ']' : ''), last_from_me: me && String(last.user_id) === String(me.pk), at: last.timestamp ? new Date(Number(last.timestamp) / 1000).toISOString() : '', unread: !!(t.read_state) }; });
}
export async function igThread(id) {
  const c = await need(); const items = await c.feed.directThread({ thread_id: id, oldest_cursor: undefined }).items(); await after(c);
  return items.slice(0, 30).reverse().map((x) => ({ me: me && String(x.user_id) === String(me.pk), text: x.text || (x.item_type === 'media_share' ? '[shared a post]' : x.item_type === 'voice_media' ? '[voice message]' : '[' + x.item_type + ']'), at: x.timestamp ? new Date(Number(x.timestamp) / 1000).toISOString() : '' }));
}
export async function igSend(threadId, text) { const c = await need(); await c.entity.directThread(threadId).broadcastText(String(text).slice(0, 1000)); await after(c); return { ok: true }; }
export async function igImage(url) {
  if (!/^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(url)) return { error: 'not an Instagram image' };
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) return { error: 'image ' + r.status };
  const b = Buffer.from(await r.arrayBuffer()); return { mimetype: r.headers.get('content-type') || 'image/jpeg', data: b.toString('base64') };
}

const ok = (req, res, next) => { const a = Buffer.from(String(req.params.t)), b = Buffer.from(igToken()); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found'); next(); };
const page = (msg = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Instagram</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:520px;margin:auto}h1{font-size:22px}label{display:block;font-weight:600;margin-top:12px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:15px}button{margin-top:18px;background:#16181d;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}.w{font-size:14px;color:#6b6a64}</style></head><body><main>
<h1>Connect Instagram to Dioma</h1>${msg ? `<div class="m">${msg}</div>` : ''}
<p>${me ? '✅ Connected as @' + me.username + '.' : 'Dioma logs in once and keeps only the login session, never your password.'}</p>
${pending ? `<form method="post"><input type="hidden" name="step" value="code"><label>${pending.kind === '2fa' ? 'Code from your authenticator / SMS (two-factor)' : 'Security code Instagram sent you (SMS or email)'}<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Confirm</button></form>
<p class="w">If Instagram shows "Was this you?" in the app, tap <b>This was me</b>, then confirm here.</p>`
: `<form method="post"><label>Instagram username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Connect</button></form>
<p class="w">Unofficial login (like WhatsApp Web). Instagram may ask you to confirm it was you; open the Instagram app and approve.</p>`}
</main></body></html>`;

export function mountIg(app) {
  app.get('/ig/:t', ok, async (_req, res) => { await resume().catch(() => {}); res.set('Cache-Control', 'no-store').send(page()); });
  app.post('/ig/:t', ok, express.urlencoded({ extended: false }), async (req, res) => {
    const b = req.body || {};
    try {
      if (b.step === 'code' && pending) {
        const c = pending.client; const code = String(b.code || '').trim();
        if (pending.kind === '2fa') {
          const r = await c.account.twoFactorLogin({ username: pending.username, verificationCode: code, twoFactorIdentifier: pending.info.two_factor_identifier, verificationMethod: pending.info.totp_two_factor_on ? '0' : '1', trustThisDevice: '1' });
          me = r; } else { await c.challenge.sendSecurityCode(code); me = await c.account.currentUser(); }
        ig = c; pending = null; await saveSession(c);
        return res.send(page(`✅ Connected as @${me.username}. Close this page and open Social → Instagram in Dioma.`));
      }
      const username = String(b.username || '').trim().replace(/^@/, ''), password = String(b.password || '');
      if (!username || !password) return res.send(page('Fill in both.'));
      const c = client(username);
      try { await c.simulate.preLoginFlow(); } catch { /* optional */ }
      try { me = await c.account.login(username, password); ig = c; pending = null; await saveSession(c); return res.send(page(`✅ Connected as @${me.username}. Close this page and open Social → Instagram in Dioma.`)); }
      catch (e) {
        if (e instanceof IgLoginTwoFactorRequiredError) { pending = { kind: '2fa', username, client: c, info: e.response.body.two_factor_info }; return res.send(page('Enter your two-factor code.')); }
        if (e instanceof IgCheckpointError) { c.state.checkpoint = e.response.body; try { await c.challenge.auto(true); } catch { /* code may still come */ } pending = { kind: 'checkpoint', username, client: c }; return res.send(page('Instagram sent you a security code (SMS or email). Enter it below. If the app asks "Was this you?", tap This was me.')); }
        throw e;
      }
    } catch (e) { pending = null; res.send(page('Instagram said: ' + String((e && e.message) || e).slice(0, 200) + '. Wait a few minutes and try again; approve the login in the Instagram app if it asks.')); }
  });
}
