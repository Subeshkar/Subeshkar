import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DATA_DIR || './data';
fs.mkdirSync(dir, { recursive: true });

export const db = new Database(path.join(dir, 'dioma.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  timezone TEXT,
  brief_time TEXT,
  last_inbound INTEGER,
  last_brief_date TEXT,
  google_tokens TEXT,
  google_email TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS permissions (
  phone TEXT, app TEXT, mode TEXT,
  PRIMARY KEY (phone, app)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, role TEXT, content TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  phone TEXT, app TEXT, type TEXT, payload TEXT, summary TEXT,
  status TEXT, result TEXT, created_at INTEGER, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, text TEXT, due_at INTEGER, sent INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, title TEXT, due TEXT, done INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, text TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, text TEXT, result TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS processed (
  id TEXT PRIMARY KEY, created_at INTEGER
);
`);

export const APPS = ['Email', 'Calendar'];

export function getUser(phone) {
  let u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!u) {
    db.prepare(`INSERT INTO users (phone, timezone, brief_time, created_at) VALUES (?, ?, ?, ?)`)
      .run(phone, process.env.DEFAULT_TIMEZONE || 'Asia/Dubai', process.env.DEFAULT_BRIEF_TIME || '07:00', Date.now());
    u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  }
  return u;
}

export function updateUser(phone, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${set} WHERE phone = @phone`).run({ ...fields, phone });
}

export function allUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

export function getPerm(phone, app) {
  const r = db.prepare('SELECT mode FROM permissions WHERE phone = ? AND app = ?').get(phone, app);
  return r ? r.mode : 'ask';
}

export function setPerm(phone, app, mode) {
  if (!['ask', 'always', 'off'].includes(mode)) return;
  db.prepare(`INSERT INTO permissions (phone, app, mode) VALUES (?, ?, ?)
    ON CONFLICT(phone, app) DO UPDATE SET mode = excluded.mode`).run(phone, app, mode);
}

export function logActivity(phone, text, result) {
  db.prepare('INSERT INTO activity (phone, text, result, created_at) VALUES (?, ?, ?, ?)')
    .run(phone, text, result, Date.now());
}

export function saveMessage(phone, role, content) {
  db.prepare('INSERT INTO messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(phone, role, content, Date.now());
}

export function history(phone, limit = 16) {
  return db.prepare('SELECT role, content FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?')
    .all(phone, limit).reverse();
}

export function alreadyProcessed(id) {
  if (!id) return false;
  const r = db.prepare('INSERT OR IGNORE INTO processed (id, created_at) VALUES (?, ?)').run(id, Date.now());
  return r.changes === 0;
}
