// One-tap "Allow" connections for 1,000+ apps (Gmail, Outlook, Zoho, Instagram, Canva, ...) through Composio.
// Each Dioma user is a separate Composio user ("dioma-<id>"). Their tokens live with Composio, never in the page.
// Needs COMPOSIO_API_KEY. Without it, every app shows "Coming soon".
import { db, one, run } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS app_configs (slug TEXT PRIMARY KEY, id TEXT NOT NULL)`);
const BASE = 'https://backend.composio.dev/api/v3.1';
const KEY = () => process.env.COMPOSIO_API_KEY || '';
export const enabled = () => !!KEY();
const who = (uid) => `dioma-${uid}`;

async function call(method, path, body, base = BASE) {
  const r = await fetch(base + path, { method, headers: { 'x-api-key': KEY(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60e3) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) { const m = j?.error?.message || j?.message || `Apps service ${r.status}`; console.error('composio', method, path, r.status, t.slice(0, 400)); throw Object.assign(new Error(m), { status: r.status === 404 ? 404 : 502 }); }
  return j;
}

// The app catalogue Dioma shows. slug = Composio toolkit slug.
export const CATALOG = {
  mail: [['gmail', 'Gmail', 'Personal or Google Workspace'], ['outlook', 'Outlook', 'Outlook.com or Microsoft 365'], ['zoho_mail', 'Zoho Mail', 'Business email on Zoho']],
  cal: [['googlecalendar', 'Google Calendar', ''], ['outlook', 'Outlook Calendar', 'Comes with Outlook'], ['zoho', 'Zoho Calendar', '']],
  social: [['instagram', 'Instagram', 'DMs, comments and posts'], ['facebook', 'Facebook', 'Page messages and comments'], ['linkedin', 'LinkedIn', 'Posts and profile'], ['twitter', 'X', 'Mentions and posts'], ['youtube', 'YouTube', 'Comments and videos'], ['tiktok', 'TikTok', 'Posts']],
  biz: [['zoho_books', 'Zoho Books', 'Invoices, bills, purchase orders'], ['zoho', 'Zoho CRM', 'Leads, deals, follow-ups'], ['quickbooks', 'QuickBooks', 'Invoices and payments'], ['hubspot', 'HubSpot', 'Contacts and deals'], ['xero', 'Xero', 'Invoices and payments'], ['shopify', 'Shopify', 'Orders and products']],
  tools: [['canva', 'Canva', 'Designs'], ['notion', 'Notion', 'Notes and pages'], ['googledrive', 'Google Drive', 'Files'], ['onedrive', 'OneDrive', 'Files'], ['slack', 'Slack', 'Messages'], ['trello', 'Trello', 'Boards']],
};

async function configFor(slug) {
  const c = one('SELECT id FROM app_configs WHERE slug = ?', slug); if (c) return c.id;
  let id = null;
  try { const l = await call('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`); id = (l.items || []).find((x) => x.status !== 'DISABLED' && (x.toolkit?.slug || '') === slug)?.id || null; } catch {}
  if (!id) { const r = await call('POST', '/auth_configs', { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name: `Dioma ${slug}` } }); id = r.auth_config?.id || r.id; }
  if (!id) throw Object.assign(new Error('This app is not available yet.'), { status: 404 });
  run('INSERT OR REPLACE INTO app_configs (slug, id) VALUES (?, ?)', slug, id);
  return id;
}

// Start "Allow": returns the provider's sign-in page URL.
export async function link(uid, slug, callback) {
  if (!enabled()) throw Object.assign(new Error('App connections are being switched on. Try again soon.'), { status: 503 });
  const auth_config_id = await configFor(slug);
  const body = { auth_config_id, user_id: who(uid), callback_url: callback };
  let r; try { r = await call('POST', '/connected_accounts/link', body); } catch { r = await call('POST', '/connected_accounts/link', body, 'https://backend.composio.dev/api/v3'); }
  return r.redirect_url;
}

// Active connections for this user: [{ id, slug, at }]
export async function connected(uid) {
  if (!enabled()) return [];
  const r = await call('GET', `/connected_accounts?user_ids=${encodeURIComponent(who(uid))}&statuses=ACTIVE&limit=100`);
  return (r.items || []).map((x) => ({ id: x.id, slug: x.toolkit?.slug || x.toolkit_slug || x.appName || '', at: x.created_at }));
}

