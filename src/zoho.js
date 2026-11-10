// RedexGo mail (Zoho) read access for Dioma. Zoho's Claude connector can only send, so the owner
// connects a Zoho "Self Client" here once; the server keeps the refresh token on the data volume.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpToken } from './mcp.js';

const FILE = () => path.join(process.env.DATA_DIR || './data', 'zoho.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } };
const store = (o) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(o), { mode: 0o600 }); };
const SCOPES = 'ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ';

export const zohoToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-zoho').digest('hex').slice(0, 32);
export const zohoSetupLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/zoho/${zohoToken()}`;
export const zohoLinked = () => !!load().refresh_token;

let access = null; // { token, exp }
async function accessToken() {
  const c = load(); if (!c.refresh_token) throw new Error('RedexGo mail is not connected yet.');
  if (access && access.exp > Date.now() + 60000) return access.token;
  const u = new URL(`${c.accounts || 'https://accounts.zoho.com'}/oauth/v2/token`);
  u.search = new URLSearchParams({ refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' });
  const j = await (await fetch(u, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho refused the saved login (' + (j.error || 'unknown') + '). Connect it again.');
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return access.token;
}
async function api(p) {
  const c = load();
  const res = await fetch(`${c.api || 'https://mail.zoho.com'}/api${p}`, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken() } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.status && j.status.code >= 400)) throw new Error('Zoho: ' + ((j.data && (j.data.errorCode || j.data.moreInfo)) || res.status));
  return j.data;
}
async function account() {
  const c = load(); if (c.accountId && c.folders) return c;
  const accts = await api('/accounts'); const a = accts[0];
  const folders = await api(`/accounts/${a.accountId}/folders`);
  const pick = (t) => (folders.find((f) => (f.folderType || '').toLowerCase() === t || (f.folderName || '').toLowerCase() === t) || {}).folderId;
  const n = { ...c, accountId: a.accountId, email: a.primaryEmailAddress || a.mailboxAddress, folders: { inbox: pick('inbox'), sent: pick('sent') } };
  store(n); return n;
}

// folder: action|unread|all|sent ; q: search text
export async function zohoList(folder = 'all', q = '') {
  const a = await account();
  const qs = new URLSearchParams({ limit: '40', folderId: folder === 'sent' ? a.folders.sent : a.folders.inbox });
  if (folder === 'unread') qs.set('status', 'unread');
  let rows;
  if (q) rows = await api(`/accounts/${a.accountId}/messages/search?` + new URLSearchParams({ searchKey: `entire:${q}`, limit: '40' }));
  else rows = await api(`/accounts/${a.accountId}/messages/view?` + qs);
  const de = (x) => String(x || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return (rows || []).map((m) => ({ ...m, subject: de(m.subject), summary: de(m.summary), sender: de(m.sender), toAddress: de(m.toAddress) })).map((m) => ({ id: m.messageId, folderId: m.folderId, threadId: m.threadId || m.messageId, subject: m.subject || '(no subject)', from: m.sender && m.sender !== m.fromAddress ? `${m.sender} <${m.fromAddress}>` : m.fromAddress, fromEmail: m.fromAddress, to: m.toAddress, date: m.receivedTime ? new Date(Number(m.receivedTime)).toISOString() : '', snippet: String(m.summary || '').slice(0, 300), unread: m.status === '0' || m.status === 0 }));
}
export async function zohoRead(folderId, messageId) {
  const a = await account();
  const d = await api(`/accounts/${a.accountId}/folders/${folderId}/messages/${messageId}/content`);
  const text = String(d.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  return { messageId, body: text.slice(0, 6000) };
}

const ok = (req, res, next) => {
  const a = Buffer.from(String(req.params.t)), b = Buffer.from(zohoToken());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found');
  next();
};
const page = (msg = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect RedexGo mail</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:560px;margin:auto}h1{font-size:22px}ol{padding-left:20px}li{margin:8px 0}code{background:#ece8dc;padding:2px 6px;border-radius:6px;word-break:break-all}label{display:block;font-weight:600;margin-top:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:15px}button{margin-top:18px;background:#16181d;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}</style></head><body><main>
<h1>Connect RedexGo mail to Dioma</h1>${msg ? `<div class="m">${msg}</div>` : ''}
<p>${zohoLinked() ? '✅ Connected. You can connect again below to replace it.' : 'One time, about 3 minutes.'}</p>
<ol><li>Open <a href="https://api-console.zoho.com" target="_blank" rel="noopener">api-console.zoho.com</a> and sign in as info@redexgo.com.</li>
<li>Tap <b>Add Client</b> → <b>Self Client</b> → Create → OK.</li>
<li>In <b>Generate Code</b>, paste this scope:<br><code>${SCOPES}</code><br>Time duration: <b>10 minutes</b>, description: <b>Dioma</b> → Create → choose the redexgo portal if asked → copy the code.</li>
<li>Open the <b>Client Secret</b> tab and copy the Client ID and Client Secret.</li>
<li>Paste all three below and tap Connect (within 10 minutes).</li></ol>
<form method="post"><label>Client ID<input name="client_id" required autocomplete="off"></label><label>Client Secret<input name="client_secret" required autocomplete="off"></label><label>Code<input name="code" required autocomplete="off"></label><button>Connect</button></form>
</main></body></html>`;

export function mountZoho(app) {
  app.get('/zoho/:t', ok, (_req, res) => res.set('Cache-Control', 'no-store').send(page()));
  app.post('/zoho/:t', ok, express.urlencoded({ extended: false }), async (req, res) => {
    const { client_id, client_secret, code } = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v || '').trim()]));
    if (!client_id || !client_secret || !code) return res.send(page('Please fill in all three.'));
    try {
      const u = new URL('https://accounts.zoho.com/oauth/v2/token');
      u.search = new URLSearchParams({ code, client_id, client_secret, grant_type: 'authorization_code' });
      const j = await (await fetch(u, { method: 'POST' })).json();
      if (!j.refresh_token) return res.send(page('Zoho said: ' + (j.error || 'no refresh token') + '. Make a new code (step 3) and try again quickly.'));
      const api = j.api_domain && /zohoapis\.(\w+(\.\w+)?)$/.test(j.api_domain) ? j.api_domain.replace('www.zohoapis', 'mail.zoho') : 'https://mail.zoho.com';
      store({ client_id, client_secret, refresh_token: j.refresh_token, accounts: 'https://accounts.zoho.com', api });
      access = null;
      const list = await zohoList('all');
      res.send(page(`✅ Connected. Dioma can read RedexGo mail now (${list.length} recent emails found). You can close this page.`));
    } catch (e) { res.send(page('Something went wrong: ' + String(e.message || e))); }
  });
}
