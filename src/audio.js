// Audio conversion with ffmpeg (voice notes): WhatsApp sends Ogg/Opus, iPhones play AAC (m4a); WhatsApp voice notes must be Ogg/Opus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BIN = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p)) || '';
export const available = () => !!BIN;
function run(buf, outExt, args) {
  if (!BIN) return Promise.reject(new Error('Audio tools are not installed yet.'));
  const id = crypto.randomBytes(8).toString('hex'), inp = path.join(os.tmpdir(), id + '.in'), out = path.join(os.tmpdir(), id + '.' + outExt);
  fs.writeFileSync(inp, buf);
  return new Promise((res, rej) => {
    const p = spawn(BIN, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inp, ...args, out]);
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 60e3);
    p.on('close', (code) => { clearTimeout(t); try { fs.unlinkSync(inp); } catch {} if (code !== 0) { try { fs.unlinkSync(out); } catch {} return rej(new Error('Could not convert the audio. ' + err.slice(0, 200))); } const b = fs.readFileSync(out); fs.unlinkSync(out); res(b); });
  });
}
export const toOpus = (buf) => run(buf, 'ogg', ['-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip']);
export const toM4a = (buf) => run(buf, 'm4a', ['-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']);
