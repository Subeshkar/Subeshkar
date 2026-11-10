// Live voice for Dioma. Claude pages can't use the microphone, so Dioma opens this small page
// (a normal browser tab, where the mic works). You speak, it turns into text, and Dioma picks it up.
import crypto from 'node:crypto';
import express from 'express';
import { transcribe } from './transcribe.js';
import { mcpToken } from './mcp.js';

let last = null; // { text, at }

export const talkToken = () => crypto.createHmac('sha256', mcpToken()).update('dioma-talk').digest('hex').slice(0, 32);
export const talkLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/talk/${talkToken()}`;
export const takeCommand = (since) => (last && last.at > Number(since || 0) ? last : null);
// Pulse: live recordings saved straight into the day log (Dioma picks them up).
const pulseQ = [];
export const takePulse = (since) => pulseQ.filter((x) => x.at > Number(since || 0));

const ok = (req, res, next) => {
  const a = Buffer.from(String(req.params.t)), b = Buffer.from(talkToken());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found');
  next();
};

const page = (pulse) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pulse ? 'Pulse · record' : 'Talk to Dioma'}</title><style>
[hidden]{display:none!important}
:root{--bg:#0f1115;--fg:#f3f1ea;--mut:#9a9890;--acc:#e8c547;--card:#1a1d24}
@media (prefers-color-scheme: light){:root{--bg:#f6f4ee;--fg:#16181d;--mut:#6b6a64;--acc:#b8901a;--card:#fff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
h1{font-size:20px;margin:0 0 6px}p{color:var(--mut);margin:0 0 24px;max-width:340px}
#rec{width:150px;height:150px;border-radius:50%;border:0;background:var(--acc);color:#111;font-size:56px;cursor:pointer;box-shadow:0 0 0 0 rgba(232,197,71,.5)}
#rec.on{animation:p 1.2s infinite;background:#e5484d;color:#fff}@keyframes p{70%{box-shadow:0 0 0 24px rgba(229,72,77,0)}}
#st{margin-top:20px;font-weight:600;min-height:24px}#tx{background:var(--card);border-radius:14px;padding:14px;margin-top:16px;max-width:360px;text-align:left;white-space:pre-wrap}
.row{display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap}button.b{border:0;border-radius:12px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer;background:var(--acc);color:#111}button.g{background:transparent;color:var(--fg);border:1px solid var(--mut)}
</style></head><body>
${pulse ? '<h1>Pulse · record live</h1><p>Tap the mic and talk, or keep it running during a meeting. Tap again to stop. It is saved into your Pulse day log.</p><input id="pl" placeholder="Where? (optional)" style="padding:10px;border-radius:10px;border:1px solid var(--mut);background:var(--card);color:var(--fg);margin-bottom:18px;width:240px">' : '<h1>Talk to Dioma</h1><p>Tap the mic and say what you want: “Email Mahar from my business email…”. Tap again to stop.</p>'}
<button id="rec" aria-label="Record">🎤</button><div id="st"></div><div id="tx" hidden></div>
<div class="row" id="acts" hidden><button class="b" id="send">${pulse ? 'Save to Pulse' : 'Send to Dioma'}</button><button class="b g" id="again">Record again</button></div>
<script>
const rec=document.getElementById('rec'),st=document.getElementById('st'),tx=document.getElementById('tx'),acts=document.getElementById('acts');
let mr=null,chunks=[],text='';
rec.onclick=async()=>{
  if(mr&&mr.state==='recording'){mr.stop();return;}
  try{
    const s=await navigator.mediaDevices.getUserMedia({audio:true});
    chunks=[];mr=new MediaRecorder(s);mr.ondataavailable=e=>e.data.size&&chunks.push(e.data);
    mr.onstop=async()=>{s.getTracks().forEach(t=>t.stop());rec.classList.remove('on');rec.textContent='🎤';st.textContent='Turning your voice into text…';
      const blob=new Blob(chunks,{type:mr.mimeType||'audio/webm'});
      try{const r=await fetch(location.pathname+'/audio',{method:'POST',headers:{'Content-Type':blob.type||'audio/webm'},body:blob});const j=await r.json();if(!j.text)throw new Error(j.error||'No words heard. Try again.');
        text=j.text;tx.textContent=text;tx.hidden=false;acts.hidden=false;st.textContent='Is this right?';}
      catch(e){st.textContent=e.message;}};
    mr.start();rec.classList.add('on');rec.textContent='■';st.textContent='Listening… tap to stop';tx.hidden=true;acts.hidden=true;
  }catch(e){st.textContent='Allow the microphone for this page, then tap again.';}
};
document.getElementById('again').onclick=()=>rec.click();
document.getElementById('send').onclick=async()=>{await fetch(location.pathname+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,to:${pulse ? "'pulse'" : "''"},place:(document.getElementById('pl')||{}).value||''})});acts.hidden=true;st.textContent=${pulse ? "'✓ Saved to Pulse. Record again or go back to Dioma.'" : "'✓ Sent. Go back to Dioma — it is working on it.'"};};
</script></body></html>`;

export function mountTalk(app) {
  app.get('/talk/:t', ok, (req, res) => res.set('Cache-Control', 'no-store').send(page(req.query.to === 'pulse')));
  app.post('/talk/:t/audio', ok, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    try {
      if (!req.body || !req.body.length) return res.json({ error: 'Empty recording.' });
      const t = String(await transcribe(req.body, req.get('content-type') || 'audio/webm')).trim();
      res.json(/^(you|thank you\.?|\.)$/i.test(t) ? { error: 'No words heard. Try again.' } : { text: t });
    } catch (e) { res.json({ error: String(e.message || e) }); }
  });
  app.post('/talk/:t/send', ok, (req, res) => {
    const text = String((req.body || {}).text || '').trim().slice(0, 2000);
    if (text && (req.body || {}).to === 'pulse') { pulseQ.push({ text, place: String((req.body || {}).place || '').slice(0, 80), at: Date.now() }); while (pulseQ.length > 50) pulseQ.shift(); }
    else if (text) last = { text, at: Date.now() };
    res.json({ ok: !!text });
  });
}
