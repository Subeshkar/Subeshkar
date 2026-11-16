// WhatsApp for every customer: each person links their own WhatsApp by scanning a QR code
// (WhatsApp → Settings → Linked devices), the same way WhatsApp Web works.
// Their link and chats are kept per user on the private volume; "Disconnect" logs out and deletes it all.
// This uses the WhatsApp Web protocol (Baileys). WhatsApp does not officially support it; customers are told before linking.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, isJidGroup, downloadMediaMessage, BufferJSON } from '@whiskeysockets/baileys';
import * as AU from './audio.js';
import { DIR, db, all, one, run } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS wa_chats (user_id INTEGER NOT NULL, jid TEXT NOT NULL, name TEXT, is_group INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, last_text TEXT, last_from_me INTEGER DEFAULT 0, last_at INTEGER DEFAULT 0, PRIMARY KEY (user_id, jid));
CREATE TABLE IF NOT EXISTS wa_messages (user_id INTEGER NOT NULL, jid TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER, sender_name TEXT, text TEXT, at INTEGER, PRIMARY KEY (user_id, jid, id));
CREATE INDEX IF NOT EXISTS wa_messages_at ON wa_messages (user_id, jid, at);
CREATE TABLE IF NOT EXISTS wa_contacts (user_id INTEGER NOT NULL, jid TEXT NOT NULL, name TEXT, PRIMARY KEY (user_id, jid));
`);

try { db.exec('ALTER TABLE wa_messages ADD COLUMN media TEXT'); } catch { /* already there */ }
for (const c of ['participant TEXT', 'my_react TEXT']) { try { db.exec('ALTER TABLE wa_messages ADD COLUMN ' + c); } catch { /* already there */ } }
const MEDIA = path.join(DIR, 'wa-media'); fs.mkdirSync(MEDIA, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS wa_flags (user_id INTEGER NOT NULL, jid TEXT NOT NULL, ignored_at INTEGER, noise INTEGER DEFAULT 0, PRIMARY KEY (user_id, jid));`);
export const ignore = (uid, jid) => run('INSERT INTO wa_flags (user_id, jid, ignored_at) VALUES (?, ?, ?) ON CONFLICT(user_id, jid) DO UPDATE SET ignored_at = excluded.ignored_at', uid, jid, Date.now());
export const setNoise = (uid, jid, on) => run('INSERT INTO wa_flags (user_id, jid, noise) VALUES (?, ?, ?) ON CONFLICT(user_id, jid) DO UPDATE SET noise = excluded.noise', uid, jid, on ? 1 : 0);
const log = pino({ level: 'silent' });
const authDir = (uid) => path.join(DIR, 'wa', String(uid));
const S = new Map(); // uid -> { sock, status, qr, error, me }
let version;

