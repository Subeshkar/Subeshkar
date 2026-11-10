// MCP endpoint so the Dioma app (and Claude) can read and send personal WhatsApp.
// Add it in claude.ai as a custom connector: https://<your-domain>/mcp/<MCP_TOKEN>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import * as P from './wa-personal.js';
import * as B from './wa-business.js';
import { newsToday, moneyToday, trendsToday, trendPosts } from './feeds.js';
import { transcribe } from './transcribe.js';
import { talkLink, takeCommand } from './talk.js';
import { xStatus, xPost, xLike, xReply, xFollow, xSearch } from './xpost.js';
import { liStatus, liPost, liInbox, liInboxChunk, igDmSnap, igInboxSave } from './linkedin.js';
import { igapiStatus, igapiInbox, igapiThread, igapiSend, igapiMyPosts, igapiComments, igapiReply } from './igapi.js';
import { igStatus, igFeed, igComments, igComment, igInbox, igThread, igSend, igImage, igLastError } from './ig.js';
import { zohoList, zohoRead, zohoLinked, zohoSetupLink, booksSummary, booksContact, crmSummary, booksRecordPayment, booksBalances, booksInvoiceTotals } from './zoho.js';
import { uploadStatement, addTx, listTx, setCategory, clearAcct, fileText, clearFileTx, accounts } from './wealth.js';
const { personalStatus, listChats, listMessages, sendPersonal, markChatRead } = P;

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { data } : data });

