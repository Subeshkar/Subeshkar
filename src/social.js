// Social: recent posts and comments (Instagram, Facebook Page), reply to comments, and publish posts (LinkedIn, Facebook, Instagram with a photo).
// Nothing is posted or replied without the customer tapping Post / Send.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR } from './db.js';
import * as A from './apps.js';

const PUB = path.join(DIR, 'pub'); fs.mkdirSync(PUB, { recursive: true });
const C = new Map(); // uid:net -> { at, data }
const arr = (d) => A.arrayIn(d) || [];
const err = (m, s = 502) => Object.assign(new Error(m), { status: s });

async function igUser(uid) {
  const k = uid + ':igid'; const c = C.get(k); if (c) return c.data;
  const d = await A.runFill(uid, 'INSTAGRAM_GET_USER_INFO', { 'ig_user_id|user_id': 'me', 'fields': 'id,username,name' });
  const v = { id: String(d?.id || d?.data?.id || ''), name: d?.username || d?.data?.username || d?.name || '' };
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
export const publicFile = (id) => (/^[a-f0-9]{24}\.(jpg|png)$/.test(id) && fs.existsSync(path.join(PUB, id)) ? path.join(PUB, id) : null);

export async function post(uid, net, text, imageUrl) {
  C.delete(uid + ':feed');
  if (net === 'linkedin') {
    const me = await A.runFill(uid, 'LINKEDIN_GET_MY_INFO', {});
    const pid = me?.sub || me?.id || me?.data?.sub || me?.data?.id || me?.author_id || '';
    const author = String(pid).startsWith('urn:') ? pid : pid ? 'urn:li:person:' + pid : '';
    return A.runFill(uid, 'LINKEDIN_CREATE_LINKED_IN_POST', { 'author': author, 'commentary|text|content': text, 'visibility': 'PUBLIC', 'lifecycleState|lifecycle_state': 'PUBLISHED' });
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
