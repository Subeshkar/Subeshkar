// Business: money owed to you (Zoho Books invoices), what you owe (bills), purchase orders, payments received,
// CRM leads and deals (Zoho CRM), and opportunity follow-ups found in WhatsApp. Read only.
import { all } from './db.js';
import * as A from './apps.js';

const C = new Map(); // uid -> { at, data }
const arr = (d) => A.arrayIn(d) || [];
const num = (v) => Number(String(v ?? 0).replace(/[^0-9.-]/g, '')) || 0;
const DAY = 864e5;

async function org(uid) {
  const k = uid + ':org'; if (C.has(k)) return C.get(k);
  const o = arr(await A.runFill(uid, 'ZOHO_BOOKS_LIST_ORGANIZATIONS', {}));
  const v = String((o.find((x) => x.is_default_org) || o[0] || {}).organization_id || '');
  if (v) C.set(k, v); return v;
}

export async function overview(uid, force) {
  const c = C.get(uid + ':all'); if (!force && c && Date.now() - c.at < 5 * 60e3) return c.data;
  const on = (await A.connected(uid)).map((x) => x.slug);
  const today = new Date().toISOString().slice(0, 10);
  const out = { books: on.includes('zoho_books'), crm: on.includes('zoho'), invoices: [], bills: [], pos: [], payments: [], leads: [], deals: [], followups: [], errors: [], totals: {} };
  if (out.books) {
    try {
      const oid = await org(uid); if (!oid) throw new Error('no organization found');
      const f = { 'organization_id': oid, 'per_page': 100 };
      const [inv, bil, po, pay] = await Promise.all([
        A.runFill(uid, 'ZOHO_BOOKS_LIST_INVOICES', f).catch((e) => (out.errors.push('Invoices: ' + e.message), [])),
        A.runFill(uid, 'ZOHO_BOOKS_LIST_BILLS', f).catch((e) => (out.errors.push('Bills: ' + e.message), [])),
        A.runFill(uid, 'ZOHO_BOOKS_LIST_PURCHASE_ORDERS', f).catch((e) => (out.errors.push('Purchase orders: ' + e.message), [])),
        A.runFill(uid, 'ZOHO_BOOKS_LIST_CUSTOMER_PAYMENTS', f).catch(() => []),
      ]);
      out.invoices = arr(inv).map((x) => ({ id: x.invoice_id, no: x.invoice_number, who: x.customer_name, customerId: x.customer_id, email: x.email || '', status: x.status, date: x.date, due: x.due_date, total: num(x.total), balance: num(x.balance), cur: x.currency_code || 'AED' }));
      out.invoices.forEach((x) => { x.overdue = x.balance > 0 && x.due && x.due < today; x.days = x.overdue ? Math.round((Date.parse(today) - Date.parse(x.due)) / DAY) : 0; });
      out.bills = arr(bil).map((x) => ({ id: x.bill_id, no: x.bill_number, who: x.vendor_name, status: x.status, due: x.due_date, total: num(x.total), balance: num(x.balance), cur: x.currency_code || 'AED' }));
      out.bills.forEach((x) => { x.overdue = x.balance > 0 && x.due && x.due < today; });
      out.pos = arr(po).map((x) => ({ id: x.purchaseorder_id, no: x.purchaseorder_number, who: x.vendor_name, status: x.status, date: x.date, due: x.delivery_date, total: num(x.total), cur: x.currency_code || 'AED' }));
      out.payments = arr(pay).slice(0, 30).map((x) => ({ id: x.payment_id, who: x.customer_name, date: x.date, amount: num(x.amount), mode: x.payment_mode || '', cur: x.currency_code || 'AED' }));
    } catch (e) { out.errors.push('Zoho Books: ' + e.message); }
  }
  if (out.crm) {
    const [ld, dl] = await Promise.all([
      A.runFill(uid, 'ZOHO_LIST_LEADS', { 'per_page': 50, 'sort_by': 'Modified_Time', 'sort_order': 'desc' }).catch((e) => (out.errors.push('Leads: ' + e.message), [])),
      A.runFill(uid, 'ZOHO_LIST_DEALS', { 'per_page': 50, 'sort_by': 'Modified_Time', 'sort_order': 'desc' }).catch((e) => (out.errors.push('Deals: ' + e.message), [])),
    ]);
    out.leads = arr(ld).map((x) => ({ id: x.id, who: [x.First_Name, x.Last_Name].filter(Boolean).join(' ') || x.Full_Name || '', company: x.Company || '', status: x.Lead_Status || '', email: x.Email || '', phone: x.Mobile || x.Phone || '', at: Date.parse(x.Modified_Time || x.Created_Time || 0) || 0 }));
    out.deals = arr(dl).map((x) => ({ id: x.id, name: x.Deal_Name || '', stage: x.Stage || '', amount: num(x.Amount), close: x.Closing_Date || '', who: x.Account_Name?.name || x.Contact_Name?.name || '', at: Date.parse(x.Modified_Time || 0) || 0 }));
  }
  // Opportunity follow-ups: people you wrote to on WhatsApp 3 to 30 days ago who never answered.
  try {
    const now = Date.now();
    out.followups = all(`SELECT c.jid, COALESCE(c.name, ct.name) nm, c.last_text, c.last_at FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.user_id = c.user_id AND ct.jid = c.jid
      WHERE c.user_id = ? AND c.is_group = 0 AND c.last_from_me = 1 AND c.last_at BETWEEN ? AND ? ORDER BY c.last_at DESC LIMIT 25`, uid, now - 30 * DAY, now - 3 * DAY)
      .filter((x) => x.nm).map((x) => ({ jid: x.jid, who: x.nm, said: String(x.last_text || '').slice(0, 200), at: x.last_at }));
  } catch {}
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  out.totals = {
    owed: sum(out.invoices, (x) => x.balance), overdue: sum(out.invoices.filter((x) => x.overdue), (x) => x.balance),
    youOwe: sum(out.bills, (x) => x.balance), openPOs: out.pos.filter((x) => !/billed|closed|cancel/i.test(x.status || '')).length,
    pipeline: sum(out.deals.filter((x) => !/closed/i.test(x.stage)), (x) => x.amount), cur: (out.invoices[0] || out.bills[0] || {}).cur || 'AED',
  };
  C.set(uid + ':all', { at: Date.now(), data: out });
  return out;
}