function buildServer() {
  const server = new McpServer({ name: 'Dioma Personal WhatsApp', version: '0.2.0' });

  server.registerTool('personal_status', {
    title: 'Personal WhatsApp status',
    description: 'Whether the personal WhatsApp is linked, plus chat and unread counts.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => { const s = personalStatus(); delete s.qr; return json(s); });

  server.registerTool('personal_chats', {
    title: 'List personal WhatsApp chats',
    description: 'Personal WhatsApp chats, most recent first, with unread counts and the last message.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('How many chats (default 40)'),
      unread_only: z.boolean().optional().describe('Only chats with unread messages'),
      q: z.string().optional().describe('Search by name or number')
    },
    annotations: { readOnlyHint: true }
  }, async ({ limit, unread_only, q }) => {
    // Older claude.ai connector lists only know the personal_* tools; feeds ride on this one until the connector is refreshed.
    if (q === '__talk__') return json({ link: talkLink() });
    if (q === '__listatus__') return json(liStatus());
    if (q === '__liinbox__') return json(liInbox());
    if (q === '__iginbox__') return json(igDmSnap());
    if (q && q.startsWith('__igapi__:')) { const k = q.split(':')[1]; try { if (k === 'status') return json(igapiStatus()); if (k === 'inbox') return json({ data: await igapiInbox() }); if (k === 'posts') return json({ data: await igapiMyPosts() }); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (q && q.startsWith('__ig__:')) {
      const [, kind, ...rest] = q.split(':'); const arg = rest.join(':');
      try {
        if (kind === 'status') return json({ ...(await igStatus()), last_error: igLastError() });
        if (kind === 'inbox') return json({ data: await igInbox() });
        if (kind === 'feed' || kind === 'tag' || kind === 'me' || kind === 'user') return json({ data: await igFeed(kind === 'feed' ? 'timeline' : kind, arg) });
      } catch (e) { return json({ error: String((e && e.message) || e).slice(0, 300) }); }
    }
    if (q === '__xstatus__') return json(xStatus());
    if (q === '__trends__') return json(await trendsToday());
    if (q === '__trendposts__') { try { return json(await trendPosts()); } catch (e) { return json({ error: String(e.message || e), regions: [] }); } }
    if (q.startsWith('__xsearch__:')) { try { return json(await xSearch(q.slice(12))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (q && q.startsWith('__tx__:')) { const a = q.slice(7); return json(/^[\w .&:-]{1,40}$/.test(a) ? listTx(a) : { tx: [], files: [] }); }
    if (q === '__txaccts__') return json({ data: accounts() });
    if (q && q.startsWith('__opps__')) { const d = Number(q.split(':')[1]) || 300; return json({ data: P.findOpportunities({ days: d }) }); }
    if (q === '__zohostatus__') return json({ linked: zohoLinked(), setup: zohoSetupLink() });
    if (q === '__booksinv__') { try { return json(await booksInvoiceTotals()); } catch (e) { return json({ linked: true, error: String(e.message || e) }); } }
    if (q === '__booksbal__') { try { return json(await booksBalances()); } catch (e) { return json({ linked: true, error: String(e.message || e) }); } }
    if (q === '__crm__') { try { return json(await crmSummary()); } catch (e) { return json({ linked: true, error: String(e.message || e) }); } }
    if (q === '__books__') { try { return json(await booksSummary()); } catch (e) { return json({ linked: true, error: String(e.message || e) }); } }
    if (q && q.startsWith('__bookscontact__:')) { try { return json(await booksContact(q.split(':')[1])); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (q && q.startsWith('__zoho__:')) { const [, folder, ...rest] = q.split(':'); try { return json({ data: await zohoList(folder, rest.join(':')) }); } catch (e) { return json({ error: String(e.message || e), linked: zohoLinked() }); } }
    if (q && q.startsWith('__zohomsg__:')) { const [, f, m] = q.split(':'); try { return json(await zohoRead(f, m)); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (q && q.startsWith('__talkcmd__')) return json(takeCommand(q.split(':')[1]) || {});
    if (q && q.startsWith('__news__')) return json({ data: await newsToday(q.split(':')[1] || 'world') });
    if (q && q.startsWith('__money__')) return json(await moneyToday(q.split(':')[1] || 'world'));
    return json({ data: listChats({ limit: limit || 40, unreadOnly: !!unread_only, q: q || '' }) });
  });

  server.registerTool('personal_messages', {
    title: 'Read a personal WhatsApp chat',
    description: 'Messages in one personal WhatsApp chat, oldest to newest.',
    inputSchema: {
      chat_id: z.string().describe('Chat id from personal_chats'),
      limit: z.number().int().min(1).max(200).optional().describe('How many recent messages (default 30)')
    },
    annotations: { readOnlyHint: true }
  }, async ({ chat_id, limit }) => {
    // '__media__|<chat>|<message id>' returns that file (base64) until the connector tool list is refreshed.
    // '__stt__|<mimetype>|<base64 audio>' turns a recording into text (voice commands for the Dioma AI).
    if (chat_id.startsWith('__stt__|')) {
      const i = chat_id.indexOf('|', 8); const mime = chat_id.slice(8, i); const buf = Buffer.from(chat_id.slice(i + 1), 'base64');
      if (!buf.length || buf.length > 12 * 1024 * 1024) return json({ error: 'Recording is empty or too long.' });
      try { return json({ text: await transcribe(buf, mime) }); } catch (e) { return json({ error: String(e.message || e) }); }
    }
    // Wealth (bank statements) and Zoho Books payments ride on this tool until the connector list is refreshed.
    if (chat_id.startsWith('__stmt__|')) { const [, acct, name, b64] = chat_id.split('|'); try { return json(await uploadStatement(acct, decodeURIComponent(name), b64)); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__txadd__|')) { const p = chat_id.split('|'); try { return json(addTx(p[1], JSON.parse(p.slice(3).join('|')), decodeURIComponent(p[2] || ''))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__txcat__|')) { const [, id, cat] = chat_id.split('|'); return json(setCategory(id, decodeURIComponent(cat))); }
    if (chat_id.startsWith('__txclear__|')) { return json(clearAcct(chat_id.split('|')[1])); }
    if (chat_id.startsWith('__txfiletext__|')) { const [, a, n] = chat_id.split('|'); return json(fileText(a, decodeURIComponent(n))); }
    if (chat_id.startsWith('__txclearfile__|')) { const [, a, n] = chat_id.split('|'); return json(clearFileTx(a, decodeURIComponent(n))); }
    if (chat_id.startsWith('__bookspay__|')) { try { return json(await booksRecordPayment(JSON.parse(chat_id.slice(13)))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__xact__|')) { const [, act, id, ...rest] = chat_id.split('|'); try { return json(act === 'like' ? await xLike(id) : act === 'follow' ? await xFollow(id) : act === 'reply' ? await xReply(id, decodeURIComponent(rest.join('|'))) : { error: 'unknown action' }); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__xpost__|')) { try { return json(await xPost(decodeURIComponent(chat_id.slice(10)))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__ig')) {
      const p = chat_id.split('|');
      try {
        if (p[0] === '__igthread__') return json({ data: await igThread(p[1]) });
        if (p[0] === '__igsend__') return json(await igSend(p[1], decodeURIComponent(p.slice(2).join('|'))));
        if (p[0] === '__igcomments__') return json({ data: await igComments(p[1]) });
        if (p[0] === '__igcomment__') return json(await igComment(p[1], decodeURIComponent(p.slice(3).join('|')), p[2] || ''));
        if (p[0] === '__igimg__') return json(await igImage(decodeURIComponent(p.slice(1).join('|'))));
      } catch (e) { return json({ error: String((e && e.message) || e).slice(0, 300) }); }
    }
    if (chat_id.startsWith('__igapi')) { const p = chat_id.split('|'); try { if (p[0] === '__igapithread__') return json({ data: await igapiThread(p[1]) }); if (p[0] === '__igapisend__') return json(await igapiSend(p[1], decodeURIComponent(p.slice(2).join('|')))); if (p[0] === '__igapicomments__') return json({ data: await igapiComments(p[1]) }); if (p[0] === '__igapireply__') return json(await igapiReply(p[1], decodeURIComponent(p.slice(2).join('|')))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__iginboxset__|')) { try { return json(igInboxSave(chat_id.slice(15))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__liinboxchunk__|')) { const [, flags, ...rest] = chat_id.split('|'); try { return json(liInboxChunk(decodeURIComponent(rest.join('|')), { start: flags.includes('s'), done: flags.includes('d') })); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__lipost__|')) { try { return json(await liPost(decodeURIComponent(chat_id.slice(11)))); } catch (e) { return json({ error: String(e.message || e) }); } }
    if (chat_id.startsWith('__media__|')) { const [, jid, id] = chat_id.split('|'); return json(await P.getMedia(jid, id)); }
    if (chat_id.startsWith('__bmedia__|')) { const [, jid, id] = chat_id.split('|'); return json(await B.getMedia(jid, id)); }
    return json({ data: listMessages(chat_id, limit || 30) });
  });

  server.registerTool('personal_mark_read', {
    title: 'Mark personal chat read in Dioma',
    description: 'Clears the unread badge for a chat inside Dioma.',
    inputSchema: { chat_id: z.string() }
  }, async ({ chat_id }) => { await markChatRead(chat_id); return json({ ok: true }); });

  server.registerTool('personal_send', {
    title: 'Send from personal WhatsApp',
    description: 'Sends a text message from the owner\'s personal WhatsApp. Only call after the owner approved the exact text.',
    inputSchema: {
      chat_id: z.string().describe('Chat id from personal_chats, or a phone number with country code'),
      text: z.string().min(1).max(4000)
    },
    annotations: { destructiveHint: false, openWorldHint: true }
  }, async ({ chat_id, text }) => json(await sendPersonal(chat_id, text)));

  for (const [pre, M, label] of [['personal', P, 'personal'], ['business', B, 'business']]) {
    server.registerTool(`${pre}_send_media`, { title: `Send a photo or file from ${label} WhatsApp`, description: `Sends a photo, video, voice/audio or document (base64) from the owner's ${label} WhatsApp. Only call after the owner chose the file and approved sending.`, inputSchema: { chat_id: z.string(), data: z.string().describe('File content, base64'), mimetype: z.string(), filename: z.string().optional(), caption: z.string().max(1000).optional() }, annotations: { destructiveHint: false, openWorldHint: true } }, async (a) => json(await M.sendMedia(a.chat_id, a)));
  }
  server.registerTool('news_today', { title: 'Tech and AI news today', description: 'Top AI / tech news from the last day, plus UAE tech and startup news. Each item has title, source, link and published time.', inputSchema: { topic: z.string().optional().describe('Region: uae, gcc or world') }, annotations: { readOnlyHint: true } }, async ({ topic }) => json({ data: await newsToday(topic || 'world') }));
  server.registerTool('money_today', { title: 'Funding and share prices today', description: 'Startup funding news from the last 2 days and delayed share prices for the 10 biggest companies.', inputSchema: { region: z.string().optional().describe('uae, gcc or world') }, annotations: { readOnlyHint: true } }, async ({ region }) => json(await moneyToday(region || 'world')));
  for (const [pre, M, label] of [['business', B, 'business']]) {
    server.registerTool(`${pre}_status`, { title: `${label} WhatsApp status`, description: `Whether the ${label} WhatsApp is linked, plus chat and unread counts.`, inputSchema: {}, annotations: { readOnlyHint: true } }, async () => { const s = M.personalStatus(); delete s.qr; return json(s); });
    server.registerTool(`${pre}_chats`, { title: `List ${label} WhatsApp chats`, description: `${label} WhatsApp chats, most recent first, with saved names, numbers, unread counts and the last message.`, inputSchema: { limit: z.number().int().min(1).max(200).optional(), unread_only: z.boolean().optional(), q: z.string().optional().describe('Search by name or number') }, annotations: { readOnlyHint: true } }, async ({ limit, unread_only, q }) => json({ data: M.listChats({ limit: limit || 40, unreadOnly: !!unread_only, q: q || '' }) }));
    server.registerTool(`${pre}_messages`, { title: `Read a ${label} WhatsApp chat`, description: `Messages in one ${label} WhatsApp chat, oldest to newest.`, inputSchema: { chat_id: z.string(), limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } }, async ({ chat_id, limit }) => { if (chat_id.startsWith('__media__|')) { const [, jid, id] = chat_id.split('|'); return json(await M.getMedia(jid, id)); } return json({ data: M.listMessages(chat_id, limit || 30) }); });
    server.registerTool(`${pre}_mark_read`, { title: `Mark ${label} chat read in Dioma`, description: 'Clears the unread badge for a chat inside Dioma.', inputSchema: { chat_id: z.string() } }, async ({ chat_id }) => { await M.markChatRead(chat_id); return json({ ok: true }); });
    server.registerTool(`${pre}_send`, { title: `Send from ${label} WhatsApp`, description: `Sends a text message from the owner's ${label} WhatsApp. Only call after the owner approved the exact text.`, inputSchema: { chat_id: z.string(), text: z.string().min(1).max(4000) }, annotations: { destructiveHint: false, openWorldHint: true } }, async ({ chat_id, text }) => json(await M.sendPersonal(chat_id, text)));
  }
  return server;
}

// Uses MCP_TOKEN if set, otherwise creates one once and keeps it on the data volume.
export function mcpToken() {
  if (process.env.MCP_TOKEN && process.env.MCP_TOKEN.length >= 24) return process.env.MCP_TOKEN;
  const file = path.join(process.env.DATA_DIR || './data', 'mcp-token.txt');
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t.length >= 24) return t; } catch { /* create below */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function mountMcp(app) {
  const handler = async (req, res) => {
    const token = mcpToken();
    if (!safeEqual(req.params.token, token)) return res.status(404).json({ error: 'not found' });
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    // Clients newer than this SDK send a protocol version it doesn't list; answer with the latest we speak instead of 400.
    const pv = req.get('mcp-protocol-version');
    const acc = req.get('accept') || '';
    const setHeader = (name, value) => {
      req.headers[name] = value;
      const raw = req.rawHeaders || [];
      let found = false;
      for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name) { raw[i + 1] = value; found = true; }
      if (!found) raw.push(name, value);
    };
    if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) setHeader('mcp-protocol-version', LATEST_PROTOCOL_VERSION);
    if (!acc.includes('application/json') || !acc.includes('text/event-stream')) setHeader('accept', 'application/json, text/event-stream');
    const origEnd = res.end.bind(res);
    res.end = (...a) => { if (res.statusCode >= 400) console.error('MCP', res.statusCode, 'pv=' + pv, 'accept=' + acc, 'method=' + (req.body && req.body.method), String(a[0] || '').slice(0, 200)); return origEnd(...a); };
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.all('/mcp/:token', handler);
}
