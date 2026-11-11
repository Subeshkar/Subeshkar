// Dioma Voice: a real voice assistant page (works on the phone, mic allowed, can be added to the home screen).
// You talk → Whisper turns it into text → Claude acts with Dioma's live connections (WhatsApp, Zoho Mail & Books,
// X, LinkedIn, WhatsApp status, trends) → answers out loud. "Auto" mode sends without asking; otherwise it reads
// back what it will send and waits for "yes".
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import crypto from 'node:crypto';
import { transcribe } from './transcribe.js';
import { talkToken, pushCommand } from './talk.js';
import * as P from './wa-personal.js';
import * as B from './wa-business.js';
import { zohoList, zohoRead, booksFindContacts, booksCreateInvoice, booksEmailInvoice, booksGetInvoice, booksSummary } from './zoho.js';
import { xPost, xLike, xFollow, xSearch, xReply } from './xpost.js';
import { liPost } from './linkedin.js';
import { trendPosts, newsToday } from './feeds.js';

const anthropic = new Anthropic();
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const WA = (acct) => (acct === 'business' ? B : P);
const acctP = { type: 'string', enum: ['personal', 'business'], description: 'Which WhatsApp number (default personal)' };
const ok = (req, res, next) => { const a = Buffer.from(String(req.params.t)), b = Buffer.from(talkToken()); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).send('Not found'); next(); };

