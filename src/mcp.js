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
  }, async ({ limit, unread_only, q }) => json({ data: listChats({ limit: limit || 40, unreadOnly: !!unread_only, q: q || '' }) }));

  server.registerTool('personal_messages', {
    title: 'Read a personal WhatsApp chat',
    description: 'Messages in one personal WhatsApp chat, oldest to newest.',
    inputSchema: {
      chat_id: z.string().describe('Chat id from personal_chats'),
      limit: z.number().int().min(1).max(200).optional().describe('How many recent messages (default 30)')
    },
    annotations: { readOnlyHint: true }
  }, async ({ chat_id, limit }) => json({ data: listMessages(chat_id, limit || 30) }));

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

  for (const [pre, M, label] of [['business', B, 'business']]) {
    server.registerTool(`${pre}_status`, { title: `${label} WhatsApp status`, description: `Whether the ${label} WhatsApp is linked, plus chat and unread counts.`, inputSchema: {}, annotations: { readOnlyHint: true } }, async () => { const s = M.personalStatus(); delete s.qr; return json(s); });
    server.registerTool(`${pre}_chats`, { title: `List ${label} WhatsApp chats`, description: `${label} WhatsApp chats, most recent first, with saved names, numbers, unread counts and the last message.`, inputSchema: { limit: z.number().int().min(1).max(200).optional(), unread_only: z.boolean().optional(), q: z.string().optional().describe('Search by name or number') }, annotations: { readOnlyHint: true } }, async ({ limit, unread_only, q }) => json({ data: M.listChats({ limit: limit || 40, unreadOnly: !!unread_only, q: q || '' }) }));
    server.registerTool(`${pre}_messages`, { title: `Read a ${label} WhatsApp chat`, description: `Messages in one ${label} WhatsApp chat, oldest to newest.`, inputSchema: { chat_id: z.string(), limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } }, async ({ chat_id, limit }) => json({ data: M.listMessages(chat_id, limit || 30) }));
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