// ---------- Create and email invoices in Zoho Books (only after the person taps Create / Send) ----------
const pickTool = async (re) => A.findTool('zoho_books', re);
export async function customers(uid, q) {
  const oid = await org(uid); if (!oid) throw new Error('Zoho Books has no organization yet.');
  const t = (await pickTool(/^ZOHO_BOOKS_LIST_CONTACTS$/)) || (await pickTool(/LIST_CONTACTS|LIST_CUSTOMERS/));
  const d = await A.runFill(uid, t, { 'organization_id': oid, 'search_text|contact_name_contains|contact_name': String(q || '').slice(0, 60), 'contact_type': 'customer', 'per_page': 50 });
  const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return arr(d).map((x) => ({ id: String(x.contact_id), name: x.contact_name || x.company_name || '', email: x.email || '', company: x.company_name || '' }))
    .map((x) => ({ ...x, score: words.filter((w) => (x.name + ' ' + x.company).toLowerCase().includes(w)).length }))
    .filter((x) => !words.length || x.score).sort((a, b) => b.score - a.score).slice(0, 8);
}
async function vatId(uid, oid) {
  const t = await pickTool(/LIST_TAXES$/); if (!t) return '';
  const d = await A.runFill(uid, t, { 'organization_id': oid }).catch(() => []);
  const x = arr(d).find((v) => Number(v.tax_percentage) === 5) || arr(d).find((v) => /vat/i.test(v.tax_name || ''));
  return x ? String(x.tax_id) : '';
}
export async function createInvoice(uid, b) {
  const oid = await org(uid); if (!oid) throw new Error('Zoho Books has no organization yet.');
  let cid = String(b.customer_id || '');
  if (!cid) { const c = await customers(uid, b.customer); if (!c.length) throw Object.assign(new Error(`No customer called "${b.customer}" in Zoho Books. Add them in Zoho Books first, or check the name.`), { status: 404 }); if (c.length > 1 && c[0].score === c[1].score) throw Object.assign(new Error('Pick the customer'), { status: 409, choices: c }); cid = c[0].id; }
  const tax = b.vat === false ? '' : await vatId(uid, oid);
  const items = (b.items || []).slice(0, 30).map((x) => ({ name: String(x.name || 'Service').slice(0, 100), description: String(x.description || '').slice(0, 1000), rate: Number(x.rate) || 0, quantity: Number(x.quantity) || 1, ...(tax ? { tax_id: tax } : {}) }));
  if (!items.length || !items.some((x) => x.rate)) throw Object.assign(new Error('The invoice has no amounts.'), { status: 400 });
  const t = await pickTool(/^ZOHO_BOOKS_CREATE_INVOICE$/) || await pickTool(/CREATE_INVOICE$/); if (!t) throw new Error('Creating invoices is not available for this Zoho Books connection yet.');
  const d = await A.runFill(uid, t, { 'organization_id': oid, 'customer_id': cid, 'line_items': items, 'date': b.date || new Date().toISOString().slice(0, 10), 'notes': String(b.notes || '').slice(0, 2000), 'reference_number': String(b.reference || '').slice(0, 50) });
  const inv = d?.data?.invoice || d?.invoice || d?.data || d || {};
  C.delete(uid + ':all');
  return { id: String(inv.invoice_id || ''), no: inv.invoice_number || '', total: num(inv.total), cur: inv.currency_code || 'AED', taxed: !!tax, customerId: cid, email: inv.email || '' };
}
export async function emailInvoice(uid, id, to, cc, subject, body) {
  const oid = await org(uid); const t = await pickTool(/^ZOHO_BOOKS_EMAIL_(AN_)?INVOICE$/) || await pickTool(/EMAIL.*INVOICE/); if (!t) throw new Error('Emailing invoices from Zoho Books is not available yet. Send it from Zoho Books.');
  const list = (s) => String(s || '').split(/[,;\s]+/).filter((e) => /@/.test(e));
  await A.runFill(uid, t, { 'organization_id': oid, 'invoice_id': id, 'to_mail_ids': list(to), 'cc_mail_ids': list(cc), 'subject': subject || '', 'body': body || '', 'send_from_org_email_id': false });
  C.delete(uid + ':all'); return { ok: true };
}
