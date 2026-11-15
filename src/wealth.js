// Wealth: bank accounts and cards (personal, business, family), statements in, spending out.
// Only a nickname, bank name and the last 4 digits are stored. Never full account or card numbers, never bank passwords.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { db, all, one, run } from './db.js';
const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
// PDF to text, one line per printed row (items grouped by their vertical position).
async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableWorker: true, isEvalSupported: false, verbosity: 0 }).promise;
  const lines = [];
  for (let n = 1; n <= Math.min(doc.numPages, 60); n++) {
    const c = await (await doc.getPage(n)).getTextContent(), rows = new Map();
    for (const i of c.items) { if (!i.str.trim()) continue; const y = Math.round(i.transform[5] / 3) * 3; (rows.get(y) || rows.set(y, []).get(y)).push([i.transform[4], i.str]); }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, it]) => lines.push(it.sort((a, b) => a[0] - b[0]).map((x) => x[1].trim()).join(' ')));
  }
  return lines.join('\n');
}
const XLSX = require('xlsx');

db.exec(`
CREATE TABLE IF NOT EXISTS w_accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, bank TEXT, last4 TEXT, currency TEXT DEFAULT 'AED', created INTEGER);
CREATE TABLE IF NOT EXISTS w_tx (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INTEGER NOT NULL REFERENCES w_accounts(id) ON DELETE CASCADE, at INTEGER NOT NULL, description TEXT, amount REAL NOT NULL, category TEXT, hash TEXT NOT NULL, UNIQUE (account_id, hash));
CREATE INDEX IF NOT EXISTS w_tx_user_at ON w_tx (user_id, at);
`);

const KINDS = ['bank', 'card'], OWNERS = ['personal', 'business', 'family'];
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export function addAccount(uid, b) {
  const kind = KINDS.includes(b.kind) ? b.kind : 'bank', owner = OWNERS.includes(b.owner) ? b.owner : 'personal';
  const name = String(b.name || '').trim().slice(0, 60), bank = String(b.bank || '').trim().slice(0, 60);
  const last4 = String(b.last4 || '').replace(/\D/g, '');
  if (!name) throw bad('Give it a name, for example "Salary account".');
  if (last4 && last4.length !== 4) throw bad('Only the last 4 digits, please. Never the full number.');
  const cur = /^[A-Z]{3}$/.test(b.currency || '') ? b.currency : 'AED';
  const r = run('INSERT INTO w_accounts (user_id, kind, owner, name, bank, last4, currency, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, kind, owner, name, bank, last4 || null, cur, Date.now());
  return { id: Number(r.lastInsertRowid) };
}
export const removeAccount = (uid, id) => run('DELETE FROM w_accounts WHERE id = ? AND user_id = ?', id, uid);

// ---- categories (simple keyword rules; works without AI)
const CATS = [
  ['Income', /salary|payroll|sal cr|inward remit|refund|cashback|interest credit/i],
  ['Food & dining', /talabat|deliveroo|careem food|noon food|zomato|instashop|restaurant|cafe|coffee|starbucks|mcdonald|kfc|burger|pizza|shawarma|bakery/i],
  ['Groceries', /carrefour|lulu|spinneys|waitrose|choithrams|union coop|co-?op|grocery|supermarket|viva|west zone|nesto/i],
  ['Transport', /careem|uber|salik|rta|nol|parkin|parking|enoc|adnoc|emarat|eppco|petrol|fuel|taxi|metro/i],
  ['Bills & utilities', /\bdu\b|etisalat|\be&\b|dewa|sewa|addc|aadc|fewa|empower|internet|mobile bill|telecom/i],
  ['Shopping', /amazon|noon|namshi|shein|ikea|centrepoint|max fashion|h&m|zara|apple store|sharaf|jumbo/i],
  ['Subscriptions', /netflix|spotify|youtube|apple\.com|icloud|google|openai|anthropic|claude|chatgpt|microsoft|adobe|canva|osn|shahid/i],
  ['Health', /pharmacy|aster|life pharmacy|boots|clinic|hospital|medical|dental|insurance/i],
  ['Rent & home', /rent|ejari|real estate|property|maintenance/i],
  ['Cash', /atm|cash withdrawal|cash wdl/i],
  ['Transfers', /transfer|trf|ipp|aani|remittance|exchange house|al ansari|lulu exchange|western union/i],
  ['Fees', /fee|charge|commission|vat on|late payment|finance charge/i],
];
const categorize = (d, amt) => (/payment.*thank you|card payment|cc payment/i.test(d) ? 'Transfers' : amt > 0 && /salary|payroll|refund|credit|cashback|deposit|inward/i.test(d) ? 'Income' : (CATS.find(([, re]) => re.test(d)) || ['Other'])[0]);

// ---- parsing
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s) {
  if (s instanceof Date) return +s;
  if (typeof s === 'number' && s > 20000 && s < 80000) return Date.UTC(1899, 11, 30) + s * 864e5; // Excel serial
  s = String(s || '').trim(); let m;
  if ((m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})/))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return Date.UTC(y, +m[2] - 1, +m[1]); } // day first (UAE)
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[\-\/ ]([A-Za-z]{3})[A-Za-z]*[\-\/ ,]*(\d{2,4})/))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const mo = MON[m[2].toLowerCase()]; if (mo !== undefined) return Date.UTC(y, mo, +m[1]); }
  return NaN;
}
const num = (v) => { if (typeof v === 'number') return v; const s = String(v || '').replace(/[, ]|AED|USD/gi, ''); const neg = /^\(.*\)$/.test(s) || /DR$/i.test(s) || s.startsWith('-'); const n = parseFloat(s.replace(/[()]|CR$|DR$/gi, '').replace(/^-/, '')); return isNaN(n) ? NaN : (neg ? -n : n); };

