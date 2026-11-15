// Push notifications (pop-up + sound/vibration on the lock screen). iPhone: works once Dioma is added to the Home Screen.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DIR, db, all, run } from './db.js';
const require = createRequire(import.meta.url);
const webpush = require('web-push');

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, keys TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS push_sent (user_id INTEGER NOT NULL, tag TEXT NOT NULL, at INTEGER, PRIMARY KEY (user_id, tag));`);
const KF = path.join(DIR, 'vapid.json');
let K;
function keys() {
  if (K) return K;
  try { K = JSON.parse(fs.readFileSync(KF, 'utf8')); } catch { K = webpush.generateVAPIDKeys(); fs.writeFileSync(KF, JSON.stringify(K), { mode: 0o600 }); }
  webpush.setVapidDetails('mailto:hello@dioma.life', K.publicKey, K.privateKey);
  return K;
}
export const publicKey = () => keys().publicKey;
export function subscribe(uid, sub) {
  if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('Bad subscription'), { status: 400 });
  run('INSERT OR REPLACE INTO push_subs (endpoint, user_id, keys, created) VALUES (?, ?, ?, ?)', sub.endpoint, uid, JSON.stringify(sub.keys), Date.now());
}
export const count = (uid) => all('SELECT endpoint FROM push_subs WHERE user_id = ?', uid).length;
export async function send(uid, msg) {
  keys(); let ok = 0;
  for (const s of all('SELECT endpoint, keys FROM push_subs WHERE user_id = ?', uid)) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(msg), { TTL: 3600, urgency: msg.urgent ? 'high' : 'normal' }); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint); }
  }
  return ok;
}
// Send once per tag (so a reminder never repeats).
export async function once(uid, tag, msg) {
  const r = run('INSERT OR IGNORE INTO push_sent (user_id, tag, at) VALUES (?, ?, ?)', uid, tag, Date.now());
  if (!Number(r.changes)) return 0;
  return send(uid, { ...msg, tag });
}
