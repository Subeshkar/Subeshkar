// Dioma Browser: a private browser that runs on Dioma's server and is shown inside the app.
// The customer types their own logins (bank, portals). Dioma never stores passwords:
// every session is a fresh, empty browser profile, closed after 10 idle minutes or when they tap Close.
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const EXE = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p)) || '';
let browser = null;
const S = new Map(); // uid -> { ctx, page, at, timer }
const W = 1280, H = 860, IDLE = 10 * 60e3;

export const available = () => !!(EXE || process.env.DIOMA_DEV);
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  if (EXE) opts.executablePath = EXE;
  browser = await chromium.launch(opts);
  return browser;
}
function touch(uid) {
  const s = S.get(uid); if (!s) return;
  s.at = Date.now(); clearTimeout(s.timer); s.timer = setTimeout(() => close(uid), IDLE);
}
async function sess(uid, create, mobile) {
  let s = S.get(uid);
  if (s && !s.page.isClosed()) { touch(uid); return s; }
  if (!create) throw Object.assign(new Error('The browser is closed. Tap Open.'), { status: 409 });
  const size = mobile ? { width: 412, height: 860 } : { width: W, height: H };
  const ctx = await (await getBrowser()).newContext({ viewport: size, locale: 'en-GB', timezoneId: 'Asia/Dubai', acceptDownloads: true,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' } : { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }) });
  const page = await ctx.newPage();
  s = { ctx, page, at: Date.now(), downloads: [], w: size.width, h: size.height, mobile: !!mobile };
  // Keep the newest tab as the one shown (banks often open statements in a new tab).
  ctx.on('page', (p) => { s.page = p; });
  ctx.on('download', () => {});
  page.on('download', async (d) => { try { const b = fs.readFileSync(await d.path()); s.downloads.push({ name: d.suggestedFilename(), buf: b }); } catch {} });
  S.set(uid, s); touch(uid);
  return s;
}
const okUrl = (u) => { try { const x = new URL(/^https?:\/\//.test(u) ? u : 'https://' + u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

export async function open(uid, url, mobile) {
  const s = await sess(uid, true, mobile); const u = okUrl(url || 'https://www.google.com');
  if (!u) throw Object.assign(new Error('That address does not look right.'), { status: 400 });
  await s.page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30e3 }).catch(() => {});
  return state(uid);
}
export async function shot(uid) {
  const s = await sess(uid, false);
  return s.page.screenshot({ type: 'jpeg', quality: 60 });
}
export async function state(uid) {
  const s = S.get(uid); if (!s || s.page.isClosed()) return { open: false };
  return { open: true, url: s.page.url(), title: await s.page.title().catch(() => ''), width: s.w, height: s.h, downloads: s.downloads.map((d, i) => ({ i, name: d.name, size: d.buf.length })) };
}
export async function act(uid, a) {
  const s = await sess(uid, false), p = s.page;
  const x = Math.max(0, Math.min(s.w, Number(a.x) || 0)), y = Math.max(0, Math.min(s.h, Number(a.y) || 0));
  if (a.type === 'click') { if (s.mobile) await p.touchscreen.tap(x, y); else await p.mouse.click(x, y); }
  else if (a.type === 'scroll') { await p.mouse.move(x, y); await p.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(a.dy) || 0))); }
  else if (a.type === 'type') await p.keyboard.type(String(a.text || '').slice(0, 500), { delay: 15 });
  else if (a.type === 'key' && /^(Enter|Tab|Backspace|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Delete|PageDown|PageUp)$/.test(a.key)) await p.keyboard.press(a.key);
  else if (a.type === 'back') await p.goBack({ timeout: 15e3 }).catch(() => {});
  else if (a.type === 'reload') await p.reload({ timeout: 30e3 }).catch(() => {});
  await p.waitForTimeout(350);
  return state(uid);
}
// Everything readable on the page now (tables become one row per line), for Wealth.
export async function pageText(uid) {
  const s = await sess(uid, false);
  const grab = (f) => f.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')).filter((r) => r.replace(/[| ]/g, ''));
    return rows.length > 3 ? rows.join('\n') + '\n\n' + document.body.innerText : document.body.innerText;
  }).catch(() => '');
  const parts = [await grab(s.page)];
  for (const f of s.page.frames().slice(1, 8)) parts.push(await grab(f));
  return parts.join('\n').slice(0, 400000);
}
export function takeDownload(uid, i) { const s = S.get(uid); return s && s.downloads[i] ? s.downloads[i] : null; }

// The cookies of the browser you are using now (only used when you tap "Keep me signed in" for a social network).
export async function sessionState(uid) { const s = await sess(uid, false); return s.ctx.storageState(); }
// Run fn(page) in a separate, invisible browser that starts with saved cookies; returns fn's result and the refreshed cookies.
const LOCK = new Map();
export async function withState(key, state, fn) {
  while (LOCK.get(key)) await LOCK.get(key).catch(() => {});
  let done; const p = new Promise((r) => { done = r; }); LOCK.set(key, p);
  const ctx = await (await getBrowser()).newContext({ viewport: { width: W, height: H }, locale: 'en-GB', timezoneId: 'Asia/Dubai', storageState: state,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  try { const page = await ctx.newPage(); page.setDefaultTimeout(20e3); const r = await fn(page); return { r, st: await ctx.storageState().catch(() => null) }; }
  finally { await ctx.close().catch(() => {}); LOCK.delete(key); done(); }
}

export async function close(uid) {
  const s = S.get(uid); S.delete(uid); if (!s) return;
  clearTimeout(s.timer); await s.ctx.close().catch(() => {}); // cookies, logins and history are gone
}
