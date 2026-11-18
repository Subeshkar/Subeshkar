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
db.exec('CREATE TABLE IF NOT EXISTS wa_mmeta (user_id INTEGER NOT NULL, jid TEXT NOT NULL, id TEXT NOT NULL, mtype TEXT, mname TEXT, mmime TEXT, PRIMARY KEY (user_id, jid, id))');
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
// Names: the name saved in your phone (book = 1) always wins over the name people give themselves on WhatsApp.
try { db.exec('ALTER TABLE wa_contacts ADD COLUMN book INTEGER DEFAULT 0'); } catch {}
db.exec('CREATE TABLE IF NOT EXISTS wa_lid (user_id INTEGER NOT NULL, lid TEXT NOT NULL, pn TEXT NOT NULL, PRIMARY KEY (user_id, lid))');
const bare = (j) => (typeof j === 'string' && j.includes('@') ? j.replace(/:\d+(?=@)/, '') : '');
function putName(uid, jid, nm, book) {
  if (!jid || !nm) return;
  if (book) run('INSERT INTO wa_contacts (user_id, jid, name, book) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, jid) DO UPDATE SET name = excluded.name, book = 1', uid, jid, nm);
  else run('INSERT INTO wa_contacts (user_id, jid, name, book) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, jid) DO UPDATE SET name = excluded.name WHERE COALESCE(wa_contacts.book, 0) = 0', uid, jid, nm);
}
function saveContact(uid, c) {
  if (!c) return;
  const ids = [...new Set([c.id, c.lid, c.phoneNumber, c.jid].map(bare).filter(Boolean))];
  const lid = ids.find((j) => j.endsWith('@lid')), pn = ids.find((j) => j.endsWith('@s.whatsapp.net'));
  if (lid && pn) mapLid(uid, lid, pn);
  if (c.name) ids.forEach((j) => putName(uid, j, c.name, 1));
  else if (c.notify || c.verifiedName) ids.forEach((j) => putName(uid, j, c.notify || c.verifiedName, 0));
}
// WhatsApp now hides numbers behind private ids (@lid). Remember which id is which number, and share the saved name between them.
function mapLid(uid, lid, pn) {
  lid = bare(lid); pn = bare(pn); if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  run('INSERT INTO wa_lid (user_id, lid, pn) VALUES (?, ?, ?) ON CONFLICT(user_id, lid) DO UPDATE SET pn = excluded.pn', uid, lid, pn);
  const a = one('SELECT name, book FROM wa_contacts WHERE user_id = ? AND jid = ?', uid, pn), b = one('SELECT name, book FROM wa_contacts WHERE user_id = ? AND jid = ?', uid, lid);
  const best = [a, b].filter((x) => x && x.name).sort((x, y) => (y.book || 0) - (x.book || 0))[0];
  if (best) { putName(uid, pn, best.name, best.book); putName(uid, lid, best.name, best.book); }
}
// After connecting: look up the number behind every private-id chat that still has no saved name.
async function fillLids(uid, sock) {
  const rows = all(`SELECT c.jid FROM wa_chats c LEFT JOIN wa_lid l ON l.user_id = c.user_id AND l.lid = c.jid WHERE c.user_id = ? AND c.jid LIKE '%@lid' AND l.pn IS NULL LIMIT 3000`, uid);
  for (const r of rows) {
    try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID(r.jid); if (pn) mapLid(uid, r.jid, pn); } catch {}
  }
  // and copy names for mappings we already know
  for (const m of all('SELECT lid, pn FROM wa_lid WHERE user_id = ?', uid)) mapLid(uid, m.lid, m.pn);
}
// Search everyone: saved contacts, chat names, people who wrote in groups, and (for 3+ letters) message text.
export function search(uid, q) {
  q = String(q || '').trim().toLowerCase().slice(0, 60); if (!q) return [];
  const like = '%' + q + '%', out = new Map();
  // Phone numbers: +971 58..., 00971..., 058... all match; we compare the last digits.
  let dig = q.replace(/\D/g, '').replace(/^00/, ''); if (/^0\d{8,9}$/.test(dig)) dig = dig.slice(1); if (dig.length > 9) dig = dig.slice(-9);
  const add = (jid, name, why) => { if (!jid || out.has(jid) || /@(broadcast|newsletter)/.test(jid)) return; out.set(jid, { jid, name: name || jid.split('@')[0], why }); };
  all(`SELECT jid, name FROM wa_contacts WHERE user_id = ? AND (LOWER(name) LIKE ?${dig.length >= 4 ? ' OR jid LIKE ?' : ''}) LIMIT 60`, uid, like, ...(dig.length >= 4 ? ['%' + dig + '%'] : [])).forEach((r) => add(r.jid, r.name, 'contact'));
  all('SELECT jid, name FROM wa_chats WHERE user_id = ? AND LOWER(name) LIKE ? LIMIT 60', uid, like).forEach((r) => add(r.jid, r.name, 'chat'));
  if (dig.length >= 4) all('SELECT l.lid, l.pn, ct.name FROM wa_lid l LEFT JOIN wa_contacts ct ON ct.user_id = l.user_id AND ct.jid = l.lid WHERE l.user_id = ? AND l.pn LIKE ? LIMIT 30', uid, '%' + dig + '%').forEach((r) => add(r.lid, r.name || '+' + r.pn.split('@')[0], 'contact'));
  all('SELECT participant jid, MAX(sender_name) name, MAX(jid) g FROM wa_messages WHERE user_id = ? AND from_me = 0 AND participant IS NOT NULL AND LOWER(sender_name) LIKE ? GROUP BY participant LIMIT 40', uid, like).forEach((r) => add(r.jid, r.name, 'group'));
  if (q.length >= 3) all('SELECT jid, MAX(at) at FROM wa_messages WHERE user_id = ? AND LOWER(text) LIKE ? GROUP BY jid ORDER BY at DESC LIMIT 30', uid, like).forEach((r) => add(r.jid, nameFor(uid, r.jid) || one('SELECT name FROM wa_chats WHERE user_id = ? AND jid = ?', uid, r.jid)?.name, 'message'));
  // One row per person: a private id and its phone number are the same person; keep the one that has the chat.
  const keyOf = (j) => (j.endsWith('@lid') && one('SELECT pn FROM wa_lid WHERE user_id = ? AND lid = ?', uid, j)?.pn) || j;
  const hasChat = (j) => !!one('SELECT 1 FROM wa_chats WHERE user_id = ? AND jid = ? AND last_at > 0', uid, j);
  const best = new Map();
  for (const p of out.values()) { const k = keyOf(p.jid), b = best.get(k); if (!b || (!hasChat(b.jid) && hasChat(p.jid))) best.set(k, b ? { ...p, why: b.why } : p); }
  return [...best.values()].slice(0, 80);
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
  if (m.key.remoteJidAlt) mapLid(uid, jid.endsWith('@lid') ? jid : m.key.remoteJidAlt, jid.endsWith('@lid') ? m.key.remoteJidAlt : jid);
  if (m.key.participant && m.key.participantAlt) mapLid(uid, m.key.participant.endsWith('@lid') ? m.key.participant : m.key.participantAlt, m.key.participant.endsWith('@lid') ? m.key.participantAlt : m.key.participant);
  if (!fromMe && m.pushName && !isJidGroup(jid) && !one('SELECT 1 FROM wa_contacts WHERE user_id = ? AND jid = ?', uid, jid)) putName(uid, jid, m.pushName, 0);
  const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message || {};
  // Voice notes: keep what is needed to download them later (only when the customer taps play).
  const mk = ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'documentWithCaptionMessage'].find((k) => inner[k]);
  let mobj = mk && inner[mk]; if (mk === 'documentWithCaptionMessage') mobj = inner[mk]?.message?.documentMessage;
  const mkey = mk === 'documentWithCaptionMessage' ? 'documentMessage' : mk;
  const media = m.media || (mobj && mobj.mediaKey ? JSON.stringify({ key: m.key, message: { [mkey]: mobj } }, BufferJSON.replacer) : null);
  const mtype = { audioMessage: 'audio', imageMessage: 'image', videoMessage: 'video', documentMessage: 'doc', stickerMessage: 'sticker' }[mkey] || null;
  if (mtype) try { run('INSERT INTO wa_mmeta (user_id, jid, id, mtype, mname, mmime) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, jid, id) DO NOTHING', uid, jid, m.key.id, mtype, mobj?.fileName || null, mobj?.mimetype || null); } catch {}
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
      if (u.connection === 'open') { st.status = 'open'; st.qr = null; st.tries = 0; st.me = sock.user?.id?.split(':')[0] || null; setTimeout(async () => {
          // Once: fetch your phone's contact names again, so names saved in your phone replace WhatsApp profile names.
          const flag = path.join(authDir(uid), '.names-v2');
          if (!fs.existsSync(flag) && sock.resyncAppState) {
            try { await auth.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } }); await sock.resyncAppState(['critical_unblock_low'], true); fs.writeFileSync(flag, String(Date.now())); } catch (e) { log.warn?.({ e: String(e) }, 'names resync'); }
          }
          fillLids(uid, sock).catch(() => {});
        }, 8000); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { await forget(uid); return; }
        // Never give up on a linked phone: keep reconnecting (2s, 4s… up to every 2 minutes).
        // 440 = the session was taken over (during an update the old server is still running for a moment): wait, then come back.
        st.status = 'off'; st.error = 'Reaching WhatsApp… one moment.';
        const wait = code === 440 ? 20e3 : Math.min(120e3, 2000 * 2 ** Math.min(st.tries, 6)); st.tries++;
        setTimeout(() => { if (S.get(uid) === st) { st.status = 'retry'; start(uid).catch(() => {}); } }, wait);
      }
    });
    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
      contacts.forEach((c) => saveContact(uid, c));
      chats.forEach((c) => saveChat(uid, c));
      messages.forEach((m) => saveMessage(uid, m, false));
    });
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => saveContact(uid, c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => saveContact(uid, c)));
    sock.ev.on('lid-mapping.update', (m) => [].concat(m || []).forEach((x) => x && mapLid(uid, x.lid, x.pn)));
    sock.ev.on('chats.upsert', (cs) => cs.forEach((c) => saveChat(uid, c)));
    sock.ev.on('chats.update', (cs) => cs.forEach((c) => c.id && c.unreadCount !== undefined && run('UPDATE wa_chats SET unread = ? WHERE user_id = ? AND jid = ?', c.unreadCount, uid, c.id)));
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => saveChat(uid, { id: g.id, subject: g.subject })));
    sock.ev.on('messages.upsert', ({ messages, type }) => messages.forEach((m) => { saveMessage(uid, m, type === 'notify'); selfCheck(uid, sock, m); }));
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
export const twins = (uid, jid) => { const o = jid.endsWith('@lid') ? one('SELECT pn x FROM wa_lid WHERE user_id = ? AND lid = ?', uid, jid) : one('SELECT lid x FROM wa_lid WHERE user_id = ? AND pn = ?', uid, jid); return o ? [jid, o.x] : [jid]; };
export const messages = (uid, jid) => { const j = twins(uid, jid); return all(`SELECT m.jid, m.id, m.from_me, m.sender_name, m.text, m.at, ((m.media IS NOT NULL AND COALESCE(t.mtype, 'audio') = 'audio') OR m.text = ?) audio, m.my_react,
    COALESCE(t.mtype, CASE WHEN m.text LIKE '📷 %' THEN 'image' WHEN m.text LIKE '🎥 %' THEN 'video' WHEN m.text LIKE '📄 %' THEN 'doc' WHEN m.text = 'Sticker' THEN 'sticker' END) mtype, t.mname
  FROM wa_messages m LEFT JOIN wa_mmeta t ON t.user_id = m.user_id AND t.jid = m.jid AND t.id = m.id WHERE m.user_id = ? AND m.jid IN (${j.map(() => '?').join(',')}) ORDER BY m.at DESC LIMIT 60`, '🎤 Voice message', uid, ...j).reverse(); };
