// SQLite (built into Node 22) on the service's own volume (DATA_DIR). Separate from the owner's live Dioma.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export const DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(path.join(DIR, 'files'), { recursive: true });
export const db = new DatabaseSync(path.join(DIR, 'cloud.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, about TEXT, tz TEXT DEFAULT 'Asia/Dubai', plan TEXT DEFAULT 'early', onboarded INTEGER DEFAULT 0, created INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS codes (email TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, account TEXT, secret TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, kind));
CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, asks INTEGER DEFAULT 0, PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, due TEXT, done INTEGER DEFAULT 0, source TEXT, created INTEGER NOT NULL, done_at INTEGER);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, folder TEXT DEFAULT '', mime TEXT, size INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS briefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, sig TEXT, text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, created INTEGER NOT NULL);
`);
try { db.exec('ALTER TABLE users ADD COLUMN role TEXT'); } catch { /* already there */ }
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
