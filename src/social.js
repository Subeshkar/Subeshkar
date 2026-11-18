// Social: recent posts and comments (Instagram, Facebook Page), reply to comments, and publish posts (LinkedIn, Facebook, Instagram with a photo).
// Nothing is posted or replied without the customer tapping Post / Send.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR } from './db.js';
import * as A from './apps.js';

const PUB = path.join(DIR, 'pub'); fs.mkdirSync(PUB, { recursive: true });
export const PUB_DIR = PUB;
const C = new Map(); // uid:net -> { at, data }
const arr = (d) => A.arrayIn(d) || [];
const err = (m, s = 502) => Object.assign(new Error(m), { status: s });

async function igUser(uid) {
  const k = uid + ':igid'; const c = C.get(k); if (c) return c.data;
  const d = await A.runFill(uid, 'INSTAGRAM_GET_USER_INFO', { 'ig_user_id|user_id': 'me', 'fields': 'id,user_id,username,name' });
  // Instagram gives two ids: "user_id" is the professional account id that messages and media need; "id" is app-scoped.
  const r = d?.data && typeof d.data === 'object' ? d.data : d || {};
  const v = { id: String(r.user_id || r.id || ''), appId: String(r.id || ''), name: r.username || r.name || '' };
  C.set(k, { data: v }); return v;
}
async function fbPage(uid) {
  const k = uid + ':fbpage'; const c = C.get(k); if (c) return c.data;
  const p = arr(await A.runFill(uid, 'FACEBOOK_LIST_MANAGED_PAGES', { 'limit': 10 }))[0] || {};
  const v = { id: String(p.id || ''), name: p.name || '' }; C.set(k, { data: v }); return v;
}

