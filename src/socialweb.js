// Real LinkedIn inside Dioma: the person signs in once in the Dioma browser and taps "Keep me signed in".
// Dioma saves only that site's cookies (encrypted), never the password, and reads or acts only when the
// person opens a screen or taps a button. Nothing runs in the background.
import { db, one, run } from './db.js';
import { seal, open } from './crypto.js';
import * as BR from './browser.js';

db.exec('CREATE TABLE IF NOT EXISTS web_logins (user_id INTEGER NOT NULL, site TEXT NOT NULL, state TEXT NOT NULL, at INTEGER, PRIMARY KEY (user_id, site))');

const SITES = {
  linkedin: { name: 'LinkedIn', dom: /(^|\.)linkedin\.com$/, need: 'li_at', login: 'https://www.linkedin.com/login', out: /\/(login|authwall|checkpoint|uas\/login)/ },
};
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const C = new Map(); // short cache: uid:key -> { at, v }
const cached = async (k, ms, fn) => { const c = C.get(k); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); C.set(k, { at: Date.now(), v }); return v; };
export const drop = (uid) => { for (const k of C.keys()) if (k.startsWith(uid + ':')) C.delete(k); };
const pause = (p, a = 500, b = 1200) => p.waitForTimeout(a + Math.random() * (b - a));

function keep(site, st) {
  const cfg = SITES[site];
  const cookies = (st.cookies || []).filter((c) => cfg.dom.test(String(c.domain).replace(/^\./, '')));
  const origins = (st.origins || []).filter((o) => { try { return cfg.dom.test(new URL(o.origin).hostname); } catch { return false; } });
  return { cookies, origins };
}
export const loginUrl = (site) => SITES[site]?.login || '';
export function status(uid, site) { const r = one('SELECT at FROM web_logins WHERE user_id = ? AND site = ?', uid, site); return { site, signedIn: !!r, at: r?.at || 0, login: loginUrl(site) }; }
export function forget(uid, site) { run('DELETE FROM web_logins WHERE user_id = ? AND site = ?', uid, site); drop(uid); }
export async function save(uid, site) {
  const cfg = SITES[site]; if (!cfg) throw err('Not available for this network yet.');
  let st; try { st = await BR.sessionState(uid); } catch { throw err(`Open ${cfg.name} in the Dioma browser and sign in first.`, 409); }
  const k = keep(site, st);
  if (!k.cookies.some((c) => c.name === cfg.need && c.value)) throw err(`You are not signed in to ${cfg.name} yet. Finish signing in in the Dioma browser, then tap this again.`, 409);
  run('INSERT INTO web_logins (user_id, site, state, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, site) DO UPDATE SET state = excluded.state, at = excluded.at', uid, site, seal(k), Date.now());
  drop(uid); return status(uid, site);
}
async function use(uid, site, fn) {
  const cfg = SITES[site], row = one('SELECT state FROM web_logins WHERE user_id = ? AND site = ?', uid, site);
  if (!row) throw err(`Sign in to ${cfg.name} once to see it here.`, 428);
  let state; try { state = open(row.state); } catch { forget(uid, site); throw err(`Sign in to ${cfg.name} again.`, 428); }
  const { r, st } = await BR.withState(uid + ':' + site, state, async (page) => {
    const go = async (url) => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30e3 }); if (cfg.out.test(page.url())) { forget(uid, site); throw err(`${cfg.name} signed you out. Sign in again.`, 428); } await pause(page, 1200, 2200); };
    return fn(page, go);
  });
  if (st) { const k = keep(site, st); if (k.cookies.some((c) => c.name === cfg.need)) run('UPDATE web_logins SET state = ?, at = at WHERE user_id = ? AND site = ?', seal(k), uid, site); }
  return r;
}

// ---------- LinkedIn ----------
const LI = 'https://www.linkedin.com';
const actId = (urn) => { const m = String(urn || '').match(/urn:li:(activity|ugcPost|share):\d+/); return m ? m[0] : ''; };

