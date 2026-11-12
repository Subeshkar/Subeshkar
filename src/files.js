// Company files: trade license, VAT certificate, company profile, rate cards… stored once on the server,
// then sent from Dioma (WhatsApp document, or a private download link in emails) whenever needed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = () => path.join(process.env.DATA_DIR || './data', 'files');
const IDX = () => path.join(DIR(), 'index.json');
const HOST = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}`;
const load = () => { try { return JSON.parse(fs.readFileSync(IDX(), 'utf8')); } catch { return []; } };
const store = (l) => { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(IDX(), JSON.stringify(l), { mode: 0o600 }); };
const pub = (f) => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, folder: f.folder || 'Company', at: f.at, link: `${HOST()}/f/${f.id}/${encodeURIComponent(f.name)}` });

export function fileSave(name, mime, b64, folder) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new Error('Empty file'); if (buf.length > 15 * 1024 * 1024) throw new Error('File is over 15 MB');
  const id = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(path.join(DIR(), id), buf);
  const f = { id, name: String(name || 'file').replace(/[\\/]/g, '_').slice(0, 120), mime: String(mime || 'application/octet-stream'), bytes: buf.length, folder: String(folder || 'Company').slice(0, 40), at: Date.now() };
  const l = load(); l.unshift(f); store(l); return pub(f);
}
export const fileList = (q) => { const ql = String(q || '').toLowerCase(); return load().filter((f) => !ql || (f.name + ' ' + f.folder).toLowerCase().includes(ql)).map(pub); };
export function fileGet(idOrName) { const l = load(); const s = String(idOrName || '').toLowerCase(); return l.find((f) => f.id === idOrName) || l.find((f) => f.name.toLowerCase() === s) || l.find((f) => f.name.toLowerCase().includes(s)); }
export function fileData(f) { return fs.readFileSync(path.join(DIR(), f.id)); }
export function fileDelete(id) { const l = load(); const f = l.find((x) => x.id === id); if (!f) return { ok: false }; try { fs.unlinkSync(path.join(DIR(), id)); } catch {} store(l.filter((x) => x.id !== id)); return { ok: true }; }
export function fileRename(id, name, folder) { const l = load(); const f = l.find((x) => x.id === id); if (!f) throw new Error('File not found'); if (name) f.name = String(name).slice(0, 120); if (folder) f.folder = String(folder).slice(0, 40); store(l); return pub(f); }
export function mountFiles(app) {
  app.get('/f/:id/:name?', (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.status(404).send('Not found');
    const f = load().find((x) => x.id === req.params.id); if (!f) return res.status(404).send('Not found');
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, max-age=3600' });
    res.sendFile(path.resolve(path.join(DIR(), f.id)));
  });
}
