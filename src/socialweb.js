// Real LinkedIn inside Dioma: the person signs in once in the Dioma browser and taps "Keep me signed in".
// Dioma saves only that site's cookies (encrypted), never the password, and reads or acts only when the
// person opens a screen or taps a button. Nothing runs in the background.
import { db, one, run } from './db.js';
import { seal, open } from './crypto.js';
import * as BR from './browser.js';

db.exec('CREATE TABLE IF NOT EXISTS web_logins (user_id INTEGER NOT NULL, site TEXT NOT NULL, state TEXT NOT NULL, at INTEGER, PRIMARY KEY (user_id, site))');

const SITES = {
  linkedin: { name: 'LinkedIn', dom: /(^|\.)linkedin\.com$/, need: 'li_at', login: 'https://www.linkedin.com/login', out: /\/(login|authwall|checkpoint|uas\/login)/ },
  instagram: { name: 'Instagram', dom: /(^|\.)instagram\.com$/, need: 'sessionid', login: 'https://www.instagram.com/accounts/login/', out: /\/accounts\/login|\/challenge\// },
  facebook: { name: 'Facebook', dom: /(^|\.)facebook\.com$/, need: 'c_user', login: 'https://www.facebook.com/login/', out: /\/login|\/checkpoint\// },
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

// People search on LinkedIn (as you): name, headline, place, profile link, and whether Connect is open.
const GEO = { uae: '104305776', gcc: '104305776%22%2C%22100459316', world: '' };
export function liPeople(uid, q, max = 10, where = 'uae') {
  q = String(q || '').trim().slice(0, 120); if (!q) throw err('Say who to look for.');
  const g = GEO[where] ?? GEO.uae;
  const url = `${LI}/search/results/people/?keywords=${encodeURIComponent(q)}${g ? `&geoUrn=%5B%22${g}%22%5D` : ''}&origin=FACETED_SEARCH`;
  return cached(`${uid}:people:${q}:${where}`, 10 * 60e3, () => use(uid, 'linkedin', async (page, go) => {
    const out = [], seen = new Set();
    for (let pg = 1; pg <= 3 && out.length < max; pg++) {
      await go(url + (pg > 1 ? '&page=' + pg : '')); await page.waitForSelector('a[href*="/in/"]', { timeout: 20e3 }).catch(() => {});
      await page.mouse.wheel(0, 1800); await pause(page, 800, 1400);
      const rows = await page.evaluate(() => [...document.querySelectorAll('li.reusable-search__result-container, div[data-chameleon-result-urn], li[class*="search-result"], div[data-view-name="search-entity-result-universal-template"]')].map((el) => {
        const a = el.querySelector('a[href*="/in/"]'); if (!a) return null;
        const nm = (el.querySelector('span[aria-hidden="true"]')?.innerText || a.innerText || '').split('\n')[0].trim();
        const lines = el.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
        const head = (el.querySelector('.entity-result__primary-subtitle, div[class*="primary-subtitle"]')?.innerText || lines[lines.indexOf(nm) + 2] || '').trim();
        const place = (el.querySelector('.entity-result__secondary-subtitle, div[class*="secondary-subtitle"]')?.innerText || '').trim();
        const btn = [...el.querySelectorAll('button')].find((b) => /connect|invite/i.test((b.getAttribute('aria-label') || '') + ' ' + b.innerText));
        return { name: nm, headline: head.slice(0, 160), place: place.slice(0, 80), url: a.href.split('?')[0], canConnect: !!btn };
      }).filter((x) => x && x.name && !/linkedin member/i.test(x.name)));
      for (const r of rows) { if (seen.has(r.url)) continue; seen.add(r.url); out.push(r); if (out.length >= max) break; }
    }
    if (!out.length) throw err('LinkedIn showed no people for that. Try other words.', 404);
    return { people: out };
  }));
}

// Send connection requests (as you), one by one with human pauses. Free accounts can only add a few notes a month;
// when LinkedIn refuses the note, the request goes without one.
const sentToday = (uid) => { try { return JSON.parse(one("SELECT v FROM kv WHERE user_id = ? AND k = 'li_sent'", uid)?.v || '{}'); } catch { return {}; } };
export const JOBS = new Map(); // uid -> { total, done, sent:[], failed:[], running }
export function liConnectStart(uid, people, note) {
  const day = new Date().toISOString().slice(0, 10), s = sentToday(uid), used = s.day === day ? s.n : 0, room = Math.max(0, 25 - used);
  const list = (people || []).filter((p) => /linkedin\.com\/in\//.test(p.url || '')).slice(0, Math.min(15, room));
  if (!list.length) throw err(room ? 'Pick people first.' : 'LinkedIn limits connection requests. Dioma sends up to 25 a day; try again tomorrow.', 429);
  if (JOBS.get(uid)?.running) throw err('Dioma is still sending the last batch. Check back in a few minutes.', 409);
  const job = { total: list.length, done: 0, sent: [], failed: [], running: true, at: Date.now() }; JOBS.set(uid, job);
  (async () => {
    for (const p of list) {
      try {
        await use(uid, 'linkedin', async (page, go) => {
          await go(p.url); await pause(page, 1500, 2500);
          const main = (await page.$('main')) || page;
          let b = await main.$('button[aria-label*="Invite"][aria-label*="connect" i], button[aria-label^="Connect" i]');
          if (!b) { const more = await main.$('button[aria-label="More actions"], button[aria-label*="More actions"]'); if (more) { await more.click(); await pause(page, 700, 1200); b = await page.$('div[role="button"][aria-label*="Invite"][aria-label*="connect" i], div[aria-label*="connect" i][role="button"]'); } }
          if (!b) { const pend = await main.$('button[aria-label*="Pending" i]'); throw err(pend ? 'already pending' : 'no Connect button (already connected or follow-only)', 409); }
          await b.click(); await pause(page, 900, 1500);
          let sent = false;
          if (note) { const add = await page.$('button[aria-label="Add a note"]'); if (add) { await add.click(); await pause(page, 600, 1000); const ta = await page.$('textarea[name="message"], textarea#custom-message'); if (ta) { await ta.fill(String(note).replace(/\{name\}/g, p.name.split(' ')[0]).slice(0, 295)); await pause(page, 500, 900); const sb = await page.$('button[aria-label="Send invitation"], button[aria-label="Send now"], button[aria-label="Send"]'); if (sb && await sb.isEnabled()) { await sb.click(); sent = true; } } else { const back = await page.$('button[aria-label="Dismiss"]'); if (back) await back.click(); await b.click().catch(() => {}); await pause(page); } } }
          if (!sent) { const sb = await page.$('button[aria-label="Send without a note"], button[aria-label="Send now"], button[aria-label="Send invitation"]'); if (!sb) throw err('LinkedIn did not show the Send button', 502); await sb.click(); }
          await pause(page, 1500, 2500); return true;
        });
        job.sent.push(p.name); const s2 = sentToday(uid), d2 = new Date().toISOString().slice(0, 10); run("INSERT OR REPLACE INTO kv (user_id, k, v) VALUES (?, 'li_sent', ?)", uid, JSON.stringify({ day: d2, n: (s2.day === d2 ? s2.n : 0) + 1 }));
      } catch (e) { job.failed.push(`${p.name}: ${e.message}`); if (e.status === 428) break; }
      job.done++; await new Promise((r) => setTimeout(r, 12e3 + Math.random() * 18e3)); // human pace between people
    }
    job.running = false; job.at = Date.now();
  })().catch((e) => { job.running = false; job.failed.push(e.message); });
  return { ok: true, total: list.length, minutes: Math.ceil(list.length * 0.6) };
}
export const liConnectStatus = (uid) => JOBS.get(uid) || { total: 0, done: 0, sent: [], failed: [], running: false };


// ---------- Instagram and Facebook (as you, in the Dioma browser) ----------
const IG = 'https://www.instagram.com';
// Top posts for a hashtag: link, picture, caption.
export function igTag(uid, tag) {
  tag = String(tag || '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 60); if (!tag) throw err('Pick a hashtag.');
  return cached(`${uid}:igtag:${tag}`, 15 * 60e3, () => use(uid, 'instagram', async (page, go) => {
    await go(`${IG}/explore/tags/${encodeURIComponent(tag)}/`); await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 20e3 }).catch(() => {});
    for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 1800); await pause(page, 900, 1500); }
    const posts = await page.evaluate(() => { const out = [], seen = new Set(); for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) { const u = a.href.split('?')[0]; if (seen.has(u)) continue; seen.add(u); const img = a.querySelector('img'); out.push({ url: u, image: img && /^https:/.test(img.src) ? img.src : '', text: (img?.alt || '').slice(0, 400), reel: /\/reel\//.test(u) }); if (out.length >= 18) break; } return out; });
    if (!posts.length) throw err('Instagram showed no posts for #' + tag + ' just now. Try another hashtag.', 404);
    return { tag, posts };
  }));
}
// Comment on any Instagram post as you.
export function igComment(uid, url, text) {
  text = String(text || '').trim().slice(0, 2000); if (!text) throw err('Write the comment first.');
  if (!/^https:\/\/www\.instagram\.com\/(p|reel)\//.test(url || '')) throw err('That is not an Instagram post link.');
  return use(uid, 'instagram', async (page, go) => {
    await go(url); const box = await page.waitForSelector('textarea[aria-label*="comment" i], form textarea', { timeout: 20e3 }).catch(() => null);
    if (!box) throw err('Comments are turned off on this post, or Instagram did not show the comment box.', 409);
    await box.click(); await pause(page, 400, 800); await page.keyboard.type(text, { delay: 25 }); await pause(page, 500, 900);
    const post = await page.$('form button[type="submit"], div[role="button"]:has-text("Post")'); if (post) await post.click(); else await page.keyboard.press('Enter');
    await pause(page, 2000, 3000); drop(uid); return { ok: true };
  });
}
// Comment on a Facebook post (link) as you.
export function fbComment(uid, url, text) {
  text = String(text || '').trim().slice(0, 2000); if (!text) throw err('Write the comment first.');
  if (!/^https:\/\/(www|m|web)\.facebook\.com\//.test(url || '')) throw err('That is not a Facebook post link.');
  return use(uid, 'facebook', async (page, go) => {
    await go(url); const box = await page.waitForSelector('div[contenteditable="true"][aria-label*="comment" i], div[contenteditable="true"][role="textbox"]', { timeout: 20e3 }).catch(() => null);
    if (!box) throw err('Facebook did not show a comment box on this post.', 409);
    await box.click(); await pause(page, 400, 800); await page.keyboard.type(text, { delay: 25 }); await pause(page, 400, 800); await page.keyboard.press('Enter'); await pause(page, 2000, 3000); drop(uid); return { ok: true };
  });
}

// Saved sign-in cookies for the site a link points to (so a post opens signed in inside Dioma).
export function cookiesFor(uid, url) {
  let h = ''; try { h = new URL(url).hostname; } catch { return []; }
  const site = Object.keys(SITES).find((k) => SITES[k].dom.test(h)); if (!site) return [];
  const row = one('SELECT state FROM web_logins WHERE user_id = ? AND site = ?', uid, site); if (!row) return [];
  try { return open(row.state).cookies || []; } catch { return []; }
}