export async function feed(uid) {
  const on = (await A.connected(uid)).map((x) => x.slug);
  const out = { networks: on.filter((s) => ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube', 'tiktok'].includes(s)), posts: [], errors: [] };
  const cached = C.get(uid + ':feed'); if (cached && Date.now() - cached.at < 3 * 60e3) return cached.data;
  if (on.includes('instagram')) {
    try {
      const u = await igUser(uid);
      const media = arr(await A.runFill(uid, 'INSTAGRAM_GET_IG_USER_MEDIA', { 'ig_user_id|user_id': u.id || 'me', 'limit': 8, 'fields': 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count' })).slice(0, 8);
      for (const m of media) {
        let comments = [];
        if (Number(m.comments_count) > 0) try { comments = arr(await A.runFill(uid, 'INSTAGRAM_GET_IG_MEDIA_COMMENTS', { 'ig_media_id|media_id': m.id, 'limit': 15, 'fields': 'id,text,username,timestamp' })).map((c) => ({ id: c.id, who: c.username || c.from?.username || '', text: c.text || '', at: +new Date(c.timestamp || 0) })); } catch {}
        out.posts.push({ net: 'instagram', account: u.name, id: m.id, text: m.caption || '', image: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url, link: m.permalink, at: +new Date(m.timestamp || 0), likes: m.like_count || 0, comments });
      }
    } catch (e) { out.errors.push('Instagram: ' + e.message); }
  }
  if (on.includes('facebook')) {
    try {
      const pg = await fbPage(uid);
      if (!pg.id) out.errors.push('Facebook: no Page found on this account');
      else {
        const posts = arr(await A.runFill(uid, 'FACEBOOK_GET_PAGE_POSTS', { 'page_id': pg.id, 'limit': 8, 'fields': 'id,message,created_time,permalink_url,full_picture' })).slice(0, 8);
        for (const p of posts) {
          let comments = [];
          try { comments = arr(await A.runFill(uid, 'FACEBOOK_GET_COMMENTS', { 'object_id|post_id|id': p.id, 'limit': 15 })).map((c) => ({ id: c.id, who: c.from?.name || '', text: c.message || '', at: +new Date(c.created_time || 0) })); } catch {}
          out.posts.push({ net: 'facebook', account: pg.name, id: p.id, text: p.message || '', image: p.full_picture, link: p.permalink_url, at: +new Date(p.created_time || 0), comments });
        }
      }
    } catch (e) { out.errors.push('Facebook: ' + e.message); }
  }
  out.posts.sort((a, b) => b.at - a.at);
  C.set(uid + ':feed', { at: Date.now(), data: out });
  return out;
}

export async function reply(uid, net, commentId, text) {
  C.delete(uid + ':feed');
  if (net === 'instagram') return A.runFill(uid, 'INSTAGRAM_POST_IG_COMMENT_REPLIES', { 'ig_comment_id|comment_id': commentId, 'message|text': text });
  if (net === 'facebook') return A.runFill(uid, 'FACEBOOK_CREATE_COMMENT', { 'object_id|comment_id|id': commentId, 'message|text': text });
  throw err('Replies for this network are coming soon.', 400);
}

// A photo the customer adds for an Instagram post needs a public link for Instagram to fetch.
export function savePublicImage(buf, mime) {
  const ext = /png/.test(mime) ? 'png' : 'jpg', id = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(PUB, id), buf); return id;
}
export function savePublicFile(buf, ext) { const id = crypto.randomBytes(12).toString('hex') + '.' + (/^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin'); fs.writeFileSync(path.join(PUB, id), buf); return id; }
export const publicFile = (id) => (/^[a-f0-9]{24}\.[a-z0-9]{1,5}$/.test(id) && fs.existsSync(path.join(PUB, id)) ? path.join(PUB, id) : null);

// Who you are on LinkedIn (the "author" every post needs). The answer is nested differently per version, so look everywhere.
function deep(o, test, depth = 0) { if (!o || typeof o !== 'object' || depth > 6) return null; for (const [k, v] of Object.entries(o)) { const r = test(k, v); if (r) return r; } for (const v of Object.values(o)) { const r = deep(v, test, depth + 1); if (r) return r; } return null; }
export async function liMe(uid) {
  const k = uid + ':li'; const c = C.get(k); if (c && c.data.author) return c.data;
  const me = await A.runFill(uid, 'LINKEDIN_GET_MY_INFO', {});
  const urn = deep(me, (kk, v) => (typeof v === 'string' && /^urn:li:person:/.test(v) ? v : null));
  const id = urn ? null : deep(me, (kk, v) => (/^(sub|author_id|person_id|id)$/.test(kk) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 3 ? String(v) : null));
  const name = deep(me, (kk, v) => (/^(name|localizedFirstName|given_name)$/.test(kk) && typeof v === 'string' ? v : null)) || '';
  const v = { author: urn || (id ? (id.startsWith('urn:') ? id : 'urn:li:person:' + id) : ''), name, raw: me };
  if (v.author) C.set(k, { data: v });
  return v;
}
export async function check(uid, net) {
  const on = (await A.connected(uid)).some((x) => x.slug === net);
  if (!on) return { connected: false, ok: false, message: 'Not connected. Tap + Add and connect it.' };
  try {
    if (net === 'linkedin') { const me = await liMe(uid); return me.author ? { connected: true, ok: true, message: `Connected as ${me.name || 'you'}. Posting works.` } : { connected: true, ok: false, message: 'Connected, but LinkedIn did not share your profile. Disconnect and connect again, and allow all permissions.', detail: JSON.stringify(me.raw).slice(0, 600) }; }
    if (net === 'instagram') { const u = await igUser(uid); return { connected: true, ok: !!u.id, message: u.id ? `Connected as @${u.name}.` : 'Connected, but Instagram did not share the account. Use an Instagram professional (business or creator) account.' }; }
    if (net === 'facebook') { const pg = await fbPage(uid); return { connected: true, ok: !!pg.id, message: pg.id ? `Connected to the Page "${pg.name}".` : 'Connected, but no Facebook Page found. Dioma posts to a Page you manage.' }; }
    return { connected: true, ok: true, message: 'Connected.' };
  } catch (e) { return { connected: true, ok: false, message: e.message }; }
}
export async function post(uid, net, text, imageUrl) {
  C.delete(uid + ':feed');
  if (net === 'linkedin') {
    const me = await liMe(uid);
    if (!me.author) throw err('LinkedIn did not tell Dioma who you are. Disconnect LinkedIn and connect it again.', 400);
    return A.runFill(uid, 'LINKEDIN_CREATE_LINKED_IN_POST', { 'author|author_urn|author_id': me.author, 'commentary|text|content': text, 'visibility': 'PUBLIC', 'lifecycleState|lifecycle_state': 'PUBLISHED' });
  }
  if (net === 'facebook') {
    const pg = await fbPage(uid); if (!pg.id) throw err('No Facebook Page found on this account.', 400);
    return A.runFill(uid, 'FACEBOOK_CREATE_POST', { 'page_id': pg.id, 'message|text': text, 'published': true });
  }
  if (net === 'instagram') {
    if (!imageUrl) throw err('Instagram posts need a photo. Add one first.', 400);
    const u = await igUser(uid);
    const c = await A.runFill(uid, 'INSTAGRAM_POST_IG_USER_MEDIA', { 'ig_user_id|user_id': u.id, 'image_url': imageUrl, 'caption': text });
    const cid = c?.id || c?.data?.id || c?.creation_id;
    if (!cid) throw err('Instagram did not accept the photo.');
    return A.runFill(uid, 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', { 'ig_user_id|user_id': u.id, 'creation_id': cid });
  }
  throw err('Posting to this network is coming soon.', 400);
}

// Direct messages (Instagram business inbox, Facebook Page inbox). Read, and reply only when the customer taps Send.
export async function dms(uid) {
  const on = (await A.connected(uid)).map((x) => x.slug), out = { threads: [], errors: [] };
  const c = C.get(uid + ':dms'); if (c && Date.now() - c.at < 2 * 60e3) return c.data;
  const norm = (net, t, meId) => {
    const msgs = arr(t.messages || t).slice(0, 6).map((m) => ({ from: m.from?.username || m.from?.name || '', fromId: String(m.from?.id || ''), text: m.message || m.text || '', at: +new Date(m.created_time || m.timestamp || 0) }));
    const other = (t.participants?.data || t.participants || []).find((p) => String(p.id) !== String(meId)) || {};
    return { net, id: String(t.id || ''), who: other.username || other.name || msgs.find((m) => m.fromId !== String(meId))?.from || 'Someone', whoId: String(other.id || msgs.find((m) => m.fromId !== String(meId))?.fromId || ''), at: +new Date(t.updated_time || msgs[0]?.at || 0), messages: msgs };
  };
  if (on.includes('instagram')) {
    try { const u = await igUser(uid); const ask = (id) => A.runFill(uid, 'INSTAGRAM_LIST_ALL_CONVERSATIONS', { 'ig_user_id|user_id': id, 'platform': 'instagram', 'limit': 20, 'fields': 'id,updated_time,participants,messages{message,from,created_time}' });
      let d; try { d = await ask('me'); } catch { d = await ask(u.id); }
      out.threads.push(...arr(d).map((t) => norm('instagram', t, u.id))); }
    catch (e) { out.errors.push('Instagram messages: ' + e.message); }
  }
  if (on.includes('facebook')) {
    try { const pg = await fbPage(uid); if (pg.id) { const d = await A.runFill(uid, 'FACEBOOK_GET_PAGE_CONVERSATIONS', { 'page_id': pg.id, 'limit': 20, 'fields': 'id,updated_time,participants,messages{message,from,created_time}' }); out.threads.push(...arr(d).map((t) => norm('facebook', t, pg.id))); } }
    catch (e) { out.errors.push('Facebook messages: ' + e.message); }
  }
  out.threads.sort((a, b) => b.at - a.at);
  C.set(uid + ':dms', { at: Date.now(), data: out }); return out;
}
export async function dmSend(uid, net, to, text) {
  C.delete(uid + ':dms');
  if (net === 'instagram') { const u = await igUser(uid); const go = (id) => A.runFill(uid, 'INSTAGRAM_SEND_TEXT_MESSAGE', { 'ig_user_id|user_id': id, 'recipient_id|recipient': to, 'text|message': text }); try { return await go('me'); } catch { return go(u.id); } }
  if (net === 'facebook') { const pg = await fbPage(uid); return A.runFill(uid, 'FACEBOOK_SEND_MESSAGE', { 'page_id': pg.id, 'recipient_id|recipient': to, 'message|text': text }); }
  throw err('Messages for this network are coming soon.', 400);
}

// Trending now: Google Trends for the UAE, the GCC (Saudi) and the world, with the news behind each trend.
const TR = new Map();
export async function trending() {
  const c = TR.get('t'); if (c && Date.now() - c.at < 30 * 60e3) return c.data;
  const dec = (t) => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const tag = (x, n) => dec((x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1]);
  const regions = [];
  for (const [id, label, geo] of [['uae', 'UAE', 'AE'], ['gcc', 'GCC', 'SA'], ['world', 'World', 'US']]) {
    try {
      const x = await (await fetch('https://trends.google.com/trending/rss?geo=' + geo, { signal: AbortSignal.timeout(12e3) })).text();
      const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(([, i]) => {
        const news = [...i.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].map(([, n]) => ({ title: tag(n, 'ht:news_item_title'), url: tag(n, 'ht:news_item_url'), source: tag(n, 'ht:news_item_source') })).filter((n) => /^https:\/\//.test(n.url));
        return { topic: tag(i, 'title'), traffic: tag(i, 'ht:approx_traffic'), title: news[0]?.title || tag(i, 'title'), url: news[0]?.url || '', source: news[0]?.source || '' };
      }).filter((t) => t.topic);
      regions.push({ id, tag: label, items });
    } catch { regions.push({ id, tag: label, items: [], error: 'Could not load trends right now.' }); }
  }
  const data = { regions, at: Date.now() }; TR.set('t', { at: Date.now(), data }); return data;
}

// Trending on one network. Instagram (when connected): real top posts for the hottest UAE hashtags.
// Every network: what the UAE is talking about now, each with a link that opens that network's live results.
const NTAGS = {
  instagram: ['dubai', 'uae', 'mydubai', 'dubaifood', 'abudhabi', 'dubailife'],
  tiktok: ['dubai', 'uae', 'dubaitiktok', 'foryou'], youtube: ['dubai', 'uae'], twitter: ['UAE', 'Dubai'], facebook: ['Dubai', 'UAE'], linkedin: ['logistics', 'uaebusiness', 'leadership', 'ai'],
};
export async function trendingFor(uid, net) {
  const k = uid + ':tr:' + net, c = C.get(k); if (c && Date.now() - c.at < 20 * 60e3) return c.data;
  const base = await trending(), uae = (base.regions.find((r) => r.id === 'uae') || {}).items || [];
  const out = { net, posts: [], topics: uae.slice(0, 12), tags: NTAGS[net] || [], news: [], errors: [] };
  if (net === 'instagram' && (await A.connected(uid)).some((x) => x.slug === 'instagram')) {
    try {
      const u = await igUser(uid);
      const search = await A.findTool('instagram', /HASHTAG.*(SEARCH|ID)|SEARCH.*HASHTAG/), top = await A.findTool('instagram', /HASHTAG.*TOP|TOP.*MEDIA/);
      if (search && top) for (const tag of out.tags.slice(0, 3)) {
        const h = await A.runFill(uid, search, { 'ig_user_id|user_id': u.id, 'q|hashtag|query|hashtag_name': tag });
        const hid = (arr(h)[0] || h?.data || h || {}).id; if (!hid) continue;
        const m = arr(await A.runFill(uid, top, { 'ig_hashtag_id|hashtag_id|id': hid, 'ig_user_id|user_id': u.id, 'fields': 'id,caption,media_type,media_url,permalink,like_count,comments_count,timestamp', 'limit': 8 }));
        for (const x of m.slice(0, 6)) out.posts.push({ tag, text: x.caption || '', image: x.media_type === 'VIDEO' ? '' : x.media_url, link: x.permalink, likes: x.like_count || 0, comments: x.comments_count || 0 });
      }
      out.posts.sort((a, b) => b.likes - a.likes);
    } catch (e) { out.errors.push('Instagram: ' + e.message); }
  }
  if (net === 'linkedin') {
    try {
      const r = await fetch('https://news.google.com/rss/search?hl=en-AE&gl=AE&ceid=AE:en&q=' + encodeURIComponent('UAE business OR logistics OR startup when:2d'), { signal: AbortSignal.timeout(12e3) });
      const x = await r.text(), dec = (t) => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      out.news = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map(([, i]) => ({ title: dec((i.match(/<title>([\s\S]*?)<\/title>/) || [])[1]), url: dec((i.match(/<link>([\s\S]*?)<\/link>/) || [])[1]), source: dec((i.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]) })).filter((n) => n.title);
    } catch {}
  }
  C.set(k, { at: Date.now(), data: out }); return out;
}

// LinkedIn: open any post from its link, like it and comment on it as you.
export function liUrn(link) {
  const t = decodeURIComponent(String(link || ''));
  const m = t.match(/urn:li:(activity|share|ugcPost):(\d{10,25})/) || t.match(/(activity|share|ugcPost)[-:](\d{15,25})/);
  return m ? `urn:li:${m[1]}:${m[2]}` : '';
}
export async function liComment(uid, link, text) {
  const urn = liUrn(link); if (!urn) throw err('That does not look like a LinkedIn post link.', 400);
  const me = await liMe(uid); if (!me.author) throw err('Reconnect LinkedIn first.', 400);
  const tool = 'LINKEDIN_CREATE_COMMENT_ON_POST', props = await A.toolParams(tool), msg = props.message?.type === 'string' ? text : { text };
  return A.runFill(uid, tool, { 'actor': me.author, 'object|target_urn|post_urn': urn, 'message': msg });
}
export async function liLike(uid, link) {
  const urn = liUrn(link); if (!urn) throw err('That does not look like a LinkedIn post link.', 400);
  const me = await liMe(uid); if (!me.author) throw err('Reconnect LinkedIn first.', 400);
  return A.proxy(uid, 'linkedin', { endpoint: 'https://api.linkedin.com/rest/reactions?actor=' + encodeURIComponent(me.author), method: 'POST', body: { root: urn, reactionType: 'LIKE' }, headers: { 'LinkedIn-Version': '202501', 'X-Restli-Protocol-Version': '2.0.0' } });
}

// Comment on one of your own posts (top-level comment).
export async function comment(uid, net, postId, text) {
  C.delete(uid + ':feed');
  if (net === 'instagram') { const t = await A.findTool('instagram', /POST_IG_MEDIA_COMMENTS$|CREATE.*MEDIA.*COMMENT|IG_MEDIA_COMMENT/); if (!t) throw err('Instagram does not allow this from Dioma yet. Reply to a comment instead.', 400); return A.runFill(uid, t, { 'ig_media_id|media_id': postId, 'message|text': text }); }
  if (net === 'facebook') return A.runFill(uid, 'FACEBOOK_CREATE_COMMENT', { 'object_id|post_id|id': postId, 'message|text': text });
  throw err('Commenting here is not available for this network.', 400);
}
