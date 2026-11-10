// Wealth: bank statements (personal and business) uploaded by the owner.
// Files are turned into text here; Dioma's AI reads the text into transactions, which are stored here.
import { createRequire } from 'node:module';
import { db } from './db.js';
const require = createRequire(import.meta.url);

db.exec(`CREATE TABLE IF NOT EXISTS wealth_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT, acct TEXT NOT NULL, bank TEXT, date TEXT NOT NULL, descr TEXT,
  amount REAL NOT NULL, balance REAL, category TEXT, party TEXT, file TEXT, added INTEGER,
  UNIQUE(acct, bank, date, amount, descr, balance));
CREATE TABLE IF NOT EXISTS wealth_files (id INTEGER PRIMARY KEY AUTOINCREMENT, acct TEXT, name TEXT, at INTEGER, chars INTEGER);`);

export async function statementText(buf, filename = '') {
  const f = filename.toLowerCase();
  if (f.endsWith('.pdf') || buf.slice(0, 4).toString() === '%PDF') {
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    const r = await pdf(buf);
    return r.text;
  }
  if (/\.(xlsx|xls|ods)$/.test(f)) {
    const X = require('xlsx'); const wb = X.read(buf, { type: 'buffer', cellDates: true });
    return wb.SheetNames.map((n) => X.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false, dateNF: 'yyyy-mm-dd' })).join('\n');
  }
  return buf.toString('utf8');
}

export async function uploadStatement(acct, name, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('Empty file');
  const text = (await statementText(buf, name)).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (text.length < 40) throw new Error('No text found. If it is a scanned PDF, download the statement again as PDF or Excel from your bank app.');
  const id = db.prepare('INSERT INTO wealth_files (acct, name, at, chars) VALUES (?, ?, ?, ?)').run(acct, name, Date.now(), text.length).lastInsertRowid;
  return { file_id: id, chars: text.length, text: text.slice(0, 600000) };
}

export function addTx(acct, list, file) {
  const ins = db.prepare('INSERT OR IGNORE INTO wealth_tx (acct, bank, date, descr, amount, balance, category, party, file, added) VALUES (?,?,?,?,?,?,?,?,?,?)');
  let n = 0;
  db.transaction(() => {
    for (const t of list || []) {
      const amt = Number(t.amount); if (!t.date || !isFinite(amt) || !amt) continue;
      n += ins.run(acct, String(t.bank || '').slice(0, 60), String(t.date).slice(0, 10), String(t.desc || t.descr || '').slice(0, 300), amt, t.balance == null || t.balance === '' ? null : Number(t.balance), String(t.category || 'Other').slice(0, 40), String(t.party || '').slice(0, 80), String(file || ''), Date.now()).changes;
    }
  })();
  return { added: n };
}

export function listTx(acct) {
  const tx = db.prepare('SELECT id, bank, date, descr, amount, balance, category, party FROM wealth_tx WHERE acct = ? ORDER BY date DESC, id DESC LIMIT 6000').all(acct);
  const files = db.prepare('SELECT name, at, chars FROM wealth_files WHERE acct = ? ORDER BY at DESC LIMIT 50').all(acct);
  return { tx, files };
}
export function setCategory(id, category) { db.prepare('UPDATE wealth_tx SET category = ? WHERE id = ?').run(String(category).slice(0, 40), Number(id)); return { ok: true }; }
export function clearAcct(acct) { db.prepare('DELETE FROM wealth_tx WHERE acct = ?').run(acct); db.prepare('DELETE FROM wealth_files WHERE acct = ?').run(acct); return { ok: true }; }
