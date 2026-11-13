// RedexGo mail (Zoho) read access for Dioma. Zoho's Claude connector can only send, so the owner
// connects a Zoho "Self Client" here once; the server keeps the refresh token on the data volume.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpToken } from './mcp.js';

// svc 'mail' (RedexGo mail, read) or 'books' (Zoho Books). Each has its own saved login.
const FILE = (svc = 'mail') => path.join(process.env.DATA_DIR || './data', svc === 'books' ? 'zoho-books.json' : svc === 'cal' ? 'zoho-cal.json' : 'zoho.json');
const load = (svc) => { try { return JSON.parse(fs.readFileSync(FILE(svc), 'utf8')); } catch { return {}; } };
const store = (o, svc) => { fs.mkdirSync(path.dirname(FILE(svc)), { recursive: true }); fs.writeFileSync(FILE(svc), JSON.stringify(o), { mode: 0o600 }); };
const SCOPE = { mail: 'ZohoMail.messages.READ,ZohoMail.accounts.READ,ZohoMail.folders.READ', books: 'ZohoBooks.fullaccess.all,ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.users.READ', cal: 'ZohoCalendar.calendar.READ,ZohoCalendar.event.READ' };
const SCOPES = SCOPE.mail;

export const zohoToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-zoho').digest('hex').slice(0, 32);
export const zohoSetupLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/zoho/${zohoToken()}`;
export const zohoLinked = (svc) => !!load(svc).refresh_token;
export const booksSetupLink = () => zohoSetupLink() + '?svc=books';
export const calSetupLink = () => zohoSetupLink() + '?svc=cal';

// ---- Zoho Calendar (business calendar, read only) ----
const zcalTime = (v) => { const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/.exec(String(v || '')); if (!m) return ''; if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`; const tz = !m[7] ? '+04:00' : m[7] === 'Z' ? 'Z' : m[7].slice(0, 3) + ':' + m[7].slice(3); return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`; };
const zfmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
async function zcal(p) {
  const c = load('cal');
  const res = await fetch(`${c.cal || 'https://calendar.zoho.com/api/v1'}${p}`, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken('cal') } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('Zoho Calendar: ' + ((j.error && (j.error.message || j.error.description || JSON.stringify(j.error))) || res.status));
  return j;
}
export async function zcalEvents(startIso, endIso) {
  if (!load('cal').refresh_token) return { linked: false, setup: calSetupLink() };
  const cals = ((await zcal('/calendars')).calendars || []).filter((x) => x.status !== false);
  const range = JSON.stringify({ start: zfmt(new Date(startIso)), end: zfmt(new Date(endIso)) });
  const out = [];
  for (const k of cals.slice(0, 6)) {
    try {
      const j = await zcal(`/calendars/${encodeURIComponent(k.uid)}/events?` + new URLSearchParams({ range }));
      for (const e of j.events || []) { const d = e.dateandtime || {}; out.push({ id: e.uid, title: e.title || '(no title)', start: zcalTime(d.start), end: zcalTime(d.end), allDay: !!e.isallday, location: e.location || '', calendar: k.name || 'Zoho', attendees: (e.attendees || []).length }); }
    } catch {}
  }
  return { linked: true, events: out.sort((a, b) => String(a.start).localeCompare(String(b.start))) };
}

const accessBy = {}; // svc -> { token, exp }
let access = null;
async function accessToken(svc = 'mail') {
  const c = load(svc); if (!c.refresh_token) throw new Error(svc === 'books' ? 'Zoho Books is not connected yet.' : 'RedexGo mail is not connected yet.');
  if (svc === 'mail' && access && access.exp > Date.now() + 60000) return access.token;
  if (svc !== 'mail' && accessBy[svc] && accessBy[svc].exp > Date.now() + 60000) return accessBy[svc].token;
  const u = new URL(`${c.accounts || 'https://accounts.zoho.com'}/oauth/v2/token`);
  u.search = new URLSearchParams({ refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' });
  const j = await (await fetch(u, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho refused the saved login (' + (j.error || 'unknown') + '). Connect it again.');
  const v = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  if (svc === 'mail') access = v; else accessBy[svc] = v;
  return v.token;
}
async function api(p) {
  const c = load();
  const res = await fetch(`${c.api || 'https://mail.zoho.com'}/api${p}`, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken() } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.status && j.status.code >= 400)) throw new Error('Zoho: ' + ((j.data && (j.data.errorCode || j.data.moreInfo)) || res.status));
  return j.data;
}
async function account() {
  const c = load(); if (c.accountId && c.folders) return c;
  const accts = await api('/accounts'); const a = accts[0];
  const folders = await api(`/accounts/${a.accountId}/folders`);
  const pick = (t) => (folders.find((f) => (f.folderType || '').toLowerCase() === t || (f.folderName || '').toLowerCase() === t) || {}).folderId;
  const n = { ...c, accountId: a.accountId, email: a.primaryEmailAddress || a.mailboxAddress, folders: { inbox: pick('inbox'), sent: pick('sent') } };
  store(n); return n;
}

// ---- Zoho Books ----
async function books(p, opts = {}, orgOverride) {
  const c = load('books');
  let org = orgOverride || c.org;
  if (!org) {
    const r = await fetch(`${c.books || 'https://www.zohoapis.com/books/v3'}/organizations`, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken('books') } });
    const j = await r.json(); const o = (j.organizations || []).find((x) => x.is_default_org) || (j.organizations || [])[0];
    if (!o) throw new Error('No Zoho Books organization found.');
    org = o.organization_id; store({ ...c, org, org_name: o.name, currency: o.currency_code }, 'books');
  }
  const sep = p.includes('?') ? '&' : '?';
  const res = await fetch(`${c.books || 'https://www.zohoapis.com/books/v3'}${p}${sep}organization_id=${org}`, { ...opts, headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken('books'), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && j.code !== 0)) throw new Error('Zoho Books: ' + (j.message || res.status));
  return j;
}
export async function booksSummary() {
  const c = load('books'); if (!c.refresh_token) return { linked: false, setup: booksSetupLink() };
  const [over, unpaid, bills] = await Promise.all([books('/invoices?status=overdue&per_page=50&sort_column=due_date'), books('/invoices?status=unpaid&per_page=100'), books('/bills?status=unpaid&per_page=100').catch(() => ({ bills: [] }))]);
  const pick = (i) => ({ id: i.invoice_id, number: i.invoice_number, customer: i.customer_name, customer_id: i.customer_id, total: i.total, balance: i.balance, currency: i.currency_code, date: i.date, due: i.due_date, days_overdue: i.due_date ? Math.max(0, Math.round((Date.now() - new Date(i.due_date).getTime()) / 864e5)) : 0, status: i.status, email: i.email || '' });
  const o2 = load('books');
  return { linked: true, org: o2.org_name, currency: o2.currency, overdue: (over.invoices || []).map(pick), unpaid: (unpaid.invoices || []).map(pick), bills: (bills.bills || []).map((b) => ({ id: b.bill_id, number: b.bill_number, vendor: b.vendor_name, total: b.total, balance: b.balance, date: b.date, due: b.due_date, status: b.status })) };
}
// Record a customer payment against an invoice (only after the owner taps Record in Dioma).
export async function booksRecordPayment({ customer_id, invoice_id, amount, date, reference }) {
  const j = await books('/customerpayments', { method: 'POST', body: JSON.stringify({ customer_id, payment_mode: 'banktransfer', amount: Number(amount), date, reference_number: reference ? String(reference).slice(0, 50) : undefined, invoices: [{ invoice_id, amount_applied: Number(amount) }] }) });
  return { ok: true, payment_id: j.payment && j.payment.payment_id };
}
// ---- Invoices from Dioma (create as draft, email only after the owner approves) ----
export async function booksOrgs() {
  const c = load('books');
  const r = await fetch(`${c.books || 'https://www.zohoapis.com/books/v3'}/organizations`, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken('books') } });
  const j = await r.json(); return { default: c.org, orgs: (j.organizations || []).map((o) => ({ id: o.organization_id, name: o.name, currency: o.currency_code, email: o.email, is_default: !!o.is_default_org })) };
}
export async function booksFindContacts(q, org) {
  const ql = String(q || '').toLowerCase().trim(); const all = [];
  for (let page = 1; page <= 5; page++) {
    const j = await books(`/contacts?per_page=200&page=${page}`, {}, org);
    for (const c of j.contacts || []) if ([c.contact_name, c.company_name, c.email, c.first_name, c.last_name].some((x) => String(x || '').toLowerCase().includes(ql))) all.push(c);
    if (!(j.page_context && j.page_context.has_more_page)) break;
  }
  return { contacts: all.slice(0, 10).map((c) => ({ id: c.contact_id, name: c.contact_name, company: c.company_name, email: c.email, phone: c.mobile || c.phone })) };
}
// UAE VAT 5% — always applied to Dioma invoices unless vat === false.
async function vatTaxId(org) {
  const j = await books('/settings/taxes', {}, org);
  const t = (j.taxes || []).find((x) => Number(x.tax_percentage) === 5 && !x.is_tax_group) || (j.taxes || []).find((x) => Number(x.tax_percentage) === 5);
  if (!t) throw new Error('No 5% VAT tax found in Zoho Books');
  return t.tax_id;
}
export async function booksAddVat(invoice_id, org) {
  const tax = await vatTaxId(org);
  const j = await books('/invoices/' + invoice_id, {}, org); const v = j.invoice || {};
  const line_items = (v.line_items || []).map((li) => ({ line_item_id: li.line_item_id, item_id: li.item_id || undefined, name: li.name, description: li.description, rate: li.rate, quantity: li.quantity, tax_id: tax }));
  const u = await books('/invoices/' + invoice_id, { method: 'PUT', body: JSON.stringify({ customer_id: v.customer_id, line_items, reason: 'Added 5% UAE VAT' }) }, org);
  const w = u.invoice || {}; return { ok: true, number: w.invoice_number, total: w.total, tax_total: w.tax_total, status: w.status };
}
export async function booksCreateInvoice({ org, customer_id, items, date, notes, reference, vat }) {
  const body = { customer_id, date: date || new Date().toISOString().slice(0, 10), reference_number: reference ? String(reference).slice(0, 50) : undefined, notes: notes || undefined,
    line_items: (items || []).map((i) => ({ name: String(i.name || 'Transport service').slice(0, 100), description: i.description ? String(i.description).slice(0, 2000) : undefined, rate: Number(i.rate), quantity: Number(i.quantity || 1) })) };
  if (vat !== false) { const tax = await vatTaxId(org); body.line_items.forEach((li) => { li.tax_id = tax; }); }
  const j = await books('/invoices', { method: 'POST', body: JSON.stringify(body) }, org);
  const v = j.invoice || {};
  return { ok: true, invoice_id: v.invoice_id, number: v.invoice_number, sub_total: v.sub_total, tax_total: v.tax_total, total: v.total, currency: v.currency_code, customer: v.customer_name, status: v.status };
}
export async function booksEmailInvoice({ org, invoice_id, to, cc, subject, body }) {
  // Sent by Zoho Books from info@redexgo.com with the invoice PDF attached; info@ is always CC'd so it lands in the RedexGo mailbox too.
  const ccs = [...new Set([].concat(cc || []).filter(Boolean).concat(['info@redexgo.com']).map((x) => String(x).trim()))];
  const payload = { send_from_org_email_id: true, send_attachment: true, to_mail_ids: [].concat(to || []).filter(Boolean), cc_mail_ids: ccs };
  if (subject) payload.subject = subject; if (body) payload.body = body;
  await books(`/invoices/${invoice_id}/email`, { method: 'POST', body: JSON.stringify(payload) }, org);
  return { ok: true };
}
export async function booksGetInvoice(idOrNumber, org) {
  let id = idOrNumber;
  if (!/^\d{10,}$/.test(String(idOrNumber))) { const j = await books('/invoices?invoice_number=' + encodeURIComponent(idOrNumber), {}, org); id = ((j.invoices || [])[0] || {}).invoice_id; if (!id) throw new Error('Invoice ' + idOrNumber + ' not found'); }
  const j = await books('/invoices/' + id, {}, org); const v = j.invoice || {};
  return { invoice_id: v.invoice_id, number: v.invoice_number, status: v.status, customer: v.customer_name, customer_id: v.customer_id, total: v.total, currency: v.currency_code, date: v.date, is_emailed: !!v.is_emailed, last_sent: (v.mail_history || v.comments || []).slice(0, 3) };
}
// ---- Zoho CRM (same login as Books) ----
async function crm(p) {
  const c = load('books');
  const base = (c.books || 'https://www.zohoapis.com/books/v3').replace(/\/books\/v3$/, '') + '/crm/v6';
  const res = await fetch(base + p, { headers: { Authorization: 'Zoho-oauthtoken ' + await accessToken('books') } });
  if (res.status === 204) return { data: [] };
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Zoho CRM: ' + (j.message || j.code || res.status));
  return j;
}
export async function crmSummary() {
  const c = load('books'); if (!c.refresh_token) return { linked: false, setup: booksSetupLink() };
  const [deals, leads] = await Promise.all([
    crm('/Deals?fields=Deal_Name,Stage,Amount,Closing_Date,Account_Name,Contact_Name,Modified_Time,Next_Step&per_page=60&sort_by=Modified_Time&sort_order=desc').catch((e) => ({ error: String(e.message) })),
    crm('/Leads?fields=Full_Name,Company,Email,Phone,Mobile,Lead_Status,Lead_Source,Created_Time,Modified_Time&per_page=40&sort_by=Modified_Time&sort_order=desc').catch((e) => ({ error: String(e.message) }))
  ]);
  const nm = (x) => (x && typeof x === 'object' ? x.name : x) || '';
  return {
    linked: true,
    error: deals.error && leads.error ? deals.error : undefined,
    deals: (deals.data || []).map((d) => ({ id: d.id, name: d.Deal_Name, stage: d.Stage, amount: d.Amount, close: d.Closing_Date, account: nm(d.Account_Name), contact: nm(d.Contact_Name), next: d.Next_Step || '', updated: d.Modified_Time })),
    leads: (leads.data || []).map((l) => ({ id: l.id, name: l.Full_Name, company: l.Company, email: l.Email, phone: l.Mobile || l.Phone, status: l.Lead_Status, source: l.Lead_Source, created: l.Created_Time, updated: l.Modified_Time }))
  };
}
// All invoices ever (not void): how much was billed, paid and still open, by month and by client.
export async function booksInvoiceTotals() {
  const c = load('books'); if (!c.refresh_token) return { linked: false };
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await books(`/invoices?per_page=200&page=${page}`);
    all.push(...(j.invoices || []));
    if (!j.page_context || !j.page_context.has_more_page) break;
  }
  const live = all.filter((i) => !/void|draft/i.test(i.status));
  const sum = (l, k) => Math.round(l.reduce((a, i) => a + (Number(i[k]) || 0), 0) * 100) / 100;
  const byMonth = {}, byClient = {};
  for (const i of live) { const m = String(i.date).slice(0, 7); byMonth[m] = (byMonth[m] || 0) + Number(i.total || 0); byClient[i.customer_name] = (byClient[i.customer_name] || 0) + Number(i.total || 0); }
  return { linked: true, count: live.length, drafts: all.filter((i) => /draft/i.test(i.status)).length, invoiced: sum(live, 'total'), open: sum(live, 'balance'), paid: Math.round((sum(live, 'total') - sum(live, 'balance')) * 100) / 100, from: live.map((i) => i.date).sort()[0], to: live.map((i) => i.date).sort().slice(-1)[0], byMonth: Object.entries(byMonth).sort(), byClient: Object.entries(byClient).sort((a, b) => b[1] - a[1]).slice(0, 15) };
}
// Balance sheet from the chart of accounts (with balances): deposits, fixed assets, loans, payables…
export async function booksBalances() {
  const c = load('books'); if (!c.refresh_token) return { linked: false };
  const j = await books('/chartofaccounts?showbalance=true&per_page=500');
  const acc = (j.chartofaccounts || []).filter((a) => a.is_active !== false).map((a) => ({ name: a.account_name, type: a.account_type, balance: Number(a.current_balance ?? a.balance ?? 0) })).filter((a) => a.balance);
  return { linked: true, org: c.org_name, currency: c.currency, accounts: acc };
}
export async function booksContact(id) {
  const j = await books(`/contacts/${id}`);
  const ct = j.contact || {};
  return { name: ct.contact_name, company: ct.company_name, email: ct.email, phone: ct.mobile || ct.phone, persons: (ct.contact_persons || []).map((p) => ({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email, phone: p.mobile || p.phone })) };
}

// folder: action|unread|all|sent ; q: search text
export async function zohoList(folder = 'all', q = '') {
  const a = await account();
  const qs = new URLSearchParams({ limit: '40', folderId: folder === 'sent' ? a.folders.sent : a.folders.inbox });
  if (folder === 'unread') qs.set('status', 'unread');
  let rows;
  if (q) rows = await api(`/accounts/${a.accountId}/messages/search?` + new URLSearchParams({ searchKey: `entire:${q}`, limit: '40' }));
  else rows = await api(`/accounts/${a.accountId}/messages/view?` + qs);
  const de = (x) => String(x || '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return (rows || []).map((m) => ({ ...m, subject: de(m.subject), summary: de(m.summary), sender: de(m.sender), toAddress: de(m.toAddress) })).map((m) => ({ id: m.messageId, folderId: m.folderId, threadId: m.threadId || m.messageId, subject: m.subject || '(no subject)', from: m.sender && m.sender !== m.fromAddress ? `${m.sender} <${m.fromAddress}>` : m.fromAddress, fromEmail: m.fromAddress, to: m.toAddress, date: m.receivedTime ? new Date(Number(m.receivedTime)).toISOString() : '', snippet: String(m.summary || '').slice(0, 300), unread: m.status === '0' || m.status === 0 }));
}
export async function zohoRead(folderId, messageId) {
  const a = await account();
  const d = await api(`/accounts/${a.accountId}/folders/${folderId}/messages/${messageId}/content`);
  const text = String(d.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  return { messageId, body: text.slice(0, 6000) };
}

const ok = (req, res, next) => {
  const a = Buffer.from(String(req.params.t)), b = Buffer.from(zohoToken());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found');
  next();
};
const page = (msg = '', svc = 'mail') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${svc === 'books' ? 'Connect Zoho Books and CRM' : svc === 'cal' ? 'Connect RedexGo calendar' : 'Connect RedexGo mail'}</title>
<style>body{margin:0;background:#f6f4ee;color:#16181d;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:560px;margin:auto}h1{font-size:22px}ol{padding-left:20px}li{margin:8px 0}code{background:#ece8dc;padding:2px 6px;border-radius:6px;word-break:break-all}label{display:block;font-weight:600;margin-top:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:10px;font-size:15px}button{margin-top:18px;background:#16181d;color:#fff;border:0;border-radius:12px;padding:14px 20px;font-size:16px;font-weight:600}.m{padding:12px;border-radius:10px;background:#fff3c4;margin:12px 0}</style></head><body><main>
<h1>${svc === 'books' ? 'Connect Zoho Books + Zoho CRM to Dioma' : svc === 'cal' ? 'Connect your Zoho (RedexGo) calendar to Dioma' : 'Connect RedexGo mail to Dioma'}</h1>${msg ? `<div class="m">${msg}</div>` : ''}
<p>${zohoLinked(svc) ? '✅ Connected. You can connect again below to replace it.' : 'One time, about 3 minutes.'}</p>
<ol><li>Open <a href="https://api-console.zoho.com" target="_blank" rel="noopener">api-console.zoho.com</a> and sign in as info@redexgo.com.</li>
<li>Tap <b>Add Client</b> → <b>Self Client</b> → Create → OK.</li>
<li>In <b>Generate Code</b>, paste this scope:<br><code>${SCOPE[svc]}</code><br>Time duration: <b>10 minutes</b>, description: <b>Dioma</b> → Create → choose the redexgo portal if asked → copy the code.</li>
<li>Open the <b>Client Secret</b> tab and copy the Client ID and Client Secret.</li>
<li>Paste all three below and tap Connect (within 10 minutes).</li></ol>
<form method="post"><label>Client ID<input name="client_id" required autocomplete="off"></label><label>Client Secret<input name="client_secret" required autocomplete="off"></label><label>Code<input name="code" required autocomplete="off"></label><button>Connect</button></form>
</main></body></html>`;

