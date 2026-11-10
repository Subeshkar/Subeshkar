// Business WhatsApp link (unofficial, via WhatsApp Web protocol / Baileys).
// The owner scans a QR code once, like linking WhatsApp Web on a laptop.
// Chats and messages are stored in SQLite so Dioma can list and read them.
// WhatsApp's terms do not allow unofficial clients: the owner accepted the ban risk.
import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, isJidGroup, downloadMediaMessage, BufferJSON } from '@whiskeysockets/baileys';
import { db } from './db.js';
import { transcribe } from './transcribe.js';

const dir = process.env.DATA_DIR || './data';
const authDir = path.join(dir, 'wa-business-auth');

db.exec(`
CREATE TABLE IF NOT EXISTS wb_chats (
  jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0, last_text TEXT, last_from_me INTEGER DEFAULT 0, last_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wb_messages (
  id TEXT, jid TEXT, from_me INTEGER, sender TEXT, sender_name TEXT, text TEXT, at INTEGER,
  PRIMARY KEY (jid, id)
);
CREATE INDEX IF NOT EXISTS wb_messages_jid_at ON wb_messages (jid, at);
CREATE TABLE IF NOT EXISTS wb_contacts (jid TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS wb_lid (lid TEXT PRIMARY KEY, pn TEXT);
CREATE TABLE IF NOT EXISTS wb_media (jid TEXT, id TEXT, kind TEXT, raw TEXT, status TEXT DEFAULT 'new', at INTEGER, PRIMARY KEY (jid, id));
`);
for (const col of ['saved TEXT', 'notify TEXT']) { try { db.exec(`ALTER TABLE wb_contacts ADD COLUMN ${col}`); } catch { /* already there */ } }

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
function saveMap(lid, pn) {
  if (!lid || !pn || !String(lid).endsWith('@lid')) return;
  const p = String(pn).includes('@') ? String(pn).replace(/:\d+@/, '@') : `${digits(pn)}@s.whatsapp.net`;
  db.prepare('INSERT INTO wb_lid (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(String(lid).replace(/:\d+@/, '@'), p);
}
const pnFor = (jid) => (String(jid).endsWith('@lid') ? db.prepare('SELECT pn FROM wb_lid WHERE lid = ?').get(jid)?.pn || null : jid);
export function displayName(jid, fallback) {
  const pn = pnFor(jid);
  const get = (j) => (j ? db.prepare('SELECT saved, notify, name FROM wb_contacts WHERE jid = ?').get(j) : null) || {};
  const a = get(jid), b = get(pn);
  return a.saved || b.saved || fallback || a.name || b.name || a.notify || b.notify || (pn && !String(pn).endsWith('@lid') ? '+' + digits(pn) : digits(jid));
}

const state = { status: 'off', qr: null, qrDataUrl: null, me: null, error: null, startedAt: null, pairPhone: null, pairCode: null };
let sock = null;
let starting = false;
let retries = 0;

const log = pino({ level: process.env.WA_PERSONAL_LOG || 'warn' });

export function personalStatus() {
  const counts = db.prepare('SELECT COUNT(*) AS chats, COALESCE(SUM(unread),0) AS unread FROM wb_chats').get();
  return { status: state.status, me: state.me, error: state.error, qr: state.qrDataUrl, pairCode: state.pairCode, ...counts };
}

function textOf(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.documentWithCaptionMessage?.message || msg;
  return inner.conversation
    || inner.extendedTextMessage?.text
    || inner.imageMessage?.caption && `📷 ${inner.imageMessage.caption}`
    || inner.videoMessage?.caption && `🎥 ${inner.videoMessage.caption}`
    || (inner.imageMessage && '📷 Photo')
    || (inner.videoMessage && '🎥 Video')
    || (inner.audioMessage && '🎤 Voice note')
    || (inner.documentMessage && `📄 ${inner.documentMessage.fileName || 'Document'}`)
    || (inner.stickerMessage && 'Sticker')
    || (inner.locationMessage && '📍 Location')
    || (inner.contactMessage && `👤 ${inner.contactMessage.displayName || 'Contact'}`)
    || (inner.eventMessage && `📅 Event invite: ${inner.eventMessage.name || ''}${inner.eventMessage.startTime ? ' · ' + new Date(Number(inner.eventMessage.startTime) * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}${inner.eventMessage.location?.name ? ' · ' + inner.eventMessage.location.name : ''}`)
    || ((inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3) && `📊 Poll: ${(inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3).name || ''}`)
    || (inner.liveLocationMessage && '📍 Live location')
    || (inner.contactsArrayMessage && `👥 ${inner.contactsArrayMessage.contacts?.length || ''} contacts`)
    || (inner.ptvMessage && '🎥 Video note')
    || inner.templateMessage?.hydratedTemplate?.hydratedContentText
    || inner.interactiveMessage?.body?.text
    || (inner.reactionMessage && null)
    || inner.buttonsResponseMessage?.selectedDisplayText
    || inner.listResponseMessage?.title
    || null;
}

const tsOf = (m) => {
  const t = m.messageTimestamp;
  const n = typeof t === 'number' ? t : Number(t?.low ?? t ?? 0);
  return n ? n * 1000 : Date.now();
};

const contactName = (jid) => db.prepare('SELECT name FROM wb_contacts WHERE jid = ?').get(jid)?.name || null;

function saveContact(c) {
  if (!c || !c.id) return;
  if (c.lid && c.phoneNumber) saveMap(c.lid, c.phoneNumber);
  if (String(c.id).endsWith('@lid') && c.phoneNumber) saveMap(c.id, c.phoneNumber);
  if (c.lid && String(c.id).endsWith('@s.whatsapp.net')) saveMap(c.lid, c.id);
  const saved = c.name || null, notify = c.notify || c.verifiedName || null;
  if (!saved && !notify) return;
  for (const id of new Set([c.id, c.lid, c.phoneNumber].filter(Boolean))) {
    db.prepare(`INSERT INTO wb_contacts (jid, saved, notify) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET saved = COALESCE(excluded.saved, wb_contacts.saved), notify = COALESCE(excluded.notify, wb_contacts.notify)`).run(id, saved, notify);
  }
}

function saveChat(c) {
  if (!c.id || c.id === 'status@broadcast') return;
  const name = c.name || c.subject || contactName(c.id) || null;
  db.prepare(`INSERT INTO wb_chats (jid, name, is_group, unread, last_at) VALUES (@jid, @name, @g, @u, @at)
    ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, wb_chats.name), unread = COALESCE(@u2, wb_chats.unread),
    last_at = MAX(wb_chats.last_at, excluded.last_at)`)
    .run({ jid: c.id, name, g: isJidGroup(c.id) ? 1 : 0, u: c.unreadCount || 0, u2: c.unreadCount ?? null, at: (Number(c.conversationTimestamp || 0) * 1000) || 0 });
}

function saveMessage(m, live) {
  const jid = m.key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || !m.message) return;
  const text = textOf(m);
  if (!text) return;
  const at = tsOf(m);
  const fromMe = m.key.fromMe ? 1 : 0;
  const sender = fromMe ? 'me' : (m.key.participant || jid);
  if (!fromMe && m.pushName) saveContact({ id: sender, notify: m.pushName });
  db.prepare('INSERT OR IGNORE INTO wb_messages (id, jid, from_me, sender, sender_name, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.key.id, jid, fromMe, sender, fromMe ? 'You' : (m.pushName || contactName(sender)), text.slice(0, 4000), at);
  const chat = db.prepare('SELECT last_at FROM wb_chats WHERE jid = ?').get(jid);
  if (!chat) saveChat({ id: jid, name: isJidGroup(jid) ? null : (m.pushName && !fromMe ? m.pushName : null) });
  if (!chat || at >= chat.last_at) {
    db.prepare('UPDATE wb_chats SET last_text = ?, last_from_me = ?, last_at = ? WHERE jid = ?').run(text.slice(0, 300), fromMe, at, jid);
  }
  const inner = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
  const fileMsg = inner.documentMessage || inner.documentWithCaptionMessage?.message?.documentMessage || inner.imageMessage || inner.videoMessage;
  if (fileMsg && at > Date.now() - 45 * 864e5) {
    try {
      const kind = inner.imageMessage ? 'image' : inner.videoMessage ? 'video' : 'doc';
      db.prepare('INSERT OR IGNORE INTO wb_media (jid, id, kind, raw, at, status) VALUES (?, ?, ?, ?, ?, ?)').run(jid, m.key.id, kind, JSON.stringify(m, BufferJSON.replacer), at, 'file');
    } catch { /* ignore */ }
  }
  if (inner.audioMessage && fromMe && at > Date.now() - 14 * 864e5) {
    // your own voice notes: keep them so they play in Dioma (no transcript needed)
    try { db.prepare('INSERT OR IGNORE INTO wb_media (jid, id, kind, raw, at, status) VALUES (?, ?, ?, ?, ?, ?)').run(jid, m.key.id, 'audio', JSON.stringify(m, BufferJSON.replacer), at, 'file'); } catch { /* ignore */ }
  }
  if (inner.audioMessage && !fromMe && at > Date.now() - 14 * 864e5) {
    try {
      db.prepare('INSERT OR IGNORE INTO wb_media (jid, id, kind, raw, at) VALUES (?, ?, ?, ?, ?)').run(jid, m.key.id, 'audio', JSON.stringify(m, BufferJSON.replacer), at);
      if (live) setTimeout(() => transcribeVoice(jid, m.key.id).catch(() => {}), 500);
    } catch { /* ignore */ }
  }
  if (live) {
    if (fromMe) db.prepare('UPDATE wb_chats SET unread = 0 WHERE jid = ?').run(jid);
    else db.prepare('UPDATE wb_chats SET unread = unread + 1 WHERE jid = ?').run(jid);
  }
}

export async function startPersonal(opts = {}) {
  if (opts.pairPhone !== undefined) { state.pairPhone = String(opts.pairPhone || '').replace(/\D/g, '') || null; state.pairCode = null; }
  if (opts.restart && sock && state.status !== 'connected') { try { sock.end?.(); } catch { /* ignore */ } sock = null; }
  if (starting || (sock && state.status === 'connected')) return personalStatus();
  if (sock) return personalStatus();
  starting = true;
  state.error = null;
  state.status = 'starting';
  state.startedAt = Date.now();
  try {
    // A fresh link request starts from a clean session, so half-finished attempts can't block it.
    if (opts.restart) {
      try { const c = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8')); if (!c.registered) fs.rmSync(authDir, { recursive: true, force: true }); } catch { fs.rmSync(authDir, { recursive: true, force: true }); }
      retries = 0;
    }
    fs.mkdirSync(authDir, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    state.pairCode = null;
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    sock = makeWASocket({
      auth, logger: log, version,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true
    });
    const self = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (sock !== self) return; // an older socket that was replaced
      if (u.connection) console.log('Business WhatsApp connection:', u.connection);
      if (u.qr && state.pairPhone && !auth.creds.registered && !state.pairCode && !self._pairAsked) {
        self._pairAsked = true;
        try {
          const code = await self.requestPairingCode(state.pairPhone);
          console.log('Business WhatsApp pairing code issued');
          state.pairCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
          state.status = 'pair';
        } catch (e) { state.error = 'Could not get a pairing code: ' + e.message; console.error('Pairing code error', e); }
      }
      if (u.qr && !state.pairPhone) {
        state.status = 'qr';
        state.qr = u.qr;
        state.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      }
      if (u.connection === 'open') {
        state.status = 'connected';
        state.qr = state.qrDataUrl = null;
        state.pairCode = null; state.pairPhone = null;
        state.me = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        retries = 0;
        console.log('Business WhatsApp linked', state.me);
        setTimeout(async () => {
          const lids = db.prepare("SELECT jid FROM wb_chats WHERE jid LIKE '%@lid' AND jid NOT IN (SELECT lid FROM wb_lid) LIMIT 400").all();
          let n = 0;
          for (const { jid } of lids) { try { const pn = await self.signalRepository?.lidMapping?.getPNForLID(jid); if (pn) { saveMap(jid, pn); n++; } } catch { /* skip */ } }
          if (lids.length) console.log(`Business WhatsApp: matched ${n}/${lids.length} hidden numbers`);
        }, 8000);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        console.error('Business WhatsApp closed', code, u.lastDisconnect?.error?.message);
        sock = null;
        // While waiting for the owner to type a pairing code, don't loop: each new socket would invalidate the code.
        if (!auth.creds.registered && state.pairCode && code !== 515) {
          state.status = 'off'; state.error = `WhatsApp closed the link request (${code || 'no code'}). Tap Get link code again and type the new code within 1 minute.`; state.pairCode = null; return;
        }
        if (code === DisconnectReason.loggedOut) {
          state.status = 'logged_out';
          state.error = 'WhatsApp logged this device out. Link again with a new QR code.';
          fs.rmSync(authDir, { recursive: true, force: true });
          return;
        }
        state.status = 'reconnecting';
        state.error = u.lastDisconnect?.error?.message || null;
        retries += 1;
        if (retries <= 8) setTimeout(() => { starting = false; startPersonal(); }, Math.min(30000, 2000 * retries));
        else state.status = 'off';
      }
    });
    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [], lidPnMappings = [] }) => {
      const tx = db.transaction(() => {
        lidPnMappings.forEach((m) => saveMap(m.lid, m.pn));
        contacts.forEach(saveContact);
        chats.forEach(saveChat);
        messages.forEach((m) => saveMessage(m, false));
      });
      tx();
    });
    sock.ev.on('contacts.upsert', (cs) => cs.forEach(saveContact));
    sock.ev.on('lid-mapping.update', (m) => { try { saveMap(m.lid, m.pn); } catch { /* ignore */ } });
    sock.ev.on('contacts.update', (cs) => cs.forEach(saveContact));
    sock.ev.on('chats.upsert', (cs) => cs.forEach(saveChat));
    sock.ev.on('chats.update', (cs) => cs.forEach((c) => {
      if (c.unreadCount != null && c.id) db.prepare('UPDATE wb_chats SET unread = ? WHERE jid = ?').run(Math.max(0, c.unreadCount), c.id);
      if (c.name && c.id) db.prepare('UPDATE wb_chats SET name = ? WHERE jid = ?').run(c.name, c.id);
    }));
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => saveChat({ id: g.id, subject: g.subject })));
    sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.id && g.subject && db.prepare('UPDATE wb_chats SET name = ? WHERE jid = ?').run(g.subject, g.id)));
    sock.ev.on('messages.upsert', ({ messages, type }) => messages.forEach((m) => saveMessage(m, type === 'notify')));
  } catch (e) {
    console.error('Business WhatsApp start failed', e);
    state.status = 'error';
    state.error = e.message;
  } finally {
    starting = false;
  }
  return personalStatus();
}