// Posts on any LinkedIn page (feed, search results, your activity): author, text, picture, counts.
async function readPosts(page, max = 15) {
  for (let i = 0; i < (max > 15 ? 5 : 3); i++) { await page.mouse.wheel(0, 2200); await pause(page, 900, 1600); }
  return page.evaluate((max) => {
    const N = (t) => ((String(t || '').match(/\d[\d.,]*\s*[KkMm]?(?![a-z])/i) || [''])[0]).replace(/\s/g, '');
    const T = (el, sel) => { const x = el.querySelector(sel); return x ? x.innerText.replace(/\s+\n/g, '\n').trim() : ''; };
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll('[data-urn*="activity"],[data-urn*="ugcPost"],[data-id*="activity"],[data-id*="ugcPost"]')) {
      const urn = el.getAttribute('data-urn') || el.getAttribute('data-id') || ''; if (seen.has(urn) || el.parentElement?.closest('[data-urn*="activity"],[data-id*="activity"]')) continue; seen.add(urn);
      const author = (T(el, '.update-components-actor__title span[aria-hidden="true"]') || T(el, '.update-components-actor__title') || T(el, '.update-components-actor__name')).split('\n')[0];
      const text = T(el, '.update-components-text') || T(el, '.feed-shared-inline-show-more-text') || T(el, '.feed-shared-update-v2__description');
      if (!author && !text) continue;
      const img = el.querySelector('.update-components-image img, .update-components-article__image img, img.ivm-view-attr__img--centered');
      const btn = [...el.querySelectorAll('button, a')], cm = btn.find((b) => /comment/i.test((b.getAttribute('aria-label') || '') + b.innerText) && /\d/.test(b.innerText)), rp = btn.find((b) => /repost/i.test((b.getAttribute('aria-label') || '') + b.innerText) && /\d/.test(b.innerText));
      out.push({ urn, author, headline: T(el, '.update-components-actor__description').split('\n')[0], when: T(el, '.update-components-actor__sub-description').split('•')[0].split('\n')[0].trim(),
        text: text.slice(0, 3000), image: img && /^https:/.test(img.src) ? img.src : '', likes: N(T(el, '.social-details-social-counts__reactions-count')) || N(el.querySelector('[aria-label*="reaction" i]')?.getAttribute('aria-label')), comments: cm ? N(cm.innerText) : '', reposts: rp ? N(rp.innerText) : '',
        liked: !!el.querySelector('button[aria-pressed="true"].react-button__trigger, button.react-button--active') });
      if (out.length >= max) break;
    }
    return out;
  }, max);
}

