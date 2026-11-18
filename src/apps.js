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
  // X (Twitter) has no shared sign-in any more: it needs Dioma's own X developer app, added once in Composio.
  if (!id && slug === 'twitter') throw Object.assign(new Error('X is not switched on in Dioma yet. It needs a one-time setup by the Dioma team. Every other app works now.'), { status: 409 });
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
export async function toolsOf(slug) { const k = 'all:' + slug; if (TOOLCACHE.has(k)) return TOOLCACHE.get(k); const r = await call('GET', `/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=200`); const l = (r.items || []).map((x) => x.slug); TOOLCACHE.set(k, l); return l; }
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
const ERR = new Map();
export const eventErrors = (uid) => ['zoho', 'googlecalendar', 'outlook'].map((s) => ERR.get(uid + s) ? s + ': ' + ERR.get(uid + s) : '').filter(Boolean);
export async function events(uid) {
  if (!enabled()) return [];
  const c = EVC.get(uid); if (c && Date.now() - c.at < 5 * 60e3) return c.ev;
  let ev = [];
  try {
    const on = (await connected(uid)).map((x) => x.slug);
    const tz = (one('SELECT tz FROM users WHERE id = ?', uid) || {}).tz || 'Asia/Dubai';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()), offMs = Date.parse(new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + 'Z') - Date.now();
    const now = new Date(Date.parse(day + 'T00:00:00Z') - offMs), end = new Date(now.getTime() + 2 * 864e5);
    const inWin = (st) => { const t = Date.parse(st); return !t || (t >= now.getTime() - 864e5 && t < end.getTime()); };
    for (const slug of ['zoho', 'googlecalendar', 'outlook'].filter((s) => on.includes(s))) {
      // Each calendar on its own: one failing never hides the others, and its error is shown.
      try {
        if (slug === 'zoho') {
          // Zoho CRM meetings (Events module). The CRM API needs the list of fields.
          const tool = await findTool('zoho', /CALENDAR.*EVENTS?$|LIST.*EVENTS?$|GET.*EVENTS$/); if (!tool) { ERR.set(uid + slug, 'no calendar tool'); continue; }
          const data = await runFill(uid, tool, { 'fields': 'Event_Title,Start_DateTime,End_DateTime,Venue,All_day,Description', 'module|module_api_name|moduleApiName': 'Events', 'start|from|range_start|timeMin': now.toISOString(), 'end|to|range_end|timeMax': end.toISOString(), 'sort_by': 'Start_DateTime', 'per_page': 200 });
          for (const e of firstArray(data) || []) {
            const st = e.dateandtime?.start || e.start?.dateTime || e.Start_DateTime || e.startTime || (typeof e.start === 'string' ? e.start : '');
            if (st && inWin(st)) ev.push({ id: String(e.uid || e.id || st), title: e.title || e.Event_Title || e.summary || '(no title)', start: /^\d{8}T\d{6}/.test(st) ? st.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(.*)$/, '$1-$2-$3T$4:$5:$6$7') : st, allDay: !!(e.isallday || e.All_day), where: e.location || e.Venue || '', src: 'business' });
          }
          ERR.delete(uid + slug); continue;
        }
        let items = null;
        if (slug === 'googlecalendar') {
          // Google's own API first (repeating events expanded), then the tool as a fallback.
          try {
            const qs = new URLSearchParams({ timeMin: now.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
            const d = await proxy(uid, 'googlecalendar', { endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + qs });
            items = Array.isArray(d?.items) ? d.items : null;
          } catch (x) { console.error('gcal proxy', x.message); }
          if (!items) { const all = await toolsOf('googlecalendar').catch(() => []); const tool = ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT'].find((t) => all.includes(t)) || await findTool(slug, /(LIST|FIND).*EVENTS?$|EVENTS_LIST$/);
            if (!tool) { ERR.set(uid + slug, 'no calendar tool'); continue; }
            items = firstArray(await runFill(uid, tool, { 'calendarId|calendar_id': 'primary', 'timeMin|time_min': now.toISOString(), 'timeMax|time_max': end.toISOString(), 'singleEvents|single_events': true, 'orderBy|order_by': 'startTime', 'maxResults|max_results': 250 })) || []; }
        } else {
          const tool = await findTool(slug, /(LIST|FIND).*EVENTS?$|EVENTS_LIST$/) || await findTool(slug, /(LIST|FIND|GET).*EVENT/); if (!tool) { ERR.set(uid + slug, 'no calendar tool'); continue; }
          items = firstArray(await runFill(uid, tool, { 'start_datetime|startDateTime|start': now.toISOString(), 'end_datetime|endDateTime|end': end.toISOString(), 'top|max_results': 100 })) || [];
        }
        for (const e of items) {
          if (e.status === 'cancelled') continue;
          const st = e.start?.dateTime || e.start?.date || (typeof e.start === 'string' ? e.start : '') || e.startDateTime;
          const where = typeof e.location === 'string' ? e.location : e.location?.displayName || e.location?.address?.street || '';
          const link = e.hangoutLink || e.conferenceData?.entryPoints?.find?.((p) => p.entryPointType === 'video')?.uri || e.onlineMeeting?.joinUrl || '';
          const who = (e.attendees || []).filter((a) => !a.self).map((a) => a.displayName || a.email || a.emailAddress?.name).filter(Boolean).slice(0, 6).join(', ');
          if (st && inWin(st)) ev.push({ id: String(e.id || e.iCalUId || st), title: e.summary || e.subject || '(no title)', start: st, allDay: !!e.start?.date && !e.start?.dateTime || !!e.isAllDay, where, link, who, emails: (e.attendees || []).filter((a) => !a.self).map((a) => a.email || a.emailAddress?.address).filter((x) => /@/.test(x || '')).slice(0, 20), src: slug === 'outlook' || (e.attendees || []).length > 1 ? 'business' : 'personal' });
        }
        ERR.delete(uid + slug);
      } catch (x) { ERR.set(uid + slug, x.message); console.error('events ' + slug, x.message); }
    }
  } catch (x) { console.error('events', x.message); }
  EVC.set(uid, { ev, at: Date.now() }); return ev;
}