// Find the private id behind a phone number (asks WhatsApp when Dioma does not know it yet).
export async function lidFor(uid, pn) {
  const k = one('SELECT lid FROM wa_lid WHERE user_id = ? AND pn = ?', uid, pn); if (k) return k.lid;
  const st = S.get(uid); if (!st || !st.sock) return '';
  try { const l = await st.sock.signalRepository?.lidMapping?.getLIDForPN(pn); if (l) { mapLid(uid, l, pn); return bare(l); } } catch {}
  return '';
}
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
// Dioma inside WhatsApp: whatever you write in your own "Message yourself" chat goes to your assistant, and its answer comes back there.
let SELF = null; const OURS = new Set();
export const onSelfMessage = (fn) => { SELF = fn; };
let MINE = null; export const onMyMessage = (fn) => { MINE = fn; };
export const DIOMA_TAG = '🤖 Dioma';
function selfCheck(uid, sock, m) {
  try {
    if (!SELF || !m.key?.fromMe || !m.key.id || OURS.has(m.key.id)) return;
    const jid = bare(m.key.remoteJid), me = bare(sock.user?.id), meLid = bare(sock.user?.lid);
    if (!jid || (jid !== me && jid !== meLid)) {
      // A message you sent to someone else: Dioma checks it for promises ("I'll get back to you") and makes a to-do.
      const at0 = Number(m.messageTimestamp || 0) * 1000, t0 = textOf(m);
      if (MINE && at0 && Date.now() - at0 < 120e3 && t0 && t0.length > 8 && !jid.endsWith('@broadcast') && !jid.endsWith('@newsletter')) MINE(uid, jid, m.key.id, t0);
      return;
    }
    const at = Number(m.messageTimestamp || 0) * 1000; if (!at || Date.now() - at > 120e3) return;
    const text = textOf(m); if (!text || text.startsWith(DIOMA_TAG)) return;
    SELF(uid, jid, text);
  } catch {}
}
// A note from Dioma into your own "Message yourself" chat (alerts, reminders).
export async function sendToMe(uid, text) {
  const st = S.get(uid); if (!st || st.status !== 'open' || !st.sock?.user?.id) return false;
  await sendSelf(uid, bare(st.sock.user.id), text); return true;
}
// Reply into your own chat (marked so Dioma never answers itself).
export async function sendSelf(uid, jid, text) {
  const st = S.get(uid); if (!st || st.status !== 'open') return;
  const r = await st.sock.sendMessage(jid, { text: (DIOMA_TAG + '\n' + String(text)).slice(0, 4000) });
  if (r?.key?.id) OURS.add(r.key.id);
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
// Photos, videos, documents and stickers: download once from WhatsApp, keep a copy, serve it to Dioma.
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };
export async function media(uid, jid, id) {
  let row = one('SELECT media, at FROM wa_messages WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id);
  if (!row) throw Object.assign(new Error('Not found.'), { status: 404 });
  const meta = one('SELECT mtype, mname, mmime FROM wa_mmeta WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id) || {};
  const dir = path.join(MEDIA, String(uid)); fs.mkdirSync(dir, { recursive: true });
  const safe = crypto.createHash('sha1').update('m|' + jid + '|' + id).digest('hex');
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(safe + '.'));
  const typeOf = (f) => meta.mmime || Object.keys(EXT).find((k) => f.endsWith('.' + EXT[k])) || 'application/octet-stream';
  if (hit) return { file: path.join(dir, hit), type: typeOf(hit).split(';')[0], name: meta.mname || hit };
  if (!row.media) {
    const st = S.get(uid); const next = one('SELECT id, from_me, at FROM wa_messages WHERE user_id = ? AND jid = ? AND at > ? ORDER BY at ASC LIMIT 1', uid, jid, row.at);
    if (st?.sock && st.status === 'open' && next) {
      try { await st.sock.fetchMessageHistory(30, { remoteJid: jid, id: next.id, fromMe: !!next.from_me }, next.at); } catch {}
      for (let i = 0; i < 16 && !row.media; i++) { await new Promise((r) => setTimeout(r, 750)); row = one('SELECT media, at FROM wa_messages WHERE user_id = ? AND jid = ? AND id = ?', uid, jid, id); }
    }
    if (!row.media) throw Object.assign(new Error('This older file cannot be loaded here. Open it on your phone.'), { status: 404 });
  }
  if (row.media.startsWith('file:')) { const f = path.join(dir, row.media.slice(5)); return { file: f, type: typeOf(f), name: meta.mname || path.basename(f) }; }
  const st = S.get(uid), msg = JSON.parse(row.media, BufferJSON.reviver), inner = Object.values(msg.message || {})[0] || {};
  const raw = await downloadMediaMessage(msg, 'buffer', {}, st?.sock ? { reuploadRequest: st.sock.updateMediaMessage, logger: log } : undefined);
  const mime = String(inner.mimetype || meta.mmime || 'application/octet-stream').split(';')[0];
  const ext = EXT[mime] || (meta.mname && /\.([a-z0-9]{1,5})$/i.exec(meta.mname)?.[1]) || 'bin';
  const f = path.join(dir, safe + '.' + ext); fs.writeFileSync(f, raw);
  return { file: f, type: mime, name: meta.mname || inner.fileName || ('whatsapp.' + ext) };
}

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
  const chats = all(`SELECT c.jid, l.pn, COALESCE(CASE WHEN ct.book = 1 THEN ct.name END, CASE WHEN cp.book = 1 THEN cp.name END, CASE WHEN c.jid LIKE '%@g.us' THEN c.name END, ct.name, cp.name, c.name) nm, c.is_group, c.unread, c.last_text, c.last_from_me, c.last_at,
      (SELECT MAX(at) FROM wa_messages m WHERE m.user_id = c.user_id AND m.jid = c.jid AND m.from_me = 1) my_at, f.ignored_at, f.noise,
      CASE WHEN c.last_text = '🎤 Voice message' THEN (SELECT id FROM wa_messages v WHERE v.user_id = c.user_id AND v.jid = c.jid AND v.text = c.last_text ORDER BY v.at DESC LIMIT 1) END voice_id
    FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.user_id = c.user_id AND ct.jid = c.jid LEFT JOIN wa_flags f ON f.user_id = c.user_id AND f.jid = c.jid
      LEFT JOIN wa_lid l ON l.user_id = c.user_id AND l.lid = c.jid LEFT JOIN wa_contacts cp ON cp.user_id = c.user_id AND cp.jid = l.pn
    WHERE c.user_id = ? ORDER BY c.last_at DESC LIMIT 3000`, uid);
  const sent = one('SELECT COUNT(*) n FROM wa_messages WHERE user_id = ? AND from_me = 1 AND at >= ?', uid, Number(since) || 0)?.n || 0;
  return { chats: chats.map((c) => ({ ...c, name: c.nm || c.jid.split('@')[0], named: !!c.nm })), sentToday: sent };
}
