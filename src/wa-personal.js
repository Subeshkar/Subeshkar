// Personal WhatsApp link (unofficial, via WhatsApp Web protocol / Baileys).
// The owner scans a QR code once, like linking WhatsApp Web on a laptop.
// Chats and messages are stored in SQLite so Dioma can list and read them.
// WhatsApp's terms do not allow unofficial clients: the owner accepted the ban risk.
import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, isJidGroup } from '@whiskeysockets/baileys';
import { db } from './db.js';

const dir = process.env.DATA_DIR || './data';
const authDir = path.join(dir, 'wa-personal-auth');

db.exec(`
CREATE TABLE IF NOT EXISTS wp_chats (
  jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0, last_text TEXT, last_from_me INTEGER DEFAULT 0, last_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_messages (
  id TEXT, jid TEXT, from_me INTEGER, sender TEXT, sender_name TEXT, text TEXT, at INTEGER,
  PRIMARY KEY (jid, id)
);
CREATE INDEX IF NOT EXISTS wp_messages_jid_at ON wp_messages (jid, at);
CREATE TABLE IF NOT EXISTS wp_contacts (jid TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS wp_lid (lid TEXT PRIMARY KEY, pn TEXT);
`);
for (const col of ['saved TEXT', 'notify TEXT']) { try { db.exec(`ALTER TABLE wp_contacts ADD COLUMN ${col}`); } catch { /* already there */ } }

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
function saveMap(lid, pn) {
  if (!lid || !pn || !String(lid).endsWith('@lid')) return;
  const p = String(pn).includes('@') ? String(pn).replace(/:\d+@/, '@') : `${digits(pn)}@s.whatsapp.net`;
  db.prepare('INSERT INTO wp_lid (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(String(lid).replace(/:\d+@/, '@'), p);
}
const pnFor = (jid) => (String(jid).endsWith('@lid') ? db.prepare('SELECT pn FROM wp_lid WHERE lid = ?').get(jid)?.pn || null : jid);
export function displayName(jid, fallback) {
  const pn = pnFor(jid);
  const get = (j) => (j ? db.prepare('SELECT saved, notify, name FROM wp_contacts WHERE jid = ?').get(j) : null) || {};
  const a = get(jid), b = get(pn);
  return a.saved || b.saved || fallback || a.name || b.name || a.notify || b.notify || (pn && !String(pn).endsWith('@lid') ? '+' + digits(pn) : digits(jid));
}

const state = { status: 'off', qr: null, qrDataUrl: null, me: null, error: null, startedAt: null, pairPhone: null, pairCode: null };
let sock = null;
let starting = false;
let retries = 0;

const log = pino({ level: process.env.WA_PERSONAL_LOG || 'warn' });

export function personalStatus() {
  const counts = db.prepare('SELECT COUNT(*) AS chats, COALESCE(SUM(unread),0) AS unread FROM wp_chats').get();
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
    || inner.buttonsResponseMessage?.selectedDisplayText
    || inner.listResponseMessage?.title
    || null;
}

const tsOf = (m) => {
  const t = m.messageTimestamp;
  const n = typeof t === 'number' ? t : Number(t?.low ?? t ?? 0);
  return n ? n * 1000 : Date.now();
};

const contactName = (jid) => db.prepare('SELECT name FROM wp_contacts WHERE jid = ?').get(jid)?.name || null;

function saveContact(c) {
  if (!c || !c.id) return;
  if (c.lid && c.phoneNumber) saveMap(c.lid, c.phoneNumber);
  if (String(c.id).endsWith('@lid') && c.phoneNumber) saveMap(c.id, c.phoneNumber);
  if (c.lid && String(c.id).endsWith('@s.whatsapp.net')) saveMap(c.lid, c.id);
  const saved = c.name || null, notify = c.notify || c.verifiedName || null;
  if (!saved && !notify) return;
  for (const id of new Set([c.id, c.lid, c.phoneNumber].filter(Boolean))) {
    db.prepare(`INSERT INTO wp_contacts (jid, saved, notify) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET saved = COALESCE(excluded.saved, wp_contacts.saved), notify = COALESCE(excluded.notify, wp_contacts.notify)`).run(id, saved, notify);
  }
}

function saveChat(c) {
  if (!c.id || c.id === 'status@broadcast') return;
  const name = c.name || c.subject || contactName(c.id) || null;
  db.prepare(`INSERT INTO wp_chats (jid, name, is_group, unread, last_at) VALUES (@jid, @name, @g, @u, @at)
    ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, wp_chats.name), unread = COALESCE(@u2, wp_chats.unread),
    last_at = MAX(wp_chats.last_at, excluded.last_at)`)
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
  db.prepare('INSERT OR IGNORE INTO wp_messages (id, jid, from_me, sender, sender_name, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.key.id, jid, fromMe, sender, fromMe ? 'You' : (m.pushName || contactName(sender)), text.slice(0, 4000), at);
  const chat = db.prepare('SELECT last_at FROM wp_chats WHERE jid = ?').get(jid);
  if (!chat) saveChat({ id: jid, name: isJidGroup(jid) ? null : (m.pushName && !fromMe ? m.pushName : null) });
  if (!chat || at >= chat.last_at) {
    db.prepare('UPDATE wp_chats SET last_text = ?, last_from_me = ?, last_at = ? WHERE jid = ?').run(text.slice(0, 300), fromMe, at, jid);
  }
  if (live) {
    if (fromMe) db.prepare('UPDATE wp_chats SET unread = 0 WHERE jid = ?').run(jid);
    else db.prepare('UPDATE wp_chats SET unread = unread + 1 WHERE jid = ?').run(jid);
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
      if (u.connection) console.log('Personal WhatsApp connection:', u.connection);
      if (u.qr && state.pairPhone && !auth.creds.registered && !state.pairCode && !self._pairAsked) {
        self._pairAsked = true;
        try {
          const code = await self.requestPairingCode(state.pairPhone);
          console.log('Personal WhatsApp pairing code issued');
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
        console.log('Personal WhatsApp linked', state.me);
        setTimeout(async () => {
          const lids = db.prepare("SELECT jid FROM wp_chats WHERE jid LIKE '%@lid' AND jid NOT IN (SELECT lid FROM wp_lid) LIMIT 400").all();
          let n = 0;
          for (const { jid } of lids) { try { const pn = await self.signalRepository?.lidMapping?.getPNForLID(jid); if (pn) { saveMap(jid, pn); n++; } } catch { /* skip */ } }
          if (lids.length) console.log(`Personal WhatsApp: matched ${n}/${lids.length} hidden numbers`);
        }, 8000);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        console.error('Personal WhatsApp closed', code, u.lastDisconnect?.error?.message);
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
      if (c.unreadCount != null && c.id) db.prepare('UPDATE wp_chats SET unread = ? WHERE jid = ?').run(Math.max(0, c.unreadCount), c.id);
      if (c.name && c.id) db.prepare('UPDATE wp_chats SET name = ? WHERE jid = ?').run(c.name, c.id);
    }));
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => saveChat({ id: g.id, subject: g.subject })));
    sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.id && g.subject && db.prepare('UPDATE wp_chats SET name = ? WHERE jid = ?').run(g.subject, g.id)));
    sock.ev.on('messages.upsert', ({ messages, type }) => messages.forEach((m) => saveMessage(m, type === 'notify')));
  } catch (e) {
    console.error('Personal WhatsApp start failed', e);
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
  const rows = db.prepare(`SELECT jid, name, is_group, unread, last_text, last_from_me, last_at FROM wp_chats WHERE last_at > 0 ${unreadOnly ? 'AND unread > 0' : ''} ORDER BY last_at DESC`).all();
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
  const rows = db.prepare('SELECT id, from_me, sender_name, text, at FROM wp_messages WHERE jid = ? ORDER BY at DESC LIMIT ?').all(chatId, Math.min(200, Math.max(1, limit)));
  const rows2 = db.prepare('SELECT sender FROM wp_messages WHERE jid = ? ORDER BY at DESC LIMIT ?').all(chatId, Math.min(200, Math.max(1, limit)));
  return rows.reverse().map((m, i) => ({ id: m.id, from_me: !!m.from_me, sender: m.from_me ? 'You' : displayName((rows2[rows2.length - 1 - i] || {}).sender || chatId, null), text: m.text, at: new Date(m.at).toISOString() }));
}

export async function markChatRead(chatId) {
  db.prepare('UPDATE wp_chats SET unread = 0 WHERE jid = ?').run(chatId);
}

export async function sendPersonal(chatId, text) {
  if (!sock || state.status !== 'connected') throw new Error('Personal WhatsApp is not linked right now.');
  if (!chatId || !text?.trim()) throw new Error('chat_id and text are needed.');
  const jid = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: text.trim() });
  if (sent) saveMessage(sent, true);
  return { ok: true, id: sent?.key?.id, chat_id: jid };
}
