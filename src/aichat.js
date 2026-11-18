// Dioma AI: a general assistant like ChatGPT. Separate conversations, answers stream as they are written,
// web search for anything current, photos and PDFs can be added. Customers only ever see "Dioma".
import { db, all, one, run } from './db.js';
import { createRequire } from 'node:module';
const XLSX = createRequire(import.meta.url)('xlsx');
// Excel, CSV, Word and PowerPoint become plain text Dioma can read.
const isSheet = (f) => /\.(xlsx|xlsm|xls|csv|ods)$/i.test(f.name || '') || /spreadsheet|excel|csv/.test(f.type || '');
const isOffice = (f) => /\.(docx|pptx)$/i.test(f.name || '') || /wordprocessingml|presentationml/.test(f.type || '');
export function officeText(f) {
  const buf = Buffer.from(f.data, 'base64');
  if (isSheet(f)) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    return wb.SheetNames.slice(0, 12).map((n) => `Sheet "${n}":\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }).split('\n').slice(0, 1500).join('\n')).join('\n\n');
  }
  const zip = XLSX.CFB.read(buf, { type: 'buffer' }), get = (p) => { const e = XLSX.CFB.find(zip, '/' + p) || XLSX.CFB.find(zip, p); return e ? Buffer.from(e.content).toString('utf8') : ''; };
  const strip = (x) => x.replace(/<\/w:p>|<\/a:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
  if (/\.docx$/i.test(f.name) || /wordprocessingml/.test(f.type)) return strip(get('word/document.xml'));
  const out = []; for (let i = 1; i <= 80; i++) { const x = get(`ppt/slides/slide${i}.xml`); if (!x) break; out.push(`Slide ${i}:\n` + strip(x)); } return out.join('\n\n');
}

db.exec(`CREATE TABLE IF NOT EXISTS ai_threads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS ai_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT, files TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS ai_msgs_t ON ai_msgs(thread_id, id);`);

const MODEL = () => process.env.DIOMA_MODEL || 'claude-sonnet-5-5';
export const threads = (uid) => all('SELECT id, title, at FROM ai_threads WHERE user_id = ? ORDER BY at DESC LIMIT 100', uid);
export const messages = (uid, tid) => { const t = one('SELECT id FROM ai_threads WHERE id = ? AND user_id = ?', tid, uid); return t ? all('SELECT role, text, files, at FROM ai_msgs WHERE thread_id = ? ORDER BY id', tid).map((m) => ({ ...m, files: m.files ? JSON.parse(m.files) : [] })) : null; };
export const remove = (uid, tid) => run('DELETE FROM ai_threads WHERE id = ? AND user_id = ?', tid, uid);

const SYS = (u) => `You are Dioma, a helpful, knowledgeable AI assistant, like ChatGPT. Answer any question: work, study, writing, code, business, travel, health information, maths, ideas, everyday life.
The person: ${u.name || 'the user'}${u.about ? ', ' + u.about : ''}. They live in the UAE (time zone ${u.tz || 'Asia/Dubai'}). Today is ${new Date().toLocaleString('en-GB', { timeZone: u.tz || 'Asia/Dubai', dateStyle: 'full', timeStyle: 'short' })}.
Style: clear and direct, lead with the answer, then detail when useful. Use Markdown: short headings, bullet lists, tables and code blocks when they help. Never use the em dash character. Match the language the person writes in.
Use web search for anything recent or that may have changed (news, prices, laws, sports, people in roles) and mention where it came from.
For medical, legal or financial questions give accurate general information and suggest a professional where it matters.
When you write something for them to send or post (they deal with customers, so it must feel impressive and caring): natural, fluent American English, the way a warm, sharp American founder or client-success lead talks, opening with the person's name and a genuine touch, concrete details, clear ownership of the next step (contractions, plain everyday words, US spelling, no "kindly", "revert", "do the needful" or "please find attached"), warm and human, short but complete (the point, key facts, one clear next step); WhatsApp may have an emoji or two when it fits, emails stay short and polite with no filler.
When they attach or paste documents (proposals, quotes, contracts) and ask for the final message to send, read all of them, then give just the ready-to-send message (with a Subject line if it is an email), short and complete, no long analysis unless they ask.
When asked to send an email or a WhatsApp, never say you cannot send: write the ready message (for email start with a line "Subject: ...", then the full email), and end with one line telling them to tap ✉ Email it or 💬 WhatsApp it under this answer to pick the person, the mailbox and send.
THEIR OWN TARGETS WIN: when the person gives their own target prices, discounts or terms, use exactly those in the table ('Our target' column) and in the email; never your own suggested asks. If they correct an email, redo the whole summary and email.
EMAIL FORMAT: write email bodies in light Markdown, which Dioma sends as a clean formatted email: short paragraphs, '- ' bullets for lists, **bold** for section labels (e.g. **One-time hardware**), and a Markdown table (| Item | Price |) whenever there are 3 or more prices or figures. No headings with #.
PRICES, QUOTES AND DEALS: before any email or message about prices, put a short decision summary first, then the draft. The summary is: a small table with every line item from their quote (include every charge, discount and fee, even if the person did not mention it), their price, our ask and the gap; one-time costs and monthly costs in separate rows and separate totals, never added together; check every sum and every percentage yourself; volume tiers must not overlap (1 to 99, 100+); then one line with your recommendation and any open question. Keep it under 10 lines so they can decide in seconds. The email must match the summary exactly.
For hard conversations (price changes, extra charges, losses, unpaid invoices, mistakes): humble and collaborative, never a flat no or blame; thank them, apologize for any confusion on your side, explain kindly, ask for their understanding, show numbers in a small table, say what happens next, and close with finding the best way forward together.
They type fast, often with spelling mistakes: always understand what they mean, never ask about spelling.
If asked what powers you: Dioma is built on Claude by Anthropic.`;

// Stream an answer. write(text) gets each new piece. Returns the full answer.
// Save a question and an answer made elsewhere (the assistant with mail, WhatsApp and Zoho) into a Dioma AI chat.
export function save(u, tid, text, reply, write) {
  let t = tid && one('SELECT id FROM ai_threads WHERE id = ? AND user_id = ?', tid, u.id);
  if (!t) { const r = run('INSERT INTO ai_threads (user_id, title, at) VALUES (?, ?, ?)', u.id, text.slice(0, 60) || 'New chat', Date.now()); t = { id: Number(r.lastInsertRowid) }; write({ thread: t.id }); }
  run('INSERT INTO ai_msgs (thread_id, role, text, at) VALUES (?, ?, ?, ?)', t.id, 'user', text, Date.now());
  run('INSERT INTO ai_msgs (thread_id, role, text, at) VALUES (?, ?, ?, ?)', t.id, 'assistant', reply, Date.now());
  run('UPDATE ai_threads SET at = ? WHERE id = ?', Date.now(), t.id);
}
export async function answer(u, tid, text, files, write) {
  let t = tid && one('SELECT id FROM ai_threads WHERE id = ? AND user_id = ?', tid, u.id);
  if (!t) { const r = run('INSERT INTO ai_threads (user_id, title, at) VALUES (?, ?, ?)', u.id, text.slice(0, 60) || 'New chat', Date.now()); t = { id: Number(r.lastInsertRowid) }; }
  const hist = all('SELECT role, text FROM ai_msgs WHERE thread_id = ? ORDER BY id DESC LIMIT 20', t.id).reverse();
  const content = [];
  for (const f of files || []) {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) content.push({ type: 'image', source: { type: 'base64', media_type: f.type === 'image/jpg' ? 'image/jpeg' : f.type, data: f.data } });
    else if (f.type === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
    else if (isSheet(f) || isOffice(f)) { let x = ''; try { x = officeText(f); } catch { x = '(Dioma could not open this file. Try saving it as PDF.)'; } content.push({ type: 'text', text: `File ${f.name}:\n` + x.slice(0, 80000) }); }
    else if (/^text\//.test(f.type)) content.push({ type: 'text', text: `File ${f.name}:\n` + Buffer.from(f.data, 'base64').toString('utf8').slice(0, 60000) });
  }
  content.push({ type: 'text', text });
  const msgs = [...hist.map((m) => ({ role: m.role, content: m.text || '(file)' })), { role: 'user', content }];
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  run('INSERT INTO ai_msgs (thread_id, role, text, files, at) VALUES (?, ?, ?, ?, ?)', t.id, 'user', text, (files || []).length ? JSON.stringify(files.map((f) => ({ name: f.name, type: f.type }))) : null, Date.now());
  write({ thread: t.id });
  let full = '';
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { full = 'This is a test answer (no AI key on this server).\n\n- You asked: **' + text.slice(0, 80) + '**'; write({ t: full }); }
  else {
    const call = (web) => fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 4000, stream: true, system: SYS(u), messages: msgs, ...(web ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] } : {}) }) });
    let r = await call(true);
    if (!r.ok && r.status === 400) r = await call(false); // web search not available: answer without it
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j?.error?.message || 'Dioma could not answer just now.'), { status: 502 }); }
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = ev.split('\n').find((l) => l.startsWith('data: ')); if (!line) continue;
        let d; try { d = JSON.parse(line.slice(6)); } catch { continue; }
        if (d.type === 'content_block_start' && d.content_block?.type === 'server_tool_use') write({ s: 'Searching the web…' });
        if (d.type === 'content_block_start' && d.content_block?.type === 'text' && full && !/\n$/.test(full)) { full += '\n\n'; write({ t: '\n\n' }); }
        if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') { full += d.delta.text; write({ t: d.delta.text }); }
        if (d.type === 'error') throw new Error(d.error?.message || 'Stopped');
      }
    }
  }
  run('INSERT INTO ai_msgs (thread_id, role, text, at) VALUES (?, ?, ?, ?)', t.id, 'assistant', full, Date.now());
  run('UPDATE ai_threads SET at = ? WHERE id = ?', Date.now(), t.id);
  return full;
}
