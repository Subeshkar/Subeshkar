// The owner's own Dioma, running on app.dioma.life with everything done on the backend.
// The same Dioma app runs here; window.claude is replaced by /shim.js, which calls these routes:
//   /api/owner/mcp     -> his own Dioma server (WhatsApp, Zoho, Books, Files) and Google (Gmail, Calendar)
//   /api/owner/sample  -> the AI (Anthropic API, server-side key)
//   /api/owner/db      -> his saved Dioma state
// Only OWNER_EMAIL can reach any of it. The app file itself is uploaded by the owner and kept on the
// private volume (never in the public repo), because it contains his contacts and business details.
import fs from 'node:fs';
import path from 'node:path';
import { DIR, one, run } from './db.js';
import * as G from './google.js';

const APP_FILE = path.join(DIR, 'owner', 'dioma.html');
fs.mkdirSync(path.dirname(APP_FILE), { recursive: true });
run('CREATE TABLE IF NOT EXISTS owner_docs (path TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)');

export const isOwner = (u) => !!u && !!process.env.OWNER_EMAIL && u.email === process.env.OWNER_EMAIL.trim().toLowerCase();
export const hasApp = () => fs.existsSync(APP_FILE);
export const saveApp = (buf) => {
  const html = buf.toString('utf8');
  if (!/<script[\s>]/i.test(html) || html.length < 1000) throw Object.assign(new Error('That does not look like the Dioma app file.'), { status: 400 });
  fs.writeFileSync(APP_FILE, html);
};
// Customers and the owner only ever see "Dioma": reword any text that names the platform underneath.
function brand(html) {
  return html
    .replace(/Dioma needs permission to use Claude on this page\. Reload and choose Allow\./g, 'Dioma\u2019s AI is starting up. Try again in a moment.')
    .replace(/claude\.ai\s*→\s*Settings\s*→\s*Connectors/g, 'Dioma settings')
    .replace(/(?:the |your )?Claude (?:desktop )?app(?:'s|\\'s)? (?:built-in )?browser/g, 'the Dioma browser')
    .replace(/Claude desktop app/g, 'Dioma app')
    .replace(/Claude app/g, 'Dioma app')
    .replace(/Claude pages/g, 'web pages')
    .replace(/\bClaude\b/g, 'Dioma');
}
export function appPage() {
  const body = brand(fs.readFileSync(APP_FILE, 'utf8'));
  // The app was written as page content; give it a document skeleton and load the shim before its own script.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000000"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/shim.js"></script></head><body>${body}</body></html>`;
}

// ---------- tools ----------
const DIOMA = 'Dioma WhatsApp', GMAIL = 'Gmail', CAL = 'Google Calendar';
const err = (code, message) => Object.assign(new Error(message), { code });
let rpcId = 0;

async function diomaServer(tool, args) {
  const url = process.env.DIOMA_MCP_URL;
  if (!url) throw err('server_not_connected', 'Your Dioma server is not linked yet.');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args || {} } }),
    signal: AbortSignal.timeout(110e3),
  });
  const text = await r.text();
  if (!r.ok) throw err('tool_error', `Dioma server ${r.status}`);
  const msg = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse((text.match(/^data: (.*)$/m) || [])[1] || '{}');
  if (msg.error) throw err('tool_error', msg.error.message || 'Dioma server error');
  const res = msg.result || {};
  if (res.isError) throw err('tool_error', (res.content || []).map((c) => c.text).join(' ') || 'Tool failed');
  let payload = res.structuredContent;
  if (payload === undefined) { try { payload = JSON.parse((res.content || []).find((c) => c.type === 'text')?.text || 'null'); } catch { payload = null; } }
  return { payload, content: res.content || [] };
}

