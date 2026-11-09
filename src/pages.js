import { db, allUsers, getPerm, APPS } from './db.js';
import { pendingActions } from './actions.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const mascot = (size = 64, body = '#FFD93B', eye = '#111111', pupil = '#FFFFFF') => `<svg width="${size}" height="${Math.round(size * 1.12)}" viewBox="0 0 64 72" aria-hidden="true"><path d="M20 10 Q32 2 44 10" stroke="#9A9A9A" stroke-width="2.5" fill="none" stroke-linecap="round"/><ellipse cx="32" cy="42" rx="22" ry="26" fill="${body}"/><circle cx="24" cy="38" r="6" fill="${eye}"/><circle cx="40" cy="38" r="6" fill="${eye}"/><circle cx="24" cy="38" r="2.4" fill="${pupil}"/><circle cx="40" cy="38" r="2.4" fill="${pupil}"/><path d="M27 50 Q32 54 37 50" stroke="${eye}" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Figtree:wght@400;500;600;700;800&display=swap">
<style>
:root{--bg:#111111;--card:#1B1B1B;--line:#2A2A2A;--y:#FFD93B;--muted:#B5B5B5;--red:#FFB4A0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#fff;font-family:'Figtree',system-ui,sans-serif;line-height:1.5}
a{color:var(--y)}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:28px}
.brand{display:flex;align-items:center;gap:10px;font-family:'Oswald',sans-serif;font-weight:700;font-size:24px;letter-spacing:1px}
.eyebrow{font-size:12px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin:0}
h1{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;line-height:1.02;margin:8px 0 0;font-size:clamp(40px,8vw,84px)}
h2{font-family:'Oswald',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:22px;margin:0 0 12px}
.y{color:var(--y)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px}
.ycard{background:var(--y);color:#111;border-radius:22px;padding:22px}
.tag{font-size:11px;letter-spacing:2px;font-weight:800;color:var(--y);text-transform:uppercase}
.muted{color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:14px;border:0;background:var(--y);color:#111;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer;font-family:inherit}
.btn.ghost{background:transparent;color:#fff;border:1px solid #3A3A3A}
.btn.dark{background:#111;color:#fff}
select{background:#111;color:#fff;border:1px solid #3A3A3A;border-radius:10px;min-height:38px;padding:0 10px;font-family:inherit}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;letter-spacing:1px;text-transform:uppercase}
.pill{display:inline-block;font-size:11px;font-weight:800;letter-spacing:1px;border-radius:999px;padding:3px 9px}
section{margin-top:34px}
form{display:inline}
.scroll{overflow-x:auto}
pre{white-space:pre-wrap;margin:0;font-family:inherit}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

export function landingPage() {
  const num = process.env.DIOMA_DISPLAY_NUMBER;
  const cta = num ? `<a class="btn" href="https://wa.me/${esc(num)}?text=Hi%20Dioma">Message Dioma on WhatsApp</a>` : '';
  return shell('Dioma', `
<div class="top"><div class="brand">${mascot(30)} DIOMA</div><a class="btn ghost" href="/dashboard">Dashboard</a></div>
<p class="eyebrow">Personal AI for UAE students and professionals</p>
<h1>Dream it.<br><span class="y">Done.</span></h1>
<p style="font-size:19px;max-width:620px;color:#E6E6E6">Tell Dioma what you want on WhatsApp. It plans the steps, works across your email and calendar, and asks you before anything is sent or booked.</p>
<p style="margin-top:22px">${cta}</p>
<section class="grid">
  <div class="ycard"><div style="font-size:11px;letter-spacing:2px;font-weight:800">YOU DREAM IT</div><p style="font-family:Oswald;font-size:28px;line-height:1.1;margin:8px 0 0;text-transform:uppercase">"Reply to my lecturer and book office hours"</p></div>
  <div class="card"><div class="tag">Dioma does it</div><p style="font-size:17px">Reads your inbox, checks your calendar, drafts the reply and the event.</p></div>
  <div class="card"><div class="tag">You say yes</div><p style="font-size:17px">Approve or Cancel buttons arrive on WhatsApp. Nothing leaves without your word.</p></div>
</section>`);
}

const resultColor = (r) => ({ ALLOWED: '#FFD93B', AUTO: '#FFD93B', SENT: '#FFD93B', DENIED: '#FFB4A0', FAILED: '#FFB4A0', OFF: '#9A9A9A', SKIPPED: '#9A9A9A' }[r] || '#B5B5B5');
const when = (t) => t ? new Date(t).toLocaleString('en-GB', { timeZone: process.env.DEFAULT_TIMEZONE || 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export function dashboardPage() {
  const users = allUsers();
  const pending = pendingActions();
  const activity = db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 40').all();
  const reminders = db.prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY due_at LIMIT 20').all();
  const tasks = db.prepare('SELECT * FROM tasks WHERE done = 0 ORDER BY id DESC LIMIT 20').all();
  const stats = {
    users: users.length,
    messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
    approved: db.prepare(`SELECT COUNT(*) c FROM actions WHERE status = 'done'`).get().c,
    pending: pending.length
  };

  const userRows = users.map((u) => `<tr>
    <td><strong>${esc(u.name || 'No name yet')}</strong><br><span class="muted">+${esc(u.phone)}</span></td>
    <td>${u.google_tokens ? `<span class="pill" style="background:#FFD93B;color:#111">GOOGLE</span><br><span class="muted">${esc(u.google_email || '')}</span>` : '<span class="muted">Not connected</span>'}</td>
    <td>${APPS.map((a) => `<form method="post" action="/dashboard/perm" style="display:block;margin-bottom:6px"><input type="hidden" name="phone" value="${esc(u.phone)}"><input type="hidden" name="app" value="${a}"><label>${a} <select name="mode" onchange="this.form.submit()">${['ask', 'always', 'off'].map((m) => `<option value="${m}" ${getPerm(u.phone, a) === m ? 'selected' : ''}>${m === 'ask' ? 'Ask me' : m === 'always' ? 'Always' : 'Off'}</option>`).join('')}</select></label></form>`).join('')}</td>
    <td>${esc(u.brief_time || '')} · ${esc(u.timezone || '')}<br><span class="muted">Last message ${when(u.last_inbound)}</span></td>
    <td><form method="post" action="/dashboard/brief"><input type="hidden" name="phone" value="${esc(u.phone)}"><button class="btn ghost" type="submit">Send brief now</button></form></td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted">No users yet. Send "hi" to your Dioma WhatsApp number.</td></tr>';

  const pendingCards = pending.map((a) => `<div class="card"><div class="tag">${esc(a.app)} · waiting for +${esc(a.phone)}</div><pre style="margin:8px 0 12px;font-size:14px">${esc(a.summary)}</pre>
    <form method="post" action="/dashboard/decide"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="decision" value="approve"><button class="btn" type="submit">Approve</button></form>
    <form method="post" action="/dashboard/decide"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="decision" value="cancel"><button class="btn ghost" type="submit">Cancel</button></form></div>`).join('') || '<p class="muted">Nothing waiting for approval.</p>';

  const actRows = activity.map((e) => `<tr><td class="muted">${when(e.created_at)}</td><td>+${esc(e.phone)}</td><td>${esc(e.text)}</td><td><span class="pill" style="border:1px solid ${resultColor(e.result)};color:${resultColor(e.result)}">${esc(e.result)}</span></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>';

  return shell('Dioma dashboard', `
<div class="top"><div class="brand">${mascot(30)} DIOMA</div><a class="btn ghost" href="/dashboard">Refresh</a></div>
<p class="eyebrow">Live dashboard</p>
<h1 style="font-size:clamp(36px,6vw,64px)">Everything Dioma did,<br><span class="y">with your OK</span></h1>
<section class="grid">
  ${[['People using Dioma', stats.users], ['Messages handled', stats.messages], ['Actions approved and done', stats.approved], ['Waiting for approval', stats.pending]]
    .map(([l, n], i) => `<div class="${i === 2 ? 'ycard' : 'card'}"><div style="font-size:12px;letter-spacing:2px;font-weight:800;${i === 2 ? '' : 'color:#B5B5B5'}">${l.toUpperCase()}</div><div style="font-family:Oswald;font-size:48px;line-height:1.1">${n}</div></div>`).join('')}
</section>
<section><h2>Waiting for approval</h2><div class="grid">${pendingCards}</div></section>
<section><h2>Users and permissions</h2><div class="card scroll"><table><thead><tr><th>User</th><th>Google</th><th>Permissions</th><th>Morning brief</th><th></th></tr></thead><tbody>${userRows}</tbody></table></div></section>
<section><h2>Activity log</h2><div class="card scroll"><table><thead><tr><th>When</th><th>User</th><th>What</th><th>Result</th></tr></thead><tbody>${actRows}</tbody></table></div></section>
<section class="grid">
  <div><h2>Upcoming reminders</h2><div class="card">${reminders.map((r) => `<p style="margin:0 0 8px"><span class="y">${when(r.due_at)}</span> · ${esc(r.text)}</p>`).join('') || '<p class="muted" style="margin:0">None.</p>'}</div></div>
  <div><h2>Open tasks</h2><div class="card">${tasks.map((t) => `<p style="margin:0 0 8px">${esc(t.title)}${t.due ? ` <span class="muted">· ${esc(t.due)}</span>` : ''}</p>`).join('') || '<p class="muted" style="margin:0">None.</p>'}</div></div>
</section>`);
}

export function messagePage(title, text, ok = true) {
  return shell(title, `<div class="top"><div class="brand">${mascot(30)} DIOMA</div></div>
<div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;margin-top:40px">${mascot(120, ok ? '#FFD93B' : '#3A3A3A')}
<h1 style="font-size:clamp(34px,7vw,60px)">${esc(title)}</h1><p style="font-size:18px;max-width:520px;color:#E6E6E6">${esc(text)}</p></div>`);
}

const PERSONAL_LABEL = { pair: 'Enter the code', off: 'Not linked', starting: 'Starting…', qr: 'Scan the QR code', connected: 'Linked', reconnecting: 'Reconnecting…', logged_out: 'Logged out', error: 'Error' };

export function personalPage(s, mcpUrl) {
  const body = s.pairCode
    ? `<div class="card" style="text-align:center"><p class="tag" style="margin:0 0 8px">Your code</p><p style="font-family:'Oswald',sans-serif;font-size:48px;letter-spacing:6px;margin:0;color:var(--y)">${esc(s.pairCode)}</p><p class="muted" style="margin:12px 0 0">On your phone: WhatsApp → Settings → <b>Linked devices</b> → <b>Link a device</b> → tap <b>Link with phone number instead</b> → type this code.</p></div>`
    : s.status === 'qr' && s.qr
    ? `<div class="card" style="text-align:center"><img src="${s.qr}" alt="WhatsApp link QR code" width="300" height="300" style="background:#fff;border-radius:14px;padding:8px;max-width:100%"><p class="muted" style="margin:14px 0 0">On your phone: WhatsApp → Settings → <b>Linked devices</b> → <b>Link a device</b> → scan this code.<br>The code changes every ~20 seconds; this page refreshes itself.</p></div>`
    : s.status === 'connected'
      ? `<div class="card"><p style="margin:0 0 6px"><span class="tag">Linked</span></p><p style="margin:0">+${esc(s.me || '')} · ${s.chats} chats · ${s.unread} unread</p><p class="muted" style="margin:10px 0 0">Old chats keep syncing for a few minutes after linking.</p></div>`
      : `<div class="card"><p style="margin:0">${esc(PERSONAL_LABEL[s.status] || s.status)}${s.error ? ` · <span style="color:var(--red)">${esc(s.error)}</span>` : ''}</p></div>`;
  const refresh = ['qr', 'starting', 'reconnecting'].includes(s.status) && !s.pairCode ? '<meta http-equiv="refresh" content="5">' : '';
  return shell('Personal WhatsApp', `${refresh}<div class="top"><div class="brand">${mascot(30)} DIOMA</div><a href="/dashboard">Dashboard</a></div>
<p class="eyebrow">Personal WhatsApp</p><h1 style="font-size:clamp(34px,7vw,60px)">${esc(PERSONAL_LABEL[s.status] || s.status)}</h1>
<section style="display:flex;flex-direction:column;gap:14px;margin-top:20px;max-width:560px">
${body}
${s.status !== 'connected' ? `<form method="post" action="/personal/pair" class="card" style="display:flex;flex-direction:column;gap:10px"><label for="pp" class="tag">On your phone only? Link with a code</label><input id="pp" name="phone" inputmode="tel" value="971585155559" style="min-height:44px;border-radius:12px;border:1px solid var(--line);background:#111;color:#fff;padding:0 12px;font-size:16px"><button class="btn" type="submit">Get link code</button></form>` : ''}
<form method="post" action="/personal/start"><button class="btn" type="submit">${s.status === 'connected' ? 'Reconnect' : 'Show QR code'}</button></form>
${s.status === 'connected' ? '<form method="post" action="/personal/unlink"><button class="btn" style="background:#2A2A2A;color:#fff" type="submit">Unlink this device</button></form>' : ''}
<div class="card"><p class="tag" style="margin:0 0 6px">Connector for the Dioma app</p>${mcpUrl ? `<p style="margin:0;word-break:break-all"><code>${esc(mcpUrl)}</code></p><p class="muted" style="margin:8px 0 0">In claude.ai: Settings → Connectors → Add custom connector → name it <b>Dioma WhatsApp</b> and paste this URL. Keep it private.</p>` : '<p class="muted" style="margin:0">Set MCP_TOKEN (at least 24 characters) in Railway variables to get the link.</p>'}</div>
<p class="muted small">Unofficial link (WhatsApp Web protocol). WhatsApp may block numbers that use it.</p>
</section>`);
}