export async function stopPersonal(logout = false) {
  if (sock && logout) { try { await sock.logout(); } catch { /* ignore */ } }
  try { sock?.end?.(); } catch { /* ignore */ }
  sock = null;
  if (logout) fs.rmSync(authDir, { recursive: true, force: true });
  state.status = 'off';
  state.qr = state.qrDataUrl = null;
}

// Auto-reconnect after a restart when a session already exists.
export function resumePersonal() {
  if (fs.existsSync(path.join(authDir, 'creds.json'))) startPersonal();
}

export function listChats({ limit = 40, unreadOnly = false, q = '' } = {}) {
  const rows = db.prepare(`SELECT jid, name, is_group, unread, last_text, last_from_me, last_at FROM wb_chats WHERE last_at > 0 ${unreadOnly ? 'AND unread > 0' : ''} ORDER BY last_at DESC`).all();
  let out = rows.map((c) => {
    const pn = c.is_group ? null : pnFor(c.jid);
    const name = c.is_group ? (c.name || 'Group') : displayName(c.jid);
    return { id: c.jid, name, phone: pn && !String(pn).endsWith('@lid') ? '+' + digits(pn) : null, is_group: !!c.is_group, unread: c.unread, last_text: c.last_text, last_from_me: !!c.last_from_me, last_at: new Date(c.last_at).toISOString() };
  });
  if (q) {
    const ql = String(q).toLowerCase().trim(), qd = ql.replace(/\D/g, '');
    out = out.filter((c) => String(c.name).toLowerCase().includes(ql) || (qd.length >= 4 && ((c.phone || '').replace(/\D/g, '').includes(qd) || digits(c.id).includes(qd))));
  }
  return out.slice(0, Math.min(200, Math.max(1, limit)));
}

