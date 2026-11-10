// Photos/videos uploaded from Dioma for social posts. Stored on the server volume and served at an
// unguessable public URL, because Instagram/Facebook/LinkedIn fetch the image from a public https link.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = () => path.join(process.env.DATA_DIR || './data', 'media');
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const HOST = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}`;
export function saveMedia(mime, b64) {
  const ext = EXT[String(mime).toLowerCase()]; if (!ext) throw new Error('Only JPG, PNG, WEBP, GIF, MP4 or MOV');
  const buf = Buffer.from(String(b64 || ''), 'base64'); if (!buf.length) throw new Error('Empty file'); if (buf.length > 12 * 1024 * 1024) throw new Error('File is over 12 MB');
  fs.mkdirSync(DIR(), { recursive: true }); const id = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(DIR(), id), buf);
  return { ok: true, id, url: `${HOST()}/m/${id}`, mime, bytes: buf.length };
}
export function mediaFile(id) { if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif|mp4|mov)$/.test(String(id))) return null; const f = path.join(DIR(), id); return fs.existsSync(f) ? f : null; }
export function mountMedia(app) {
  const T = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime' };
  app.get('/m/:id', (req, res) => { const f = mediaFile(req.params.id); if (!f) return res.status(404).send('Not found'); res.set({ 'Content-Type': T[f.split('.').pop()], 'Cache-Control': 'public, max-age=31536000' }); res.sendFile(path.resolve(f)); });
}