// Gmail, shaped like the Gmail connector the app was built against.
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
const hdr = (m) => Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
const addr = (s) => String(s || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean).map((x) => { const m = x.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/); return m ? { displayName: m[1].trim(), emailAddress: m[2].trim() } : { displayName: '', emailAddress: x }; });
const b64url = (s) => Buffer.from(s, 'base64url').toString('utf8');
function partsOf(p, out = []) { if (!p) return out; out.push(p); (p.parts || []).forEach((x) => partsOf(x, out)); return out; }
function shapeMsg(m, full) {
  const h = hdr(m); const from = addr(h.from)[0] || {};
  const o = { id: m.id, threadId: m.threadId, subject: h.subject || '', snippet: m.snippet || '', date: new Date(Number(m.internalDate)).toISOString(), sender: from.emailAddress || '', addressDisplayNames: [from, ...addr(h.to)], to: h.to || '', cc: h.cc || '', labelIds: m.labelIds || [] };
  if (full) {
    const parts = partsOf(m.payload);
    const txt = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
    const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
    o.plaintextBody = txt ? b64url(txt.body.data) : html ? b64url(html.body.data).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim() : '';
    o.attachments = parts.filter((p) => p.filename && p.body?.attachmentId).map((p) => ({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size }));
  }
  return o;
}
function mime({ to, cc, subject, body, attachments, inReplyTo, references }) {
  const enc = (s) => /[^\x00-\x7f]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s;
  const head = [`To: ${[].concat(to).join(', ')}`, cc ? `Cc: ${[].concat(cc).join(', ')}` : '', `Subject: ${enc(subject || '')}`, 'MIME-Version: 1.0', inReplyTo ? `In-Reply-To: ${inReplyTo}` : '', references ? `References: ${references}` : ''].filter(Boolean);
  const text = `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body || '').toString('base64')}`;
  if (!(attachments || []).length) return Buffer.from(head.join('\r\n') + '\r\n' + text).toString('base64url');
  const b = 'dioma' + Date.now().toString(36);
  const files = attachments.map((a) => `--${b}\r\nContent-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${String(a.content || '').replace(/(.{76})/g, '$1\r\n')}`);
  return Buffer.from(`${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${text}\r\n${files.join('\r\n')}\r\n--${b}--`).toString('base64url');
}
async function gmail(uid, tool, a) {
  const g = (u, o) => G.gfetch(uid, u, o);
  if (tool === 'search_threads') {
    const l = await g(`${GM}/threads?${new URLSearchParams({ q: a.query || 'in:inbox', maxResults: String(Math.min(a.pageSize || 10, 25)) })}`);
    const threads = await Promise.all((l.threads || []).map(async (t) => {
      const d = await g(`${GM}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`);
      return { id: t.id, snippet: t.snippet, messages: (d.messages || []).map((m) => shapeMsg(m)) };
    }));
    return { threads, nextPageToken: l.nextPageToken };
  }
  if (tool === 'get_thread') {
    const d = await g(`${GM}/threads/${encodeURIComponent(a.threadId)}?format=${a.messageFormat === 'MINIMAL' ? 'full' : 'full'}`);
    return { id: d.id, messages: (d.messages || []).map((m) => shapeMsg(m, true)) };
  }
  if (tool === 'download_gmail_attachment') {
    const d = await g(`${GM}/messages/${encodeURIComponent(a.messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`);
    return { filename: a.filename, mimeType: a.mimeType, data: Buffer.from(d.data || '', 'base64url').toString('base64') };
  }
  if (tool === 'send_message') {
    let extra = {};
    if (a.replyThreadId) {
      const t = await g(`${GM}/threads/${encodeURIComponent(a.replyThreadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
      const last = (t.messages || []).slice(-1)[0]; const h = last ? hdr(last) : {};
      extra = { threadId: a.replyThreadId, inReplyTo: h['message-id'], references: [h.references, h['message-id']].filter(Boolean).join(' ') };
    }
    const r = await g(`${GM}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: mime({ to: a.to, cc: a.cc, subject: a.subject, body: a.body, attachments: a.attachments, ...extra }), ...(extra.threadId ? { threadId: extra.threadId } : {}) }) });
    return { id: r.id, threadId: r.threadId, sent: true };
  }
  if (tool === 'reply') {
    const m = await g(`${GM}/messages/${encodeURIComponent(a.messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    const h = hdr(m);
    const me = (await g(`${GM}/profile`)).emailAddress?.toLowerCase();
    const to = addr(h['reply-to'] || h.from).map((x) => x.emailAddress);
    const cc = a.replyAll ? [...addr(h.to), ...addr(h.cc)].map((x) => x.emailAddress).filter((e) => e.toLowerCase() !== me && !to.includes(e)) : [];
    const subject = /^re:/i.test(h.subject || '') ? h.subject : `Re: ${h.subject || ''}`;
    const r = await g(`${GM}/messages/send`, { method: 'POST', body: JSON.stringify({ threadId: m.threadId, raw: mime({ to, cc: cc.length ? cc : undefined, subject, body: a.body, attachments: a.attachments, inReplyTo: h['message-id'], references: [h.references, h['message-id']].filter(Boolean).join(' ') }) }) });
    return { id: r.id, threadId: r.threadId, sent: true };
  }
  throw err('tool_not_found', `Gmail ${tool} is not available here yet.`);
}

const CALAPI = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
async function calendar(uid, tz, tool, a) {
  const fix = (t) => (t && !/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t + G.dayWindow(tz).min.slice(19) : t);
  if (tool === 'list_events') {
    const d = await G.gfetch(uid, `${CALAPI}?${new URLSearchParams({ timeMin: fix(a.startTime), timeMax: fix(a.endTime), singleEvents: 'true', orderBy: 'startTime', maxResults: String(a.pageSize || 40) })}`);
    return { events: d.items || [] };
  }
  if (tool === 'create_event') {
    const ev = { summary: a.summary, location: a.location, description: a.description, start: { dateTime: fix(a.startTime), timeZone: tz }, end: { dateTime: fix(a.endTime), timeZone: tz }, attendees: a.attendees,
      ...(a.addGoogleMeetUrl ? { conferenceData: { createRequest: { requestId: 'dioma' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}) };
    return G.gfetch(uid, `${CALAPI}?conferenceDataVersion=1&sendUpdates=all`, { method: 'POST', body: JSON.stringify(ev) });
  }
  throw err('tool_not_found', `Calendar ${tool} is not available here yet.`);
}

export async function callTool(u, server, tool, input) {
  if (server === DIOMA) return diomaServer(tool, input);
  if (server === GMAIL) { const p = await gmail(u.id, tool, input || {}); return { payload: p, content: [{ type: 'text', text: JSON.stringify(p).slice(0, 20000) }] }; }
  if (server === CAL) { const p = await calendar(u.id, u.tz, tool, input || {}); return { payload: p, content: [{ type: 'text', text: JSON.stringify(p).slice(0, 20000) }] }; }
  throw err('server_not_connected', `${server} is not connected on app.dioma.life yet.`);
}

// ---------- AI ----------
const MODELS = { quick: () => process.env.DIOMA_MODEL_QUICK || 'claude-haiku-5-5', default: () => process.env.DIOMA_MODEL || 'claude-sonnet-5-5', complex: () => process.env.DIOMA_MODEL_COMPLEX || 'claude-opus-5-5' };
export async function sample({ messages, system, tools, modelTier, max_tokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw err('not_granted', 'The AI is not switched on yet (no key).');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: (MODELS[modelTier] || MODELS.default)(), max_tokens: Math.min(Number(max_tokens) || 4000, 8000), ...(system ? { system } : {}), messages, ...(tools?.length ? { tools } : {}) }),
    signal: AbortSignal.timeout(170e3),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw err('rate_limited', 'The AI is busy. Try again in a moment.');
  if (!r.ok) throw err('model_error', j?.error?.message || `AI ${r.status}`);
  return { content: j.content, stop_reason: j.stop_reason };
}

// ---------- saved state ----------
export const dbGet = (p) => { const d = one('SELECT body FROM owner_docs WHERE path = ?', p); return d ? JSON.parse(d.body) : null; };
export const dbSet = (p, body, merge) => {
  const next = merge ? { ...(dbGet(p) || {}), ...body } : body;
  run('INSERT INTO owner_docs (path, body, at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET body = excluded.body, at = excluded.at', p, JSON.stringify(next), Date.now());
};