function fromRows(rows) {
  // find the header row
  let h = -1, cols = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i].map((c) => String(c || '').toLowerCase().trim());
    const di = r.findIndex((c) => /date/.test(c)), de = r.findIndex((c) => /desc|narrat|detail|particular|remark|merchant|transaction$/.test(c));
    if (di >= 0 && de >= 0) {
      cols = { date: di, desc: de, amt: r.findIndex((c) => /^amount|amount \(|amt/.test(c) && !/balance/.test(c)), debit: r.findIndex((c) => /debit|withdraw|money out|paid out/.test(c)), credit: r.findIndex((c) => /credit|deposit|money in|paid in/.test(c)) };
      h = i; break;
    }
  }
  if (h < 0) return [];
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const at = parseDate(r[cols.date]); if (isNaN(at)) continue;
    let amt = NaN;
    if (cols.debit >= 0 || cols.credit >= 0) { const d = num(r[cols.debit]), c = num(r[cols.credit]); amt = (isNaN(c) ? 0 : Math.abs(c)) - (isNaN(d) ? 0 : Math.abs(d)); if (!d && !c) amt = NaN; }
    if (isNaN(amt) && cols.amt >= 0) amt = num(r[cols.amt]);
    if (isNaN(amt) || !amt) continue;
    out.push({ at, description: String(r[cols.desc] || '').replace(/\s+/g, ' ').trim().slice(0, 200), amount: amt });
  }
  return out;
}
function fromPdfText(text, isCard) {
  // Best effort: lines that start with a date and end with an amount.
  const out = [];
  for (const line of text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim())) {
    const m = line.match(/^(\d{1,2}[\/\-. ](?:\d{1,2}|[A-Za-z]{3})[\/\-. ]\d{2,4})\s+(.+?)\s+(-?\(?[\d,]+\.\d{2}\)?\s?(?:CR|DR)?)(?:\s+-?[\d,]+\.\d{2}\s?(?:CR|DR)?)?$/i);
    if (!m) continue;
    const at = parseDate(m[1]); if (isNaN(at)) continue;
    let amt = num(m[3]); const desc = m[2].replace(/^\d{1,2}[\/\-. ](?:\d{1,2}|[A-Za-z]{3})[\/\-. ]\d{2,4}\s+/, '');
    if (!/CR/i.test(m[3]) && amt > 0 && !/salary|deposit|credit|refund|inward|payment received|thank you/i.test(desc)) amt = -amt; // money out unless marked as money in
    if (isCard && /payment|thank you/i.test(desc)) amt = Math.abs(amt);
    out.push({ at, description: desc.slice(0, 200), amount: amt });
  }
  return out;
}