export async function disconnect(uid, slug) {
  for (const a of (await connected(uid)).filter((x) => x.slug === slug)) await call('DELETE', `/connected_accounts/${a.id}`);
}

export async function disconnectAll(uid) {
  if (!enabled()) return;
  for (const a of await connected(uid)) await call('DELETE', `/connected_accounts/${a.id}`).catch(() => {});
}

// Run one app action for this user, e.g. GMAIL_FETCH_EMAILS.
export async function exec(uid, tool, args = {}) {
  const r = await call('POST', `/tools/execute/${encodeURIComponent(tool)}`, { user_id: who(uid), arguments: args });
  if (r.successful === false) throw Object.assign(new Error(r.error || 'That app did not answer.'), { status: 502 });
  return r.data ?? r;
}

// Find a toolkit's action by name pattern (slugs differ per app), cached.
const TOOLCACHE = new Map();
export async function findTool(slug, re) {
  const k = slug + re; if (TOOLCACHE.has(k)) return TOOLCACHE.get(k);
  const r = await call('GET', `/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=200`);
  const t = (r.items || []).map((x) => x.slug).find((x) => re.test(x)) || null;
  TOOLCACHE.set(k, t); return t;
}
// Latest inbox messages from a connected mail app, in one simple shape.
const firstArray = (o, d = 0) => { if (Array.isArray(o)) return o; if (!o || typeof o !== 'object' || d > 4) return null; for (const v of Object.values(o)) { const a = firstArray(v, d + 1); if (a && a.length && typeof a[0] === 'object') return a; } return null; };
const pick = (m, ...ks) => { for (const k of ks) { const v = k.split('.').reduce((o, x) => (o == null ? o : o[x]), m); if (v) return typeof v === 'object' ? (v.name || v.address || v.emailAddress?.name || v.emailAddress?.address || JSON.stringify(v)) : v; } return ''; };
export async function inbox(uid, slug) {
  const tool = await findTool(slug, /(FETCH|LIST).*(EMAILS|MESSAGES|MAILS)$/) || await findTool(slug, /(FETCH|LIST|GET).*(EMAIL|MESSAGE|MAIL)/);
  if (!tool) throw Object.assign(new Error('Reading this inbox is not available yet.'), { status: 404 });
  const args = slug === 'gmail' ? { max_results: 15, query: 'in:inbox' } : { top: 15, limit: 15 };
  const data = await exec(uid, tool, args).catch(() => exec(uid, tool, {}));
  const list = firstArray(data) || [];
  return list.slice(0, 20).map((m) => {
    const at = pick(m, 'messageTimestamp', 'receivedDateTime', 'receivedTime', 'date', 'internalDate', 'sentDateTime');
    return { from: String(pick(m, 'sender', 'from', 'fromAddress', 'from.emailAddress.name', 'sender.emailAddress.name')).replace(/<.*>/, '').trim(), subject: pick(m, 'subject', 'Subject') || '(no subject)', at: at ? (isNaN(+at) ? +new Date(at) : +at) : 0 };
  });
}

