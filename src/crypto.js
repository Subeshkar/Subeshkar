// Hashing for codes/sessions, and encryption for each user's connected-app tokens (APP_SECRET).
import crypto from 'node:crypto';
const KEY = () => { const s = process.env.APP_SECRET; if (!s || s.length < 24) throw new Error('APP_SECRET is not set (min 24 chars).'); return crypto.createHash('sha256').update(s).digest(); };
export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const code6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
export function seal(obj) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv); const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.'); }
export function open(s) { const [iv, tag, enc] = String(s).split('.').map((x) => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', KEY(), iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8')); }
export const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
