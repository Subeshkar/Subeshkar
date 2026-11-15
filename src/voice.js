// Voice: Dioma listens (speech to text) and speaks (natural voice). Uses OpenAI's audio models; needs OPENAI_API_KEY.
const KEY = () => process.env.OPENAI_API_KEY || '';
export const enabled = () => !!KEY();
const err = (m, status = 502) => Object.assign(new Error(m), { status });

export async function listen(buf, mime) {
  if (!enabled()) throw err('Voice is being switched on.', 503);
  const ext = /mp4|m4a|aac/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const f = new FormData();
  f.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'voice.' + ext);
  f.append('model', 'gpt-4o-mini-transcribe');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + KEY() }, body: f, signal: AbortSignal.timeout(60e3) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('listen', r.status, JSON.stringify(j).slice(0, 300)); throw err('Could not hear that. Try again.'); }
  return String(j.text || '').trim();
}

export async function speak(text) {
  if (!enabled()) throw err('Voice is being switched on.', 503);
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: 'Bearer ' + KEY(), 'content-type': 'application/json' }, signal: AbortSignal.timeout(60e3),
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'coral', response_format: 'mp3', input: String(text).slice(0, 3500),
      instructions: 'You are Dioma, a warm, calm personal assistant. Speak naturally and clearly at a relaxed pace, like a trusted assistant talking to their boss. Pronounce UAE place names correctly.' }),
  });
  if (!r.ok) { console.error('speak', r.status, (await r.text()).slice(0, 300)); throw err('Could not speak right now.'); }
  return Buffer.from(await r.arrayBuffer());
}