// Zoho Mail needs the account id and folder ids first; parameter names are read from the tool's own schema.
const SCHEMA = new Map(), ZACC = new Map(), ZMF = new Map(); // ZMF: Zoho message id -> its folder id (Zoho needs both to open an email)
async function params(tool) { if (SCHEMA.has(tool)) return SCHEMA.get(tool); let p = {}; try { const r = await call('GET', `/tools/${tool}`); p = r.input_parameters?.properties || r.parameters?.properties || {}; } catch {} SCHEMA.set(tool, p); return p; }
const keyLike = (props, re) => Object.keys(props).find((k) => re.test(k));
export async function zohoAccount(uid) {
  const c = ZACC.get(uid); if (c && Date.now() - c.at < 30 * 60e3) return c;
  const data = await exec(uid, 'ZOHO_MAIL_ACCOUNTS_LIST_ACCOUNTS', {});
  const a = (firstArray(data) || [])[0] || {};
  const v = { id: String(a.accountId || a.account_id || a.id || ''), email: String(a.primaryEmailAddress || a.mailboxAddress || a.emailAddress?.[0]?.mailId || a.incomingUserName || ''), folders: null, at: Date.now() };
  ZACC.set(uid, v); return v;
}
export async function zohoFolders(uid, acc) {
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
    if ((m.messageId || m.id) && m.folderId) ZMF.set(uid + ':' + (m.messageId || m.id), String(m.folderId));
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
    const query = { inbox: 'in:inbox', unread: 'in:inbox is:unread', sent: 'in:sent', drafts: 'in:drafts', all: '' }[folder] ?? 'in:inbox';
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
    // Exact name first, then whole-word match ("to" fits "to_address" but never "auto_reply"; "cc" never fits "account_id").
    const words = (x) => x.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const k = names.find((n) => al.includes(n)) || names.find((n) => al.some((a) => { const nw = words(n), aw = words(a); return aw.length && aw.every((w) => nw.includes(w)); })) || (names.length ? null : al[0]);
    if (k) args[k] = val;
  }
  return exec(uid, tool, args);
}
export { firstArray as arrayIn, pick as pickField, params as toolParams };
// Call the app's own API with the customer's connection (for actions Composio has no ready tool for).
export async function proxy(uid, slug, { endpoint, method = 'GET', body, headers = {} }) {
  const acc = (await connected(uid)).find((x) => x.slug === slug); if (!acc) throw Object.assign(new Error('Not connected.'), { status: 400 });
  const r = await call('POST', '/tools/execute/proxy', { endpoint, method, body, connected_account_id: acc.id, parameters: Object.entries(headers).map(([name, value]) => ({ name, value, type: 'header' })) });
  const st = r.status ?? r.status_code; if (st && st >= 400) throw Object.assign(new Error(typeof r.data === 'object' ? r.data?.message || JSON.stringify(r.data).slice(0, 200) : String(r.data || 'The app refused.')), { status: 502 });
  return r.data ?? r;
}

