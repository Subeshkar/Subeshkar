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
`);

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
  const name = c.name || c.notify || c.verifiedName;
  if (!c.id || !name) return;
  db.prepare('INSERT INTO wp_contacts (jid, name) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name').run(c.id, name);
  db.prepare('UPDATE wp_chats SET name = ? WHERE jid = ? AND (name IS NULL OR name = jid)').run(name, c.id);
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
    fs.mkdirSync(authDir, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    sock = makeWASocket({
      auth, logger: log, version,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true
    });
    const self = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (sock !== self) return; // an older socket that was replaced
      if (u.qr && state.pairPhone && !auth.creds.registered && !state.pairCode) {
        try {
          const code = await sock.requestPairingCode(state.pairPhone);
          state.pairCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
          state.status = 'pair';
        } catch (e) { state.error = 'Could not get a pairing code: ' + e.message; }
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
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null;
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
    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
      const tx = db.transaction(() => {
        contacts.forEach(saveContact);
        chats.forEach(saveChat);
        messages.forEach((m) => saveMessage(m, false));
      });
      tx();
    });
    sock.ev.on('contacts.upsert', (cs) => cs.forEach(saveContact));
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
  const where = ['c.last_at > 0'];
  const args = {};
  if (unreadOnly) where.push('c.unread > 0');
  if (q) { where.push('(c.name LIKE @q OR k.name LIKE @q OR c.jid LIKE @q)'); args.q = `%${q}%`; }
  return db.prepare(`SELECT c.jid AS id, COALESCE(c.name, k.name, substr(c.jid, 1, instr(c.jid, '@') - 1)) AS name, c.is_group, c.unread, c.last_text, c.last_from_me, c.last_at
    FROM wp_chats c LEFT JOIN wp_contacts k ON k.jid = c.jid
    WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT @limit`).all({ ...args, limit: Math.min(200, Math.max(1, limit)) })
    .map((c) => ({ ...c, is_group: !!c.is_group, last_from_me: !!c.last_from_me, last_at: new Date(c.last_at).toISOString() }));
}

export function listMessages(chatId, limit = 30) {
  const rows = db.prepare('SELECT id, from_me, sender_name, text, at FROM wp_messages WHERE jid = ? ORDER BY at DESC LIMIT ?').all(chatId, Math.min(200, Math.max(1, limit)));
  return rows.reverse().map((m) => ({ id: m.id, from_me: !!m.from_me, sender: m.sender_name || (m.from_me ? 'You' : ''), text: m.text, at: new Date(m.at).toISOString() }));
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