// "1,234" / "1.2K" / "3M" -> number
const n = (v) => { const m = String(v || '').replace(/,/g, '').match(/([\d.]+)\s*([KkMm]?)/); if (!m) return 0; return Math.round(parseFloat(m[1]) * (/k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1)); };
// Trending = what people engage with most: reactions, plus comments and reposts count more.
const rank = (posts) => posts.map((p) => ({ ...p, score: n(p.likes) + 3 * n(p.comments) + 5 * n(p.reposts) })).sort((a, b) => b.score - a.score);
export function liFeed(uid, q) {
  const url = q ? `${LI}/search/results/content/?keywords=${encodeURIComponent(q.startsWith('#') ? q : '#' + q)}&datePosted=%22past-week%22&origin=FACETED_SEARCH&sortBy=%22relevance%22` : `${LI}/feed/`;
  return cached(`${uid}:feed:${q || ''}`, 3 * 60e3, () => use(uid, 'linkedin', async (page, go) => {
    await go(url); await page.waitForSelector('[data-urn*="activity"],[data-id*="activity"],[data-urn*="ugcPost"]', { timeout: 20e3 }).catch(() => {});
    const posts = rank(await readPosts(page, 25)); if (!posts.length) throw err('Could not read LinkedIn just now. Tap ↻ to try again.', 502);
    return { posts };
  }));
}
export function liMine(uid) {
  return cached(`${uid}:mine`, 3 * 60e3, () => use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/in/me/recent-activity/all/`); await page.waitForSelector('[data-urn*="activity"],[data-urn*="ugcPost"]', { timeout: 20e3 }).catch(() => {});
    return { posts: await readPosts(page, 12) };
  }));
}
export function liPost(uid, urn) {
  const id = actId(urn); if (!id) throw err('That post link does not look right.');
  return use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/feed/update/${id}/`);
    await page.waitForSelector('.comments-comment-item, .comments-comment-entity, [data-urn*="activity"]', { timeout: 15e3 }).catch(() => {});
    for (let i = 0; i < 2; i++) { const more = await page.$('button.comments-comments-list__load-more-comments-button'); if (!more) break; await more.click().catch(() => {}); await pause(page, 900, 1500); }
    const comments = await page.evaluate(() => [...document.querySelectorAll('article.comments-comment-entity, article.comments-comment-item')].slice(0, 40).map((c) => ({
      who: (c.querySelector('.comments-comment-meta__description-title, .comments-post-meta__name-text')?.innerText || '').split('\n')[0].trim(),
      text: (c.querySelector('.comments-comment-item__main-content, .update-components-text')?.innerText || '').trim().slice(0, 1500),
      when: (c.querySelector('time, .comments-comment-meta__data')?.innerText || '').trim(),
      reply: !!c.closest('.comments-replies-list'),
    })).filter((c) => c.text));
    return { urn: id, comments };
  });
}
export function liLike(uid, urn) {
  const id = actId(urn); if (!id) throw err('That post link does not look right.');
  return use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/feed/update/${id}/`);
    const b = await page.waitForSelector('button.react-button__trigger, button[aria-label^="React Like"], button[aria-label="Like"]', { timeout: 15e3 }).catch(() => null);
    if (!b) throw err('Could not find the Like button. Open the post on LinkedIn.', 502);
    if ((await b.getAttribute('aria-pressed')) === 'true') return { ok: true, already: true };
    await b.click(); await pause(page, 1200, 2000); C.delete(`${uid}:feed:`); return { ok: true };
  });
}
export function liComment(uid, urn, text) {
  const id = actId(urn); text = String(text || '').trim().slice(0, 1250); if (!id || !text) throw err('Write a comment first.');
  return use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/feed/update/${id}/`);
    let ed = await page.$('.comments-comment-box__form .ql-editor, .comments-comment-texteditor .ql-editor, form.comments-comment-box__form div[contenteditable="true"]');
    if (!ed) { const cb = await page.$('button[aria-label="Comment"], button.comment-button'); if (cb) { await cb.click(); await pause(page); } ed = await page.waitForSelector('.comments-comment-box__form .ql-editor, div[role="textbox"][contenteditable="true"]', { timeout: 10e3 }).catch(() => null); }
    if (!ed) throw err('Could not open the comment box. Open the post on LinkedIn.', 502);
    await ed.click(); await pause(page, 300, 700); await page.keyboard.insertText(text); await pause(page, 600, 1100);
    const form = await ed.evaluateHandle((e) => e.closest('form') || document);
    const sub = await form.asElement()?.$('button.comments-comment-box__submit-button, button.comments-comment-box__submit-button--cr, button[type="submit"]');
    if (!sub) throw err('Could not post the comment. Open the post on LinkedIn.', 502);
    await sub.click(); await pause(page, 1800, 2600); return { ok: true };
  });
}

