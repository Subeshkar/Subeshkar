// Voice note → text. Uses OpenAI Whisper when OPENAI_API_KEY is set (best quality, any language),
// otherwise a local Whisper model that runs on the server (no key, slower, downloads ~150 MB once).
import { spawn } from 'node:child_process';
import path from 'node:path';

let localPipe = null;
let queue = Promise.resolve();

async function viaOpenAI(buf, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimetype || 'audio/ogg' }), 'voice.ogg');
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
  // translations endpoint: any language in, English text out
  const res = await fetch('https://api.openai.com/v1/audio/translations', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  return String((await res.json()).text || '').trim();
}

async function toPcm(buf) {
  const ffmpeg = (await import('ffmpeg-static')).default;
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg failed'));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

async function viaLocal(buf) {
  if (!localPipe) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(process.env.DATA_DIR || './data', 'models');
    localPipe = await pipeline('automatic-speech-recognition', process.env.WHISPER_MODEL || 'onnx-community/whisper-small', { dtype: 'q8' });
  }
  const audio = await toPcm(buf);
  if (audio.length > 16000 * 600) throw new Error('Voice note longer than 10 minutes');
  // translate = any language in, English out; guards stop the model looping on one phrase
  const out = await localPipe(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false, task: 'translate', no_repeat_ngram_size: 4, repetition_penalty: 1.15 });
  return dedupe(String(out.text || '').trim());
}

// Remove a sentence repeated over and over (a known Whisper failure on noisy audio).
function dedupe(t) {
  const parts = t.split(/(?<=[.!?])\s+|,\s+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) if (!out.slice(-3).some((q) => q.toLowerCase() === p.toLowerCase())) out.push(p);
  const s = out.join(' ');
  return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
}

// One at a time so the server stays responsive.
export function transcribe(buf, mimetype) {
  const job = queue.then(() => (process.env.OPENAI_API_KEY ? viaOpenAI(buf, mimetype) : viaLocal(buf)));
  queue = job.catch(() => {});
  return job;
}