const OUTWARD = new Set(['whatsapp_send', 'whatsapp_status', 'invoice_create', 'invoice_send', 'x_post', 'x_reply', 'linkedin_post']);
const tools = [
  { name: 'whatsapp_find_chat', description: 'Find WhatsApp chats by name or number (or list latest/unread when q is empty).', input_schema: { type: 'object', properties: { q: { type: 'string' }, unread_only: { type: 'boolean' }, acct: acctP } } },
  { name: 'whatsapp_read', description: 'Read the latest messages of a WhatsApp chat (chat_id from whatsapp_find_chat).', input_schema: { type: 'object', properties: { chat_id: { type: 'string' }, limit: { type: 'integer' }, acct: acctP }, required: ['chat_id'] } },
  { name: 'whatsapp_send', description: 'Send a WhatsApp message. chat_id from whatsapp_find_chat, or a phone number with country code.', input_schema: { type: 'object', properties: { chat_id: { type: 'string' }, to_name: { type: 'string' }, text: { type: 'string' }, acct: acctP, confirmed: { type: 'boolean' } }, required: ['chat_id', 'text'] } },
  { name: 'whatsapp_status', description: 'Post a text WhatsApp status (story).', input_schema: { type: 'object', properties: { text: { type: 'string' }, acct: acctP, confirmed: { type: 'boolean' } }, required: ['text'] } },
  { name: 'mail_list', description: 'List RedexGo mailbox (info@redexgo.com, Zoho Mail). folder: inbox|unread|sent|all; q = search words.', input_schema: { type: 'object', properties: { folder: { type: 'string' }, q: { type: 'string' } } } },
  { name: 'mail_read', description: 'Read one RedexGo email in full (folderId and id from mail_list).', input_schema: { type: 'object', properties: { folderId: { type: 'string' }, id: { type: 'string' } }, required: ['folderId', 'id'] } },
  { name: 'books_find_customer', description: 'Find a customer in Zoho Books (RedexGo).', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'books_overview', description: 'Zoho Books overview: overdue invoices, receivables, bills.', input_schema: { type: 'object', properties: {} } },
  { name: 'invoice_create', description: 'Create a RedexGo invoice in Zoho Books. 5% VAT is always added (rates are before VAT). If email is given it is emailed with the PDF from info@redexgo.com, CC info@.', input_schema: { type: 'object', properties: { customer_id: { type: 'string' }, customer_name: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, rate: { type: 'number' }, quantity: { type: 'number' } }, required: ['name', 'rate'] } }, email: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['customer_id', 'items'] } },
  { name: 'invoice_send', description: 'Email an existing invoice (number like INV-01024) with PDF, CC info@redexgo.com.', input_schema: { type: 'object', properties: { invoice: { type: 'string' }, to: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['invoice', 'to'] } },
  { name: 'x_post', description: 'Post on X as @CrSubesh (max 280 chars).', input_schema: { type: 'object', properties: { text: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['text'] } },
  { name: 'x_search', description: 'Find recent popular X posts on a topic.', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'x_like', description: 'Like an X post by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'x_follow', description: 'Follow an X user by user_id.', input_schema: { type: 'object', properties: { user_id: { type: 'string' }, user: { type: 'string' } }, required: ['user_id'] } },
  { name: 'x_reply', description: 'Reply to an X post by id.', input_schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['id', 'text'] } },
  { name: 'linkedin_post', description: 'Post on Subesh\'s personal LinkedIn profile.', input_schema: { type: 'object', properties: { text: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['text'] } },
  { name: 'trending', description: 'Trending posts now in UAE, GCC and worldwide.', input_schema: { type: 'object', properties: {} } },
  { name: 'news', description: 'Top news today. region: uae|world|tech.', input_schema: { type: 'object', properties: { region: { type: 'string' } } } },
];

async function run(name, i, auto) {
  if (OUTWARD.has(name) && !auto && !i.confirmed) return { needs_confirmation: true, note: 'Read back exactly what will be sent and to whom, ask "Shall I send it?", and call again with confirmed=true only after he says yes.' };
  switch (name) {
    case 'whatsapp_find_chat': return WA(i.acct).listChats({ q: i.q || '', unreadOnly: !!i.unread_only, limit: 12 }).map(({ id, name, phone, is_group, unread, last_text, last_from_me, last_at }) => ({ id, name, phone, is_group, unread, last: (last_from_me ? 'You: ' : '') + String(last_text || '').slice(0, 120), last_at }));
    case 'whatsapp_read': return WA(i.acct).listMessages(i.chat_id, Math.min(40, i.limit || 15)).map((m) => ({ from: m.sender, text: String(m.text || '').slice(0, 400), at: m.at }));
    case 'whatsapp_send': return WA(i.acct).sendPersonal(i.chat_id, i.text);
    case 'whatsapp_status': return WA(i.acct).postStatus(i.text);
    case 'mail_list': return (await zohoList(i.folder || 'inbox', i.q || '')).slice(0, 15).map(({ id, folderId, subject, from, to, date, snippet, unread }) => ({ id, folderId, subject, from, to, date, snippet: String(snippet || '').slice(0, 160), unread }));
    case 'mail_read': { const r = await zohoRead(i.folderId, i.id); return { ...r, body: String(r.body || '').slice(0, 5000) }; }
    case 'books_find_customer': return booksFindContacts(i.q);
    case 'books_overview': return booksSummary();
    case 'invoice_create': { const inv = await booksCreateInvoice({ customer_id: i.customer_id, items: i.items }); if (i.email) await booksEmailInvoice({ invoice_id: inv.invoice_id, to: [i.email] }); const v = await booksGetInvoice(inv.invoice_id); return { ...inv, status: v.status, emailed: v.is_emailed }; }
    case 'invoice_send': { const v = await booksGetInvoice(i.invoice); await booksEmailInvoice({ invoice_id: v.invoice_id, to: [i.to] }); const w = await booksGetInvoice(v.invoice_id); return { number: w.number, total: w.total, status: w.status, emailed: w.is_emailed }; }
    case 'x_post': return xPost(i.text);
    case 'x_search': return (await xSearch(i.q)).posts.slice(0, 8).map(({ id, text, user, user_id, likes }) => ({ id, text: String(text).slice(0, 200), user, user_id, likes }));
    case 'x_like': return xLike(i.id);
    case 'x_follow': return xFollow(i.user_id);
    case 'x_reply': return xReply(i.id, i.text);
    case 'linkedin_post': return liPost(i.text);
    case 'trending': return (await trendPosts()).regions.map((r) => ({ region: r.tag, posts: r.posts.slice(0, 5).map((p) => ({ topic: p.topic, title: p.title })) }));
    case 'news': return newsToday(i.region || 'uae');
    default: return { error: 'unknown tool' };
  }
}

const system = (auto) => `You are Dioma, Subeshkar (Subesh) Ravicanthiran's voice assistant. He is Founder & COO of RedexGo (cold-chain & middle-mile logistics, Dubai). Now: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} Dubai time.
He talks to you by voice, so your reply is read out loud: answer in 1-3 short spoken sentences, no lists, no markdown, no emojis, no links.
Act, don't explain: use the tools to find people, read chats and mail, and do the task. Find the right chat yourself; if two people match or none, ask ONE short question (e.g. the name saved in his phone).
Write messages in his voice: short, warm, direct; sign emails "Subesh". Invoices always include 5% VAT; emails go with the PDF from info@redexgo.com, CC info@redexgo.com.
${auto ? 'AUTO mode is ON: he wants things done without asking. Send directly (confirmed=true) unless something is unclear or risky.' : 'Before sending anything (WhatsApp, status, invoice, email, posts) read back in one sentence what will go and to whom and ask "Shall I send it?". Send only after he says yes.'}
TRUTH: never say something was sent or done unless the tool result confirms it. If a tool fails, say so plainly.`;

async function agent(history, auto) {
  const msgs = history.slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) })).filter((m) => m.content);
  const done = [];
  for (let step = 0; step < 8; step++) {
    const res = await anthropic.messages.create({ model: MODEL(), max_tokens: 800, system: system(auto), tools, messages: msgs });
    msgs.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((c) => c.type === 'tool_use');
    if (!uses.length) return { reply: res.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim(), done };
    const results = [];
    for (const u of uses) {
      let out; try { out = await run(u.name, u.input || {}, auto); if (OUTWARD.has(u.name) && !(out && out.needs_confirmation)) done.push(u.name); } catch (e) { out = { error: String(e.message || e) }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return { reply: 'That took too many steps. Please say it again more simply.', done };
}

const page = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Dioma"><meta name="theme-color" content="#111214">
<title>Dioma Voice</title><style>
:root{--bg:#111214;--card:#1b1c20;--fg:#f4f2ea;--mut:#9a988f;--y:#ffd84d;--ink:#16130a;--red:#e5484d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,sans-serif;min-height:100dvh;display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
header{display:flex;justify-content:space-between;align-items:center;gap:10px}h1{font-size:20px;margin:0;letter-spacing:.04em}
.auto{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--mut)}.auto input{width:20px;height:20px;accent-color:var(--y)}
#log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px 0}
.me,.ai{max-width:88%;padding:10px 14px;border-radius:16px;white-space:pre-wrap}.me{align-self:flex-end;background:var(--y);color:var(--ink);border-bottom-right-radius:4px}.ai{align-self:flex-start;background:var(--card);border-bottom-left-radius:4px}
.ai small{display:block;color:#6fd18b;margin-top:4px}.hint{color:var(--mut);text-align:center;margin:auto 0;font-size:15px}
.bar{display:flex;gap:10px;align-items:center}
#mic{width:76px;height:76px;border-radius:50%;border:0;background:var(--y);color:var(--ink);flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 24px rgba(255,216,77,.25)}
#mic.rec{background:var(--red);color:#fff;animation:p 1.2s infinite}@keyframes p{50%{box-shadow:0 0 0 14px rgba(229,72,77,.18)}}
#mic.busy{opacity:.6}form{flex:1;display:flex;gap:8px}input[type=text]{flex:1;min-width:0;padding:14px;border-radius:14px;border:1px solid #2c2d33;background:var(--card);color:var(--fg);font-size:16px}
button.s{border:0;border-radius:14px;padding:0 16px;background:var(--card);color:var(--fg);font-weight:700}#st{color:var(--mut);font-size:13px;text-align:center;min-height:18px;margin:6px 0}
</style></head><body>
<header><h1>DIOMA VOICE</h1><label class="auto"><input type="checkbox" id="auto"> Auto (no asking)</label></header>
<div id="log"><p class="hint" id="hint">Tap the yellow mic and talk.<br>“Send Mehraj a WhatsApp: meeting moved to 11.”<br>“Any unread mail on RedexGo?”<br>“Make an invoice for Ridge, Sharjah to Dubai, 850.”</p></div>
<div id="st"></div>
<div class="bar"><button id="mic" aria-label="Talk"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
<form id="f"><input type="text" id="tx" placeholder="or type…" autocomplete="off"><button class="s">Go</button></form></div>
<script>
const T=${JSON.stringify(t)};const log=document.getElementById('log'),st=document.getElementById('st'),mic=document.getElementById('mic'),auto=document.getElementById('auto');
let hist=[];try{hist=JSON.parse(sessionStorage.getItem('dv')||'[]');auto.checked=localStorage.getItem('dv-auto')==='1'}catch(e){}
auto.onchange=()=>{try{localStorage.setItem('dv-auto',auto.checked?'1':'0')}catch(e){}};
const add=(cls,text,extra)=>{document.getElementById('hint')?.remove();const d=document.createElement('div');d.className=cls;d.textContent=text;if(extra){const s=document.createElement('small');s.textContent=extra;d.append(s)}log.append(d);log.scrollTop=log.scrollHeight;return d};
for(const m of hist)add(m.role==='user'?'me':'ai',m.content);
const speak=(t)=>{try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.lang='en-GB';u.rate=1.05;speechSynthesis.speak(u)}catch(e){}};
async function ask(body){mic.classList.add('busy');st.textContent='Working…';
 try{const r=await fetch('/voice/'+T+'/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,history:hist,auto:auto.checked})});const j=await r.json();
  if(j.heard){add('me',j.heard);hist.push({role:'user',content:j.heard})}
  if(j.error){add('ai','⚠ '+j.error);st.textContent='';return}
  add('ai',j.reply,j.done&&j.done.length?'✓ Done: '+j.done.join(', ').replace(/_/g,' '):'');hist.push({role:'assistant',content:j.reply});hist=hist.slice(-16);try{sessionStorage.setItem('dv',JSON.stringify(hist))}catch(e){}
  speak(j.reply);st.textContent='';
 }catch(e){st.textContent='Network problem. Try again.'}finally{mic.classList.remove('busy')}}
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();const t=document.getElementById('tx').value.trim();if(!t)return;document.getElementById('tx').value='';ask({text:t})};
let rec=null,chunks=[];
mic.onclick=async()=>{
 if(rec&&rec.state==='recording'){rec.stop();return}
 try{speechSynthesis.cancel()}catch(e){}
 try{const s=await navigator.mediaDevices.getUserMedia({audio:true});const type=MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/mp4';rec=new MediaRecorder(s,{mimeType:type});chunks=[];
  rec.ondataavailable=(e)=>e.data.size&&chunks.push(e.data);
  rec.onstop=async()=>{s.getTracks().forEach(x=>x.stop());mic.classList.remove('rec');const b=new Blob(chunks,{type});st.textContent='Listening done · understanding…';
   const b64=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(String(fr.result).split(',')[1]);fr.readAsDataURL(b)});ask({audio:b64,mime:type})};
  rec.start();mic.classList.add('rec');st.textContent='Listening… tap again to stop';
 }catch(e){st.textContent='Allow the microphone for this page (browser settings).'}};