export async function importStatement(uid, accountId, name, buf) {
  const acc = one('SELECT * FROM w_accounts WHERE id = ? AND user_id = ?', accountId, uid);
  if (!acc) throw Object.assign(new Error('Account not found.'), { status: 404 });
  const n = String(name || '').toLowerCase(); let tx = [];
  if (n.endsWith('.pdf') || buf.slice(0, 4).toString() === '%PDF') {
    let text; try { text = await pdfText(buf); } catch (e) { throw bad(/password/i.test(e.message) ? 'This PDF has a password. Download it again without one, or use the Excel/CSV export.' : 'This PDF could not be opened. Try the Excel or CSV export from your bank.'); }
    tx = fromPdfText(text, acc.kind === 'card');
  } else {
    const csv = n.endsWith('.csv') || n.endsWith('.txt') || !(buf[0] === 0x50 && buf[1] === 0x4b) && !(buf[0] === 0xd0 && buf[1] === 0xcf);
    const wb = XLSX.read(buf, csv ? { type: 'buffer', raw: true } : { type: 'buffer', cellDates: true });
    for (const s of wb.SheetNames) { tx = fromRows(XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, raw: true, defval: '' })); if (tx.length) break; }
  }
  if (!tx.length) throw bad('No transactions found in this file. Try the Excel or CSV export from your bank app.');
  let added = 0;
  for (const t of tx) {
    const hash = crypto.createHash('sha1').update(`${t.at}|${t.description}|${t.amount}`).digest('hex').slice(0, 20);
    const r = run('INSERT OR IGNORE INTO w_tx (user_id, account_id, at, description, amount, category, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', uid, acc.id, t.at, t.description, t.amount, categorize(t.description, t.amount), hash);
    added += Number(r.changes || 0);
  }
  return { found: tx.length, added };
}

export function summary(uid, days = 30) {
  const since = Date.now() - days * 864e5;
  const accounts = all(`SELECT a.id, a.kind, a.owner, a.name, a.bank, a.last4, a.currency,
      COUNT(t.id) tx, MAX(t.at) latest,
      COALESCE(SUM(CASE WHEN t.amount < 0 AND t.at >= ? THEN -t.amount END), 0) spent,
      COALESCE(SUM(CASE WHEN t.amount > 0 AND t.at >= ? AND t.category != 'Transfers' THEN t.amount END), 0) income
    FROM w_accounts a LEFT JOIN w_tx t ON t.account_id = a.id WHERE a.user_id = ? GROUP BY a.id ORDER BY a.owner, a.kind, a.id`, since, since, uid);
  const where = `user_id = ? AND at >= ? AND amount < 0 AND category NOT IN ('Transfers')`;
  const byCat = all(`SELECT category, ROUND(-SUM(amount), 2) total, COUNT(*) n FROM w_tx WHERE ${where} GROUP BY category ORDER BY total DESC`, uid, since);
  const byOwner = all(`SELECT a.owner, ROUND(-SUM(t.amount), 2) total FROM w_tx t JOIN w_accounts a ON a.id = t.account_id WHERE t.user_id = ? AND t.at >= ? AND t.amount < 0 AND t.category != 'Transfers' GROUP BY a.owner`, uid, since);
  const top = all(`SELECT description, ROUND(-SUM(amount), 2) total, COUNT(*) n FROM w_tx WHERE ${where} GROUP BY lower(description) ORDER BY total DESC LIMIT 8`, uid, since);
  const recent = all(`SELECT t.at, t.description, t.amount, t.category, a.name account FROM w_tx t JOIN w_accounts a ON a.id = t.account_id WHERE t.user_id = ? ORDER BY t.at DESC, t.id DESC LIMIT 40`, uid);
  return { days, accounts, byCat, byOwner, top, recent };
}