export function listMessages(chatId, limit = 30) {
  try { transcribePending(chatId, 3); } catch { /* ignore */ }
  const rows = db.prepare('SELECT id, from_me, sender_name, text, at FROM wb_messages WHERE jid = ? ORDER BY at DESC LIMIT ?').all(chatId, Math.min(200, Math.max(1, limit)));
  const rows2 = db.prepare('SELECT sender FROM wb_messages WHERE jid = ? ORDER BY at DESC LIMIT ?').all(chatId, Math.min(200, Math.max(1, limit)));
  const med = new Map(db.prepare("SELECT id, kind FROM wb_media WHERE jid = ? AND raw IS NOT NULL").all(chatId).map((r) => [r.id, r.kind]));
  return rows.reverse().map((m, i) => ({ id: m.id, from_me: !!m.from_me, sender: m.from_me ? 'You' : displayName((rows2[rows2.length - 1 - i] || {}).sender || chatId, null), text: m.text, at: new Date(m.at).toISOString(), media: med.get(m.id) || null }));
}

export async function markChatRead(chatId) {
  db.prepare('UPDATE wb_chats SET unread = 0 WHERE jid = ?').run(chatId);
}

async function transcribeVoice(jid, id) {
  const row = db.prepare("SELECT raw, status FROM wb_media WHERE jid = ? AND id = ?").get(jid, id);
  if (!row || row.status === 'done' || row.status === 'working' || !sock) return;
  db.prepare("UPDATE wb_media SET status = 'working' WHERE jid = ? AND id = ?").run(jid, id);
  try {
    const m = JSON.parse(row.raw, BufferJSON.reviver);
    const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
    const text = await transcribe(buf, 'audio/ogg');
    const out = '🎤 ' + (text || '(no clear speech; tap Play to listen)');
    db.prepare('UPDATE wb_messages SET text = ? WHERE jid = ? AND id = ?').run(out.slice(0, 4000), jid, id);
    const last = db.prepare('SELECT id FROM wb_messages WHERE jid = ? ORDER BY at DESC LIMIT 1').get(jid);
    if (last && last.id === id) db.prepare('UPDATE wb_chats SET last_text = ? WHERE jid = ?').run(out.slice(0, 300), jid);
    db.prepare("UPDATE wb_media SET status = 'done' WHERE jid = ? AND id = ?").run(jid, id);
  } catch (e) {
    console.error('Voice note transcription failed', e.message);
    db.prepare("UPDATE wb_media SET status = 'failed' WHERE jid = ? AND id = ?").run(jid, id);
  }
}