const textOf = (m) => {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || inner.documentMessage?.caption
    || (inner.imageMessage && '📷 Photo') || (inner.videoMessage && '🎥 Video') || (inner.audioMessage && '🎤 Voice message') || (inner.documentMessage && `📄 ${inner.documentMessage.fileName || 'Document'}`) || (inner.stickerMessage && 'Sticker') || (inner.locationMessage && '📍 Location') || '';
};
const skip = (jid) => !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
// A contact can arrive under its phone jid and its private (lid) jid; keep the name under both so every chat finds it.
function saveContact(uid, c) {
  const nm = c && (c.name || c.notify || c.verifiedName); if (!nm) return;
  const ids = [c.id, c.lid, c.phoneNumber, c.jid].filter((x) => typeof x === 'string' && x.includes('@'));
  for (const j of new Set(ids)) run('INSERT INTO wa_contacts (user_id, jid, name) VALUES (?, ?, ?) ON CONFLICT(user_id, jid) DO UPDATE SET name = excluded.name', uid, j, nm);
}
// Search everyone: saved contacts, chat names, people who wrote in groups, and (for 3+ letters) message text.
export function search(uid, q) {
  q = String(q || '').trim().toLowerCase().slice(0, 60); if (!q) return [];
  const like = '%' + q + '%', dig = q.replace(/\D/g, ''), out = new Map();
  const add = (jid, name, why) => { if (!jid || out.has(jid) || /@(broadcast|newsletter)/.test(jid)) return; out.set(jid, { jid, name: name || jid.split('@')[0], why }); };
  all(`SELECT jid, name FROM wa_contacts WHERE user_id = ? AND (LOWER(name) LIKE ?${dig.length >= 4 ? ' OR jid LIKE ?' : ''}) LIMIT 60`, uid, like, ...(dig.length >= 4 ? ['%' + dig + '%'] : [])).forEach((r) => add(r.jid, r.name, 'contact'));
  all('SELECT jid, name FROM wa_chats WHERE user_id = ? AND LOWER(name) LIKE ? LIMIT 60', uid, like).forEach((r) => add(r.jid, r.name, 'chat'));
  all('SELECT participant jid, MAX(sender_name) name, MAX(jid) g FROM wa_messages WHERE user_id = ? AND from_me = 0 AND participant IS NOT NULL AND LOWER(sender_name) LIKE ? GROUP BY participant LIMIT 40', uid, like).forEach((r) => add(r.jid, r.name, 'group'));
  if (q.length >= 3) all('SELECT jid, MAX(at) at FROM wa_messages WHERE user_id = ? AND LOWER(text) LIKE ? GROUP BY jid ORDER BY at DESC LIMIT 30', uid, like).forEach((r) => add(r.jid, nameFor(uid, r.jid) || one('SELECT name FROM wa_chats WHERE user_id = ? AND jid = ?', uid, r.jid)?.name, 'message'));
  return [...out.values()].slice(0, 80);
}
const nameFor = (uid, jid) => one('SELECT name FROM wa_contacts WHERE user_id = ? AND jid = ?', uid, jid)?.name || null;

function saveChat(uid, c) {
  if (skip(c.id)) return;
  run(`INSERT INTO wa_chats (user_id, jid, name, is_group, unread) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, jid) DO UPDATE SET name = COALESCE(excluded.name, wa_chats.name), unread = COALESCE(?, wa_chats.unread)`,
  uid, c.id, c.name || c.subject || nameFor(uid, c.id), isJidGroup(c.id) ? 1 : 0, c.unreadCount || 0, c.unreadCount ?? null);
}
function saveMessage(uid, m, live) {
  const jid = m.key?.remoteJid; if (skip(jid) || !m.key?.id) return;
  const text = textOf(m); if (!text) return;
  const at = Number(m.messageTimestamp || 0) * 1000 || Date.now();
  const fromMe = m.key.fromMe ? 1 : 0;
  if (!fromMe && m.pushName && !isJidGroup(jid)) run('INSERT INTO wa_contacts (user_id, jid, name) VALUES (?, ?, ?) ON CONFLICT(user_id, jid) DO NOTHING', uid, jid, m.pushName);
  const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message || {};
  // Voice notes: keep what is needed to download them later (only when the customer taps play).
  const media = m.media || (inner.audioMessage && inner.audioMessage.mediaKey ? JSON.stringify({ key: m.key, message: { audioMessage: inner.audioMessage } }, BufferJSON.replacer) : null);
  run('INSERT INTO wa_messages (user_id, jid, id, from_me, sender_name, text, at, media, participant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, jid, id) DO UPDATE SET media = COALESCE(wa_messages.media, excluded.media), participant = COALESCE(wa_messages.participant, excluded.participant)', uid, jid, m.key.id, fromMe, fromMe ? 'You' : m.pushName || null, text.slice(0, 4000), at, media, m.key.participant || null);
  run(`INSERT INTO wa_chats (user_id, jid, name, is_group, last_text, last_from_me, last_at, unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, jid) DO UPDATE SET last_text = CASE WHEN excluded.last_at >= wa_chats.last_at THEN excluded.last_text ELSE wa_chats.last_text END,
         last_from_me = CASE WHEN excluded.last_at >= wa_chats.last_at THEN excluded.last_from_me ELSE wa_chats.last_from_me END,
         last_at = MAX(wa_chats.last_at, excluded.last_at), name = COALESCE(wa_chats.name, excluded.name),
         unread = CASE WHEN ? THEN (CASE WHEN excluded.last_from_me = 1 THEN 0 ELSE wa_chats.unread + 1 END) ELSE wa_chats.unread END`,
  uid, jid, isJidGroup(jid) ? null : (m.pushName && !fromMe ? m.pushName : nameFor(uid, jid)), isJidGroup(jid) ? 1 : 0, text.slice(0, 300), fromMe, at, fromMe ? 0 : (live ? 1 : 0), live ? 1 : 0);
}