export function liInbox(uid) {
  return cached(`${uid}:inbox`, 2 * 60e3, () => use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/messaging/`); await page.waitForSelector('a[href*="/messaging/thread/"], .msg-conversation-listitem', { timeout: 20e3 }).catch(() => {});
    await pause(page, 600, 1000);
    const threads = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const li of document.querySelectorAll('li.msg-conversation-listitem, li.msg-conversations-container__convo-item')) {
        const a = li.querySelector('a[href*="/messaging/thread/"]'); const id = a ? (a.getAttribute('href').match(/thread\/([^/?]+)/) || [])[1] : '';
        const name = (li.querySelector('.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names')?.innerText || '').trim();
        if (!id || seen.has(id)) continue; seen.add(id);
        out.push({ id, name, snippet: (li.querySelector('.msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet')?.innerText || '').replace(/\s+/g, ' ').trim(), when: (li.querySelector('time, .msg-conversation-listitem__time-stamp')?.innerText || '').trim(), unread: /unread/.test(li.innerHTML.slice(0, 4000)) || !!li.querySelector('.notification-badge--show, .msg-conversation-card__unread-count') });
      }
      if (!out.length) for (const a of document.querySelectorAll('a[href*="/messaging/thread/"]')) {
        const id = (a.getAttribute('href').match(/thread\/([^/?]+)/) || [])[1]; if (!id || seen.has(id)) continue; seen.add(id);
        const lines = a.innerText.split('\n').map((x) => x.trim()).filter(Boolean); out.push({ id, name: lines[0] || '', snippet: lines.slice(1).sort((x, y) => y.length - x.length)[0] || '', when: lines.find((l) => /^(\d|today|yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(l) && l.length < 16) || '', unread: false });
      }
      return out.slice(0, 40);
    });
    if (!threads.length) throw err('Could not read your LinkedIn messages just now. Tap ↻ to try again.', 502);
    return { threads };
  }));
}
export function liThread(uid, id) {
  if (!/^[\w%=-]+$/.test(String(id))) throw err('That conversation is not right.');
  return use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/messaging/thread/${id}/`); await page.waitForSelector('.msg-s-event-listitem, .msg-s-message-list', { timeout: 20e3 }).catch(() => {});
    await pause(page, 600, 1000);
    const messages = await page.evaluate(() => {
      let who = '', when = ''; const out = [];
      for (const li of document.querySelectorAll('li.msg-s-message-list__event')) {
        const n = li.querySelector('.msg-s-message-group__name'); if (n) who = n.innerText.trim();
        const t = li.querySelector('.msg-s-message-group__timestamp, time'); if (t) when = t.innerText.trim();
        const day = li.querySelector('.msg-s-message-list__time-heading'); if (day) when = day.innerText.trim() + (when ? ' ' + when : '');
        const items = li.querySelectorAll('.msg-s-event-listitem');
        for (const it of items) { const body = it.querySelector('.msg-s-event-listitem__body'); const txt = body ? body.innerText.trim() : ''; const att = it.querySelector('.msg-s-event-listitem__attachment-item, .msg-s-event-listitem__attachment, img.msg-s-event-listitem__image'); if (!txt && !att) continue; out.push({ from: who, me: !it.classList.contains('msg-s-event-listitem--other'), text: txt || '📎 Attachment', when }); }
      }
      return out.slice(-40);
    });
    return { id, messages };
  });
}
export async function liSend(uid, id, text) {
  text = String(text || '').trim().slice(0, 4000); if (!text) throw err('Write a message first.'); if (!/^[\w%=-]+$/.test(String(id))) throw err('That conversation is not right.');
  const r = await use(uid, 'linkedin', async (page, go) => {
    await go(`${LI}/messaging/thread/${id}/`);
    const ed = await page.waitForSelector('.msg-form__contenteditable, div[role="textbox"][contenteditable="true"]', { timeout: 20e3 }).catch(() => null);
    if (!ed) throw err('Could not open the reply box. Open the chat on LinkedIn.', 502);
    await ed.click(); await pause(page, 300, 700); await page.keyboard.insertText(text); await pause(page, 600, 1000);
    const b = await page.$('button.msg-form__send-button, button.msg-form__send-btn, button[type="submit"].msg-form__send-button');
    if (b && await b.isEnabled()) await b.click(); else await page.keyboard.press('Enter');
    await pause(page, 1500, 2300); return { ok: true };
  });
  C.delete(`${uid}:inbox`); return r;
}