// Today's and tomorrow's events from a calendar connected by Allow (Google or Outlook), simple shape, cached 5 minutes.
const EVC = new Map();
export async function events(uid) {
  if (!enabled()) return [];
  const c = EVC.get(uid); if (c && Date.now() - c.at < 5 * 60e3) return c.ev;
  let ev = [];
  try {
    const on = (await connected(uid)).map((x) => x.slug);
    const now = new Date(); now.setHours(0, 0, 0, 0); const end = new Date(now.getTime() + 2 * 864e5);
    for (const slug of ['zoho', 'googlecalendar', 'outlook'].filter((s) => on.includes(s))) {
      if (slug === 'zoho') {
        try {
          const tool = await findTool('zoho', /CALENDAR.*EVENTS?$|LIST.*EVENTS?$|GET.*EVENTS$/); if (!tool) continue;
          const data = await runFill(uid, tool, { 'start|from|range_start|timeMin': now.toISOString(), 'end|to|range_end|timeMax': end.toISOString() }).catch(() => exec(uid, tool, {}));
          for (const e of firstArray(data) || []) {
            const st = e.dateandtime?.start || e.start?.dateTime || e.start || e.startTime || e.Start_DateTime;
            if (st) ev.push({ id: String(e.uid || e.id || st), title: e.title || e.Event_Title || e.summary || '(no title)', start: /^\d{8}T\d{6}/.test(st) ? st.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(.*)$/, '$1-$2-$3T$4:$5:$6$7') : st, allDay: !!e.isallday, where: e.location || e.Venue || '', src: 'business' });
          }
        } catch {}
        continue;
      }
      const tool = await findTool(slug, /(LIST|FIND).*EVENTS?$/) || await findTool(slug, /(LIST|FIND|GET).*EVENT/); if (!tool) continue;
      const args = slug === 'googlecalendar' ? { timeMin: now.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 25 } : { start_datetime: now.toISOString(), end_datetime: end.toISOString(), top: 25 };
      const data = await exec(uid, tool, args).catch(() => exec(uid, tool, {}));
      for (const e of firstArray(data) || []) {
        const st = e.start?.dateTime || e.start?.date || e.start || e.startDateTime;
        const where = typeof e.location === 'string' ? e.location : e.location?.displayName || e.location?.address?.street || '';
        if (st) ev.push({ id: String(e.id || e.iCalUId || st), title: e.summary || e.subject || '(no title)', start: st, allDay: !!e.start?.date && !e.start?.dateTime || !!e.isAllDay, where, src: slug === 'outlook' ? 'business' : 'personal' });
      }
    }
  } catch (x) { console.error('events', x.message); }
  EVC.set(uid, { ev, at: Date.now() }); return ev;
}