</script></body></html>`;

export function mountVoice(app) {
  app.get('/voice/:t', ok, (req, res) => res.set('Cache-Control', 'no-store').send(page(req.params.t)));
  app.post('/voice/:t/ask', ok, express.json({ limit: '25mb' }), async (req, res) => {
    try {
      const b = req.body || {};
      let heard = String(b.text || '').trim();
      if (!heard && b.audio) heard = String(await transcribe(Buffer.from(b.audio, 'base64'), b.mime || 'audio/webm') || '').trim();
      if (!heard) return res.json({ error: 'I did not catch that. Tap the mic and try again.' });
      // Without a server AI key, hand the request to Dioma (its AI runs on Subesh's Claude plan) — it picks it up within seconds.
      if (!process.env.ANTHROPIC_API_KEY) { pushCommand(heard); return res.json({ heard, reply: 'Got it. Dioma is doing it now — open Dioma to see it and approve.', done: ['sent to Dioma'] }); }
      const hist = Array.isArray(b.history) ? b.history : [];
      const { reply, done } = await agent([...hist, { role: 'user', content: heard }], !!b.auto);
      res.json({ heard, reply: reply || 'Done.', done });
    } catch (e) { res.json({ error: String(e.message || e).slice(0, 300) }); }
  });
}
export const voiceLink = () => `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'subeshkar-production.up.railway.app'}/voice/${talkToken()}`;
