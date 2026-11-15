// Any mailbox by email + password (IMAP). Outlook, Zoho, Yahoo, iCloud, company mail and Gmail with an app password.
// The password is checked by signing in once, then stored encrypted (seal). "Disconnect" deletes it.
import { ImapFlow } from 'imapflow';
import { seal, open } from './crypto.js';
import { one, run } from './db.js';

const HOSTS = {
  'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com', 'hotmail.com': 'outlook.office365.com', 'live.com': 'outlook.office365.com', 'msn.com': 'outlook.office365.com',
  'yahoo.com': 'imap.mail.yahoo.com', 'ymail.com': 'imap.mail.yahoo.com',
  'icloud.com': 'imap.mail.me.com', 'me.com': 'imap.mail.me.com', 'mac.com': 'imap.mail.me.com',
  'zoho.com': 'imap.zoho.com', 'zohomail.com': 'imap.zoho.com', 'zohomail.in': 'imap.zoho.in',
  'aol.com': 'imap.aol.com', 'gmx.com': 'imap.gmx.com', 'proton.me': '',
};
export const PROVIDERS = { outlook: 'outlook.office365.com', zoho: 'imap.zoho.com', 'zoho-in': 'imap.zoho.in', 'zoho-eu': 'imap.zoho.eu', yahoo: 'imap.mail.yahoo.com', icloud: 'imap.mail.me.com', gmail: 'imap.gmail.com' };
export function guessHost(email, provider) {
  if (provider && PROVIDERS[provider]) return PROVIDERS[provider];
  const d = String(email).split('@')[1]?.toLowerCase() || '';
  return HOSTS[d] ?? `imap.${d}`;
}

const client = ({ email, password, host, port }) => new ImapFlow({ host, port: port || 993, secure: true, auth: { user: email, pass: password }, logger: false, socketTimeout: 30e3, greetingTimeout: 15e3, connectionTimeout: 15e3 });

export async function connect(uid, { email, password, provider, host }) {
  email = String(email || '').trim().toLowerCase(); password = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter your full email address.'), { status: 400 });
  if (!password) throw Object.assign(new Error('Enter your password.'), { status: 400 });
  host = String(host || '').trim().toLowerCase() || guessHost(email, provider);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw Object.assign(new Error('We could not find the mail server for that address. Enter it under "Server".'), { status: 400, needHost: true });
  const c = client({ email, password, host });
  try { await c.connect(); await c.logout(); }
  catch (e) {
    const auth = /auth|login|credential|password|invalid/i.test(String(e.responseText || e.message));
    throw Object.assign(new Error(auth
      ? 'That email and password did not work. Many providers (Gmail, Outlook, Yahoo, iCloud, Zoho) need an "app password" for other apps: make one in your account security settings and use it here.'
      : `Could not reach ${host}. Check the address, or enter your mail server under "Server".`), { status: 400, needHost: !auth });
  }
  run(`INSERT INTO connections (user_id, kind, account, secret, created) VALUES (?, 'imap', ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET account = excluded.account, secret = excluded.secret, created = excluded.created`, uid, email, seal({ email, password, host }), Date.now());
  return { account: email };
}
export const account = (uid) => one(`SELECT account FROM connections WHERE user_id = ? AND kind = 'imap'`, uid)?.account || null;
export const disconnect = (uid) => run(`DELETE FROM connections WHERE user_id = ? AND kind = 'imap'`, uid);

// Latest messages in the inbox, newest first.
export async function inbox(uid, limit = 25) {
  const row = one(`SELECT secret FROM connections WHERE user_id = ? AND kind = 'imap'`, uid);
  if (!row) return null;
  const c = client(open(row.secret));
  await c.connect();
  const out = [];
  try {
    const box = await c.mailboxOpen('INBOX', { readOnly: true });
    if (box.exists) {
      const from = Math.max(1, box.exists - limit + 1);
      for await (const m of c.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
        const f = m.envelope.from?.[0] || {};
        out.push({ id: m.uid, from: f.name || f.address || '', fromAddr: f.address || '', subject: m.envelope.subject || '(no subject)', at: +new Date(m.envelope.date || Date.now()), unread: !m.flags?.has('\\Seen') });
      }
    }
  } finally { await c.logout().catch(() => {}); }
  return out.sort((a, b) => b.at - a.at);
}

// One folder (inbox / unread / sent / drafts), optionally searched. Newest first.
export async function box(uid, folder = 'inbox', q = '', limit = 30) {
  const row = one(`SELECT secret FROM connections WHERE user_id = ? AND kind = 'imap'`, uid);
  if (!row) return [];
  const c = client(open(row.secret));
  await c.connect();
  const out = [];
  try {
    let path = 'INBOX';
    if (folder === 'sent' || folder === 'drafts') {
      const want = folder === 'sent' ? '\\Sent' : '\\Drafts';
      const list = await c.list();
      const f = list.find((x) => x.specialUse === want) || list.find((x) => new RegExp(folder === 'sent' ? 'sent' : 'draft', 'i').test(x.path));
      if (!f) return [];
      path = f.path;
    }
    const mb = await c.mailboxOpen(path, { readOnly: true });
    if (!mb.exists) return [];
    let uids;
    const crit = {}; if (folder === 'unread') crit.seen = false; if (q) crit.or = [{ subject: q }, { from: q }, { body: q }];
    if (Object.keys(crit).length) uids = (await c.search(crit, { uid: true })) || [];
    const range = uids ? uids.slice(-limit) : `${Math.max(1, mb.exists - limit + 1)}:*`;
    if (uids && !uids.length) return [];
    for await (const m of c.fetch(range, { envelope: true, flags: true, uid: true }, uids ? { uid: true } : undefined)) {
      const f = m.envelope.from?.[0] || {}, t = m.envelope.to?.[0] || {};
      out.push({ id: 'im:' + path + ':' + m.uid, from: f.name || f.address || '', fromAddr: (f.address || '').toLowerCase(), to: t.name || t.address || '', toAddr: (t.address || '').toLowerCase(), subject: m.envelope.subject || '(no subject)', at: +new Date(m.envelope.date || Date.now()), unread: !m.flags?.has('\\Seen'), snippet: '' });
    }
  } finally { await c.logout().catch(() => {}); }
  return out.sort((a, b) => b.at - a.at);
}