// Open one Zoho email: its text and its attachment list. Zoho needs the folder, so we use the one seen in the list, or try Inbox, Sent and the rest.
// Three ways, first that works wins: Zoho's own "message content" tool, then Zoho's API through the connection, then the regional Zoho addresses.
// trace collects what failed, so a blank email says why.
export async function zohoTools(uid) { const r = await call('GET', `/tools?toolkit_slug=zoho_mail&limit=200`).catch(() => ({ items: [] })); return (r.items || []).map((x) => x.slug); }
export async function zohoMessage(uid, mid, trace = []) {
  const acc = await zohoAccount(uid); if (!acc.id) { trace.push('no Zoho account id'); return null; }
  mid = String(mid).replace(/^zm:/, '');
  const known = ZMF.get(uid + ':' + mid), fl = await zohoFolders(uid, acc).catch((e) => { trace.push('folders: ' + e.message); return []; });
  const order = [known, ...fl.filter((f) => /inbox/.test(f.type)).map((f) => f.id), ...fl.filter((f) => /sent/.test(f.type)).map((f) => f.id), ...fl.map((f) => f.id)].filter(Boolean);
  const tries = [...new Set(order)].slice(0, 8); if (!tries.length) trace.push('no folders found');
  const got = (r) => { const d = r?.data?.data ?? r?.data ?? r; const c = d?.content ?? d?.data?.content ?? d?.body ?? d?.html; return typeof c === 'string' ? c : null; };
  const attsOf = async (fid, base) => { try { const a = base == null ? null : await proxy(uid, 'zoho_mail', { endpoint: `${base}/api/accounts/${acc.id}/folders/${fid}/messages/${mid}/attachmentinfo` }); return ((a?.data?.attachments) || a?.attachments || []).map((x) => ({ id: String(x.attachmentId), name: x.attachmentName || 'file', size: x.attachmentSize || 0 })); } catch (e) { trace.push('attachmentinfo: ' + e.message.slice(0, 120)); return []; } };
  // 1. Zoho's own tool for an email's content (never the attachment tool).
  const tools = await zohoTools(uid), ct = tools.find((t) => /MESSAGE.*CONTENT|CONTENT.*MESSAGE|EMAIL.*CONTENT|GET.*MESSAGE.*(BODY|DETAIL)/.test(t) && !/ATTACH/.test(t));
  if (ct) for (const fid of tries.slice(0, 4)) {
    try { const d = await runFill(uid, ct, { 'account_id|accountId': acc.id, 'folder_id|folderId': fid, 'message_id|messageId': mid }); const c = got(d); if (c != null && c !== '') { ZMF.set(uid + ':' + mid, fid); return { html: c, atts: await attsOf(fid, ZBASE.get(uid) || ''), fid, base: ZBASE.get(uid) || '', acc: acc.id, via: ct }; } trace.push(ct + ' folder ' + fid + ': empty ' + JSON.stringify(d).slice(0, 160)); }
    catch (e) { trace.push(ct + ' folder ' + fid + ': ' + e.message.slice(0, 160)); }
  } else trace.push('no Zoho content tool among ' + tools.length + ' tools');
  // 2 and 3. Zoho's API through the customer's connection: the connection's own address first, then each region.
  for (const base of ZBASE.get(uid) ? [ZBASE.get(uid)] : ['', 'https://mail.zoho.com', 'https://mail.zoho.eu', 'https://mail.zoho.in', 'https://mail.zoho.com.au']) {
    for (const fid of tries) {
      try {
        const r = await proxy(uid, 'zoho_mail', { endpoint: `${base}/api/accounts/${acc.id}/folders/${fid}/messages/${mid}/content?includeBlockContent=true` });
        const c = got(r); if (c == null) { trace.push(`api ${base || 'conn'} ${fid}: ${JSON.stringify(r).slice(0, 140)}`); continue; }
        ZBASE.set(uid, base); ZMF.set(uid + ':' + mid, fid);
        return { html: c, atts: await attsOf(fid, base), fid, base, acc: acc.id, via: 'api' };
      } catch (e) { trace.push(`api ${base || 'conn'} ${fid}: ${e.message.slice(0, 140)}`); if (!/invalid|not found|404|URL_RULE|does not exist|folder|message/i.test(e.message)) break; }
    }
  }
  return null;
}
const ZBASE = new Map();