export async function getMedia(jid, id) {
  const row = db.prepare("SELECT raw, kind FROM wb_media WHERE jid = ? AND id = ?").get(jid, id);
  if (!row || !row.raw) throw new Error('This file is not available any more. Open it on your phone.');
  if (!sock) throw new Error('WhatsApp is not linked right now.');
  const m = JSON.parse(row.raw, BufferJSON.reviver);
  const inner = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
  const f = inner.documentMessage || inner.documentWithCaptionMessage?.message?.documentMessage || inner.imageMessage || inner.videoMessage || inner.audioMessage || {};
  const size = Number(f.fileLength || 0);
  if (size > 12 * 1024 * 1024) throw new Error('This file is bigger than 12 MB. Open it on your phone.');
  const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
  return { kind: row.kind, mimetype: f.mimetype || 'application/octet-stream', filename: f.fileName || (row.kind === 'image' ? 'photo.jpg' : row.kind === 'video' ? 'video.mp4' : 'file'), size: buf.length, data: buf.toString('base64') };
}

export function transcribePending(chatId, max = 3) {
  const rows = db.prepare("SELECT id FROM wb_media WHERE jid = ? AND kind = 'audio' AND status = 'new' ORDER BY at DESC LIMIT ?").all(chatId, max);
  for (const r of rows) transcribeVoice(chatId, r.id).catch(() => {});
  return rows.length;
}