export let zohoLastTry = {};
export function mountZoho(app) {
  const svcOf = (req) => (req.query.svc === 'books' ? 'books' : req.query.svc === 'cal' ? 'cal' : 'mail');
  app.get('/zoho/:t', ok, (req, res) => res.set('Cache-Control', 'no-store').send(page('', svcOf(req))));
  app.post('/zoho/:t', ok, express.urlencoded({ extended: false }), async (req, res) => {
    const { client_id, client_secret, code } = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v || '').trim()]));
    const svc = svcOf(req);
    zohoLastTry = { at: new Date().toISOString(), svc, step: 'submitted' };
    if (!client_id || !client_secret || !code) return res.send(page('Please fill in all three.', svc));
    try {
      const u = new URL('https://accounts.zoho.com/oauth/v2/token');
      u.search = new URLSearchParams({ code, client_id, client_secret, grant_type: 'authorization_code' });
      const j = await (await fetch(u, { method: 'POST' })).json();
      zohoLastTry.step = j.refresh_token ? 'token ok' : 'zoho refused: ' + (j.error || 'no refresh token');
      if (!j.refresh_token) return res.send(page('Zoho said: ' + (j.error || 'no refresh token') + '. Make a new code (step 3) and try again quickly.', svc));
      if (svc === 'books') {
        store({ client_id, client_secret, refresh_token: j.refresh_token, accounts: 'https://accounts.zoho.com', books: (j.api_domain || 'https://www.zohoapis.com') + '/books/v3' }, 'books'); accessBy.books = null;
        const sm = await booksSummary();
        const cr = await crmSummary().catch(() => ({ deals: [], leads: [] }));
        return res.send(page(`✅ Connected to Zoho Books (${sm.org}): ${sm.unpaid.length} unpaid invoices, ${sm.overdue.length} overdue. Zoho CRM: ${(cr.deals || []).length} deals, ${(cr.leads || []).length} leads. You can close this page.`, 'books'));
      }
      if (svc === 'cal') {
        const dc = j.api_domain && /zohoapis\.([\w.]+)$/.exec(j.api_domain);
        store({ client_id, client_secret, refresh_token: j.refresh_token, accounts: 'https://accounts.zoho.com', cal: `https://calendar.zoho.${dc ? dc[1] : 'com'}/api/v1` }, 'cal'); accessBy.cal = null;
        const s0 = new Date(); s0.setHours(0, 0, 0, 0); const e0 = new Date(s0.getTime() + 2 * 864e5);
        const r = await zcalEvents(s0.toISOString(), e0.toISOString());
        return res.send(page(`✅ Connected to your Zoho (RedexGo) calendar: ${(r.events || []).length} events today and tomorrow. You can close this page.`, 'cal'));
      }
      const api = j.api_domain && /zohoapis\.(\w+(\.\w+)?)$/.test(j.api_domain) ? j.api_domain.replace('www.zohoapis', 'mail.zoho') : 'https://mail.zoho.com';
      store({ client_id, client_secret, refresh_token: j.refresh_token, accounts: 'https://accounts.zoho.com', api });
      access = null;
      const list = await zohoList('all');
      res.send(page(`✅ Connected. Dioma can read RedexGo mail now (${list.length} recent emails found). You can close this page.`));
    } catch (e) { zohoLastTry.step = 'error: ' + String(e.message || e); res.send(page('Something went wrong: ' + String(e.message || e), svc)); }
  });
}