// Zoho Mail needs the account id and folder ids first; parameter names are read from the tool's own schema.
const SCHEMA = new Map(), ZACC = new Map();
async function params(tool) { if (SCHEMA.has(tool)) return SCHEMA.get(tool); let p = {}; try { const r = await call('GET', `/tools/${tool}`); p = r.input_parameters?.properties || r.parameters?.properties || {}; } catch {} SCHEMA.set(tool, p); return p; }
const keyLike = (props, re) => Object.keys(props).find((k) => re.test(k));
export async function zohoAccount(uid) {
  const c = ZACC.get(uid); if (c && Date.now() - c.at < 30 * 60e3) return c;
  const data = await exec(uid, 'ZOHO_MAIL_ACCOUNTS_LIST_ACCOUNTS', {});
  const a = (firstArray(data) || [])[0] || {};
  const v = { id: String(a.accountId || a.account_id || a.id || ''), email: String(a.primaryEmailAddress || a.mailboxAddress || a.emailAddress?.[0]?.mailId || a.incomingUserName || ''), folders: null, at: Date.now() };
  ZACC.set(uid, v); return v;
}
async function zohoFolders(uid, acc) {
  if (acc.folders) return acc.folders;
  const props = await params('ZOHO_MAIL_FOLDERS_LIST_FOLDERS'), k = keyLike(props, /account/i) || 'account_id';
  const data = await exec(uid, 'ZOHO_MAIL_FOLDERS_LIST_FOLDERS', { [k]: acc.id });
  acc.folders = (firstArray(data) || []).map((f) => ({ id: String(f.folderId || f.id), type: String(f.folderType || f.folderName || '').toLowerCase(), name: String(f.folderName || '') }));
  return acc.folders;
}
async function zohoMailbox(uid, folder, q) {
  const acc = await zohoAccount(uid); if (!acc.id) return [];
  let data;
  if (q) {
    const props = await params('ZOHO_MAIL_SEARCH_MESSAGES');
    data = await exec(uid, 'ZOHO_MAIL_SEARCH_MESSAGES', { [keyLike(props, /account/i) || 'account_id']: acc.id, [keyLike(props, /search/i) || 'searchKey']: `entire:${q}`, [keyLike(props, /limit/i) || 'limit']: 30 });
  } else {
    const props = await params('ZOHO_MAIL_MESSAGES_LIST_EMAILS'), args = { [keyLike(props, /account/i) || 'account_id']: acc.id, [keyLike(props, /limit/i) || 'limit']: 30 };
    const want = { inbox: /inbox/, unread: /inbox/, sent: /sent/, drafts: /draft/ }[folder] || /inbox/;
    const f = (await zohoFolders(uid, acc).catch(() => [])).find((x) => want.test(x.type) || want.test(x.name.toLowerCase()));
    const fk = keyLike(props, /folder/i); if (f && fk) args[fk] = f.id;
    const sk = keyLike(props, /^status$/i); if (folder === 'unread' && sk) args[sk] = 'unread';
    data = await exec(uid, 'ZOHO_MAIL_MESSAGES_LIST_EMAILS', args);
  }
  return (firstArray(data) || []).map((m) => {
    const at = Number(m.receivedTime || m.sentDateInGMT || m.date) || +new Date(m.receivedTime || 0) || 0;
    const unread = m.status === '0' || m.status === 0 || m.isRead === false || String(m.status2 || '') === '0';
    const from = String(m.sender || m.fromAddress || ''), to = String(m.toAddress || '').replace(/&lt;|&gt;/g, '');
    return { id: 'zm:' + (m.messageId || m.id), from: from.replace(/<.*>/, '').trim(), fromAddr: String(m.fromAddress || '').toLowerCase(), to: to.replace(/<.*>/, '').replace(/"/g, '').trim(), toAddr: (to.match(/<([^>]+)>/)?.[1] || to).toLowerCase(), subject: m.subject || '(no subject)', snippet: String(m.summary || '').slice(0, 200), at, unread: folder === 'unread' ? true : unread };
  }).filter((m) => folder !== 'unread' || m.unread);
}

// A folder from a connected Gmail / Outlook / Zoho Mail, simple shape.
export async function mailbox(uid, slug, folder = 'inbox', q = '') {
  if (slug === 'gmail') {
    const tool = (await findTool(slug, /^GMAIL_FETCH_EMAILS$/)) || (await findTool(slug, /(FETCH|LIST).*(EMAILS|MESSAGES)$/));
    const query = { inbox: 'in:inbox', unread: 'in:inbox is:unread', sent: 'in:sent', drafts: 'in:drafts' }[folder] || 'in:inbox';
    const data = await exec(uid, tool, { query: (query + ' ' + (q || '')).trim(), max_results: 30, include_payload: false });
    return (firstArray(data) || []).map((m) => {
      const lab = m.labelIds || m.label_ids || [];
      const at = Number(m.messageTimestamp) || Number(m.internalDate) || +new Date(m.messageTimestamp || m.date || 0) || 0;
      const from = String(pick(m, 'sender', 'from')); const to = String(pick(m, 'to', 'recipient') || '');
      return { id: 'gm:' + (m.messageId || m.id), thread: m.threadId || m.thread_id || '', from: from.replace(/<.*>/, '').replace(/"/g, '').trim(), fromAddr: (from.match(/<([^>]+)>/)?.[1] || from).toLowerCase(), to: to.replace(/<.*>/, '').trim(), toAddr: (to.match(/<([^>]+)>/)?.[1] || to).toLowerCase(), subject: pick(m, 'subject') || '(no subject)', snippet: String(m.preview?.body || m.snippet || m.messageText || '').slice(0, 200), at: at < 1e12 ? at * 1000 : at, unread: lab.includes('UNREAD') };
    });
  }
  if (slug === 'zoho_mail') return zohoMailbox(uid, folder, q);
  if (folder !== 'inbox' && folder !== 'unread') return [];
  const list = await inbox(uid, slug);
  return list.filter((m) => !q || (m.from + ' ' + m.subject).toLowerCase().includes(q.toLowerCase())).map((m, i) => ({ id: `${slug}:${m.at}:${i}`, ...m, fromAddr: '', unread: folder === 'unread' ? true : !!m.unread, snippet: '' }));
}

// Run a tool, filling its arguments by the names its own schema uses.
// want: { 'alias1|alias2': value }  -> picks the first schema property whose name matches an alias (exact first, then contains).
export async function runFill(uid, tool, want = {}) {
  const props = await params(tool), names = Object.keys(props), args = {};
  for (const [aliases, val] of Object.entries(want)) {
    if (val === undefined || val === null || val === '') continue;
    const al = aliases.split('|');
    const k = names.find((n) => al.includes(n)) || names.find((n) => al.some((a) => n.toLowerCase().includes(a.toLowerCase()))) || (names.length ? null : al[0]);
    if (k) args[k] = val;
  }
  return exec(uid, tool, args);
}
export { firstArray as arrayIn, pick as pickField };