export async function start(uid) {
  const cur = S.get(uid);
  if (cur && (cur.status === 'open' || cur.status === 'connecting' || cur.status === 'qr')) return status(uid);
  const prevTries = cur?.status === 'retry' ? cur.tries : 0;
  fs.mkdirSync(authDir(uid), { recursive: true });
  const st = { status: 'connecting', qr: null, error: null, me: null, sock: null, tries: prevTries };
  S.set(uid, st);
  try {
    if (!version) version = (await fetchLatestBaileysVersion().catch(() => ({}))).version;
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir(uid));
    const sock = makeWASocket({ auth, logger: log, ...(version ? { version } : {}), browser: Browsers.macOS('Dioma'), syncFullHistory: false, markOnlineOnConnect: false });
    st.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (S.get(uid) !== st) return;
      if (u.qr) { st.status = 'qr'; st.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }); }
      if (u.connection === 'open') { st.status = 'open'; st.qr = null; st.tries = 0; st.me = sock.user?.id?.split(':')[0] || null; }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { await forget(uid); return; }
        st.status = 'off'; st.error = st.tries < 6 ? 'Reaching WhatsApp… one moment.' : 'Could not reach WhatsApp. Tap Try again.';
        if (st.tries++ < 6) setTimeout(() => { if (S.get(uid) === st) { st.status = 'retry'; start(uid).catch(() => {}); } }, Math.min(30e3, 2000 * st.tries));
      }
    });
    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
      contacts.forEach((c) => saveContact(uid, c));
      chats.forEach((c) => saveChat(uid, c));
      messages.forEach((m) => saveMessage(uid, m, false));
    });
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => saveContact(uid, c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => saveContact(uid, c)));
    sock.ev.on('chats.upsert', (cs) => cs.forEach((c) => saveChat(uid, c)));
    sock.ev.on('chats.update', (cs) => cs.forEach((c) => c.id && c.unreadCount !== undefined && run('UPDATE wa_chats SET unread = ? WHERE user_id = ? AND jid = ?', c.unreadCount, uid, c.id)));
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => saveChat(uid, { id: g.id, subject: g.subject })));
    sock.ev.on('messages.upsert', ({ messages, type }) => messages.forEach((m) => saveMessage(uid, m, type === 'notify')));
  } catch (e) { st.status = 'off'; st.error = e.message; }
  return status(uid);
}

export function status(uid) {
  const st = S.get(uid);
  if (!st) return { status: fs.existsSync(path.join(authDir(uid), 'creds.json')) ? 'off' : 'none' };
  return { status: st.status, qr: st.status === 'qr' ? st.qr : null, me: st.me, error: st.error };
}

export const chats = (uid, q = '') => all(`SELECT c.jid, COALESCE(c.name, ct.name, substr(c.jid, 1, instr(c.jid, '@') - 1)) name, c.is_group, c.unread, c.last_text, c.last_from_me, c.last_at
  FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.user_id = c.user_id AND ct.jid = c.jid
  WHERE c.user_id = ? AND c.last_at > 0 ${q ? 'AND (c.name LIKE ? OR ct.name LIKE ? OR c.jid LIKE ?)' : ''} ORDER BY c.last_at DESC LIMIT 80`, ...(q ? [uid, `%${q}%`, `%${q}%`, `%${q}%`] : [uid]));
export const messages = (uid, jid) => all('SELECT id, from_me, sender_name, text, at, (media IS NOT NULL OR text = ?) audio, my_react FROM wa_messages WHERE user_id = ? AND jid = ? ORDER BY at DESC LIMIT 60', '🎤 Voice message', uid, jid).reverse();
export const markRead = (uid, jid) => run('UPDATE wa_chats SET unread = 0 WHERE user_id = ? AND jid = ?', uid, jid);