export async function sendMedia(chatId, { data, mimetype, filename, caption }) {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not linked right now.');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > 16 * 1024 * 1024) throw new Error('The file is bigger than 16 MB.');
  const jid = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@s.whatsapp.net`;
  const mt = mimetype || 'application/octet-stream';
  const content = mt.startsWith('image/') && !/svg/.test(mt) ? { image: buf, caption: caption || undefined, mimetype: mt }
    : mt.startsWith('video/') ? { video: buf, caption: caption || undefined, mimetype: mt }
    : mt.startsWith('audio/') ? { audio: buf, mimetype: mt }
    : { document: buf, mimetype: mt, fileName: filename || 'file', caption: caption || undefined };
  const sent = await sock.sendMessage(jid, content);
  if (sent) saveMessage(sent, true);
  return { ok: true, id: sent?.key?.id, chat_id: jid };
}

// Post a text status (story) to WhatsApp, visible to the contacts Subesh chats with.
export async function postStatus(text, mediaPath, mime) {
  if (!sock || state.status !== 'connected') throw new Error('Business WhatsApp is not linked right now.');
  if (!text?.trim() && !mediaPath) throw new Error('Status text is empty.');
  const jids = db.prepare('SELECT jid FROM wb_chats WHERE is_group = 0 AND last_at > 0').all().map((r) => { const pn = pnFor(r.jid); const d = digits(pn && !String(pn).endsWith('@lid') ? pn : r.jid); return /@s\.whatsapp\.net$/.test(r.jid) ? r.jid : (pn && !String(pn).endsWith('@lid') ? d + '@s.whatsapp.net' : null); }).filter(Boolean);
  if (sock.user?.id) jids.push(sock.user.id.replace(/:\d+@/, '@'));
  const content = mediaPath ? (String(mime).startsWith('video/') ? { video: fs.readFileSync(mediaPath), caption: (text || '').trim() || undefined } : { image: fs.readFileSync(mediaPath), caption: (text || '').trim() || undefined }) : { text: text.trim() };
  const sent = await sock.sendMessage('status@broadcast', content, { backgroundColor: '#16181D', font: 1, statusJidList: [...new Set(jids)] });
  return { ok: true, id: sent?.key?.id, viewers: jids.length };
}

export async function sendPersonal(chatId, text) {
  if (!sock || state.status !== 'connected') throw new Error('Business WhatsApp is not linked right now.');
  if (!chatId || !text?.trim()) throw new Error('chat_id and text are needed.');
  const jid = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: text.trim() });
  if (sent) saveMessage(sent, true);
  return { ok: true, id: sent?.key?.id, chat_id: jid };
}

// Opportunity follow-ups: messages Subesh sent about business, partnerships, quotations or jobs
// (last `days` days) where the other side never answered after it, or the talk went quiet.
const OPP = /(opportunit|partner|collaborat|proposal|quotation|quote|rate card|rates|services|logistics|cold ?chain|fleet|truck|redex|meeting|call|demo|introduc|interested|offer|position|vacanc|job|role|hiring|cv|resume|apply|applied|application|interview|consult|invest|deal|contract|tender|rfq|pricing)/i;
export function findOpportunities({ days = 300, limit = 120 } = {}) {
  const since = Date.now() - days * 864e5;
  const mine = db.prepare("SELECT jid, text, at FROM wb_messages WHERE from_me = 1 AND at > ? AND jid NOT LIKE '%@g.us' AND jid NOT LIKE '%@newsletter' AND jid NOT LIKE '%broadcast%' AND length(text) > 40 ORDER BY at DESC").all(since);
  const byJid = new Map();
  for (const m of mine) { if (!OPP.test(m.text || '') || byJid.has(m.jid)) continue; byJid.set(m.jid, m); }
  const out = [];
  for (const [jid, m] of byJid) {
    const after = db.prepare('SELECT count(*) n FROM wb_messages WHERE jid = ? AND from_me = 0 AND at > ?').get(jid, m.at).n;
    const last = db.prepare('SELECT from_me, text, at FROM wb_messages WHERE jid = ? ORDER BY at DESC LIMIT 1').get(jid);
    const quiet = Date.now() - last.at;
    // no answer after his message, or the chat has been quiet for 7+ days with him waiting
    if (after > 0 && !(last.from_me && quiet > 7 * 864e5) && quiet < 21 * 864e5) continue;
    if (quiet < 2 * 864e5) continue; // too fresh to chase
    const ctx = db.prepare('SELECT from_me, text, at FROM wb_messages WHERE jid = ? ORDER BY at DESC LIMIT 8').all(jid).reverse();
    const ch = db.prepare('SELECT name FROM wb_chats WHERE jid = ?').get(jid) || {};
    out.push({ chat_id: jid, name: displayName(jid, ch.name), phone: (/^\d+@s\.whatsapp\.net$/.test(jid) ? '+' + jid.split('@')[0] : null), my_message: String(m.text).slice(0, 600), my_at: new Date(m.at).toISOString(), replied_after: after, quiet_days: Math.round(quiet / 864e5), context: ctx.map((x) => ({ me: !!x.from_me, text: String(x.text || '').slice(0, 300), at: new Date(x.at).toISOString() })) });
    if (out.length >= limit) break;
  }
  return out;
}
