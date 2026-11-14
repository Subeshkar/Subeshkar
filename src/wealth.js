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
try { db.exec('ALTER TABLE wealth_files ADD COLUMN text TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE wealth_files ADD COLUMN rows INTEGER'); } catch { /* already there */ }

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
  if (/\.docx$/.test(f)) {
    // .docx is a zip; pull the text out of word/document.xml
    const X = require('xlsx'); const z = X.CFB.read(buf, { type: 'buffer' });
    const e = X.CFB.find(z, 'word/document.xml') || X.CFB.find(z, '/word/document.xml');
    const xml = e && e.content ? Buffer.from(e.content).toString('utf8') : '';
    return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  if (/\.(png|jpe?g|gif|webp|zip|rar|exe)$/.test(f)) return '';
  return buf.toString('utf8');
}
// Any attached file -> plain text (PDF, Excel, CSV, Word, text). Long sheets are kept whole up to the limit.
export async function anyFileText(buf, filename = '', limit = 60000) {
  const t = String(await statementText(buf, filename) || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > limit ? t.slice(0, limit) + '\n…(file continues)' : t;
}

export async function uploadStatement(acct, name, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('Empty file');
  const text = (await statementText(buf, name)).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (text.length < 40) throw new Error('No text found. If it is a scanned PDF, download the statement again as PDF or Excel from your bank app.');
  // same file uploaded again: replace it (and its transactions) instead of adding twice
  for (const f of db.prepare('SELECT id FROM wealth_files WHERE acct = ? AND name = ?').all(acct, name)) db.prepare('DELETE FROM wealth_files WHERE id = ?').run(f.id);
  db.prepare('DELETE FROM wealth_tx WHERE acct = ? AND file = ?').run(acct, name);
  const id = db.prepare('INSERT INTO wealth_files (acct, name, at, chars, text) VALUES (?, ?, ?, ?, ?)').run(acct, name, Date.now(), text.length, text).lastInsertRowid;
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
  const files = db.prepare('SELECT name, at, chars FROM wealth_files WHERE acct = ? ORDER BY at DESC LIMIT 100').all(acct).map((f) => ({ ...f, rows: db.prepare('SELECT count(*) n FROM wealth_tx WHERE acct = ? AND file = ?').get(acct, f.name).n }));
  return { tx, files };
}
export function setCategory(id, category) { db.prepare('UPDATE wealth_tx SET category = ? WHERE id = ?').run(String(category).slice(0, 40), Number(id)); return { ok: true }; }
export function clearAcct(acct) { db.prepare('DELETE FROM wealth_tx WHERE acct = ?').run(acct); db.prepare('DELETE FROM wealth_files WHERE acct = ?').run(acct); return { ok: true }; }

export function fileText(acct, name) { const r = db.prepare('SELECT text FROM wealth_files WHERE acct = ? AND name = ? ORDER BY at DESC LIMIT 1').get(acct, name); return { text: r && r.text ? r.text : '' }; }
export function clearFileTx(acct, name) { return { removed: db.prepare('DELETE FROM wealth_tx WHERE acct = ? AND file = ?').run(acct, name).changes }; }
export function accounts() { return db.prepare('SELECT acct, count(*) n FROM wealth_tx GROUP BY acct').all(); }