// React to a message with an emoji (empty emoji removes your reaction), like long-press in WhatsApp.
export async function react(uid, jid, id, emoji) {
  const st = S.get(uid);
  if (!st || st.status !== 'open') throw Object.assign(new Error('WhatsApp is not connected right now.'), { status: 409 });
  const m = one('SELECT from_me, participant FROM wa_messages WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id);
  if (!m) throw Object.assign(new Error('Message not found.'), { status: 404 });
  const key = { remoteJid: jid, id, fromMe: !!m.from_me }; if (m.participant) key.participant = m.participant;
  await st.sock.sendMessage(jid, { react: { text: String(emoji || '').slice(0, 16), key } });
  run('UPDATE wa_messages SET my_react = ? WHERE user_id = ? AND jid = ? AND id = ?', emoji || null, uid, jid, id);
  return { ok: true };
}
export async function send(uid, jid, text) {
  const st = S.get(uid);
  if (!st || st.status !== 'open') throw Object.assign(new Error('WhatsApp is not connected right now.'), { status: 409 });
  if (!one('SELECT 1 FROM wa_chats WHERE user_id = ? AND jid = ?', uid, jid)) throw Object.assign(new Error('Unknown chat.'), { status: 404 });
  const r = await st.sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
  saveMessage(uid, { key: { remoteJid: jid, id: r?.key?.id || String(Date.now()), fromMe: true }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }, true);
  return { ok: true };
}

// Send a file (photo or document) to a chat.
export async function sendFile(uid, jid, name, mime, buf, caption) {
  const st = S.get(uid);
  if (!st || st.status !== 'open') throw Object.assign(new Error('WhatsApp is not connected right now.'), { status: 409 });
  if (!one('SELECT 1 FROM wa_chats WHERE user_id = ? AND jid = ?', uid, jid)) throw Object.assign(new Error('Unknown chat.'), { status: 404 });
  const content = /^image\//.test(mime) ? { image: buf, caption: caption || undefined, mimetype: mime } : { document: buf, fileName: name, mimetype: mime || 'application/octet-stream', caption: caption || undefined };
  const r = await st.sock.sendMessage(jid, content);
  saveMessage(uid, { key: { remoteJid: jid, id: r?.key?.id || String(Date.now()), fromMe: true }, message: { conversation: (/^image\//.test(mime) ? '📷 ' : '📄 ') + name }, messageTimestamp: Math.floor(Date.now() / 1000) }, true);
  return { ok: true };
}

// Play a voice note: download it from WhatsApp once, keep it, and give the browser a format it plays (m4a for iPhone).
export async function voice(uid, jid, id) {
  let row = one('SELECT media, at FROM wa_messages WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id);
  if (!row) throw Object.assign(new Error('No voice note here.'), { status: 404 });
  if (!row.media) {
    // An older voice note saved before playback existed: ask WhatsApp to send this part of the chat again.
    const st = S.get(uid); const next = one('SELECT id, from_me, at FROM wa_messages WHERE user_id = ? AND jid = ? AND at > ? ORDER BY at ASC LIMIT 1', uid, jid, row.at);
    if (st?.sock && st.status === 'open' && next) {
      try { await st.sock.fetchMessageHistory(30, { remoteJid: jid, id: next.id, fromMe: !!next.from_me }, next.at); } catch {}
      for (let i = 0; i < 16 && !row.media; i++) { await new Promise((r) => setTimeout(r, 750)); row = one('SELECT media, at FROM wa_messages WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id); }
    }
    if (!row.media) throw Object.assign(new Error('This older voice note cannot be loaded here. Play it on your phone.'), { status: 404 });
  }
  const dir = path.join(MEDIA, String(uid)); fs.mkdirSync(dir, { recursive: true });
  const safe = crypto.createHash('sha1').update(jid + '|' + id).digest('hex');
  const m4a = path.join(dir, safe + '.m4a'), ogg = path.join(dir, safe + '.ogg');
  if (fs.existsSync(m4a)) return { file: m4a, type: 'audio/mp4' };
  let raw;
  if (row.media.startsWith('file:')) raw = fs.readFileSync(path.join(dir, row.media.slice(5)));
  else if (fs.existsSync(ogg)) raw = fs.readFileSync(ogg);
  else {
    const st = S.get(uid); const msg = JSON.parse(row.media, BufferJSON.reviver);
    raw = await downloadMediaMessage(msg, 'buffer', {}, st?.sock ? { reuploadRequest: st.sock.updateMediaMessage, logger: log } : undefined);
    fs.writeFileSync(ogg, raw);
  }
  if (AU.available()) { try { fs.writeFileSync(m4a, await AU.toM4a(raw)); return { file: m4a, type: 'audio/mp4' }; } catch {} }
  if (!fs.existsSync(ogg)) fs.writeFileSync(ogg, raw);
  return { file: ogg, type: 'audio/ogg' };
}
// Send a voice note recorded in the app (converted to the WhatsApp voice format).
export async function sendVoice(uid, jid, buf, mime) {
  const st = S.get(uid);
  if (!st || st.status !== 'open') throw Object.assign(new Error('WhatsApp is not connected right now.'), { status: 409 });
  if (!one('SELECT 1 FROM wa_chats WHERE user_id = ? AND jid = ?', uid, jid)) throw Object.assign(new Error('Unknown chat.'), { status: 404 });
  let audio = buf, mimetype = mime || 'audio/mp4', ptt = false;
  if (AU.available()) { audio = await AU.toOpus(buf); mimetype = 'audio/ogg; codecs=opus'; ptt = true; }
  const r = await st.sock.sendMessage(jid, { audio, mimetype, ptt });
  const id = r?.key?.id || String(Date.now()), dir = path.join(MEDIA, String(uid)); fs.mkdirSync(dir, { recursive: true });
  const fname = crypto.createHash('sha1').update(jid + '|' + id).digest('hex') + (ptt ? '.ogg' : '.bin'); fs.writeFileSync(path.join(dir, fname), audio);
  saveMessage(uid, { key: { remoteJid: jid, id, fromMe: true }, message: { conversation: '🎤 Voice message' }, messageTimestamp: Math.floor(Date.now() / 1000), media: 'file:' + fname }, true);
  return { ok: true };
}

export async function forget(uid) {
  const st = S.get(uid); S.delete(uid);
  try { await st?.sock?.logout(); } catch {}
  try { st?.sock?.end?.(); } catch {}
  fs.rmSync(authDir(uid), { recursive: true, force: true });
  fs.rmSync(path.join(MEDIA, String(uid)), { recursive: true, force: true });
  for (const t of ['wa_chats', 'wa_messages', 'wa_contacts', 'wa_flags']) run(`DELETE FROM ${t} WHERE user_id = ?`, uid);
}

// Reconnect everyone who linked WhatsApp before a restart.
export function resumeAll() {
  try { for (const d of fs.readdirSync(path.join(DIR, 'wa'))) if (/^\d+$/.test(d) && fs.existsSync(path.join(DIR, 'wa', d, 'creds.json'))) start(Number(d)).catch(() => {}); } catch {}
}

// Short summary for the AI and the brief.
export function snapshot(uid) {
  if (status(uid).status === 'none') return null;
  const waiting = all('SELECT COALESCE(c.name, ct.name, c.jid) name, c.last_text, c.unread, c.last_at FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.user_id = c.user_id AND ct.jid = c.jid WHERE c.user_id = ? AND c.unread > 0 AND c.is_group = 0 ORDER BY c.last_at DESC LIMIT 10', uid);
  return { waiting };
}

// Everything the WhatsApp screen needs to sort chats (who is waiting, follow-ups, groups, unknown numbers).
export function overview(uid, since) {
  const chats = all(`SELECT c.jid, COALESCE(c.name, ct.name) nm, c.is_group, c.unread, c.last_text, c.last_from_me, c.last_at,
      (SELECT MAX(at) FROM wa_messages m WHERE m.user_id = c.user_id AND m.jid = c.jid AND m.from_me = 1) my_at, f.ignored_at, f.noise,
      CASE WHEN c.last_text = '🎤 Voice message' THEN (SELECT id FROM wa_messages v WHERE v.user_id = c.user_id AND v.jid = c.jid AND v.text = c.last_text ORDER BY v.at DESC LIMIT 1) END voice_id
    FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.user_id = c.user_id AND ct.jid = c.jid LEFT JOIN wa_flags f ON f.user_id = c.user_id AND f.jid = c.jid
    WHERE c.user_id = ? ORDER BY c.last_at DESC LIMIT 3000`, uid);
  const sent = one('SELECT COUNT(*) n FROM wa_messages WHERE user_id = ? AND from_me = 1 AND at >= ?', uid, Number(since) || 0)?.n || 0;
  return { chats: chats.map((c) => ({ ...c, name: c.nm || c.jid.split('@')[0], named: !!c.nm })), sentToday: sent };
}
