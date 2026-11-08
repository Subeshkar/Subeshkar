import Anthropic from '@anthropic-ai/sdk';
import { db, getUser, updateUser, history, saveMessage, getPerm, setPerm, APPS } from './db.js';
import { listEmails, readEmail, listEvents, connectLink, isConnected } from './google.js';
import { propose, getAction, askForApproval } from './actions.js';

const anthropic = new Anthropic();
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

export function localNow(tz) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return fmt.format(d);
}

// Convert a local wall-clock ISO string (no offset) in tz to a UTC timestamp.
export function localToUtc(iso, tz) {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) return new Date(iso).getTime();
  const guess = new Date(iso + 'Z').getTime();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(guess)).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (asLocal - guess);
}

const tools = [
  { name: 'get_calendar', description: "Read the user's Google Calendar events.", input_schema: { type: 'object', properties: { days_ahead: { type: 'integer', description: 'How many days from now (default 1)' }, from_date: { type: 'string', description: 'Optional start, local ISO date like 2026-11-10' } } } },
  { name: 'list_emails', description: 'List emails from Gmail. Default: unread inbox.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Gmail search, e.g. "in:inbox is:unread", "from:sara", "newer_than:2d"' }, max: { type: 'integer' } } } },
  { name: 'read_email', description: 'Read one email in full by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'propose_send_email', description: 'Prepare an email to send from the user\'s Gmail. The user approves on WhatsApp before it is sent (unless they set Email to always).', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, reply_to_id: { type: 'string', description: 'Gmail message id when replying' } }, required: ['to', 'subject', 'body'] } },
  { name: 'propose_calendar_event', description: 'Prepare a Google Calendar event. User approves first (unless Calendar is set to always). Times are local wall-clock ISO without offset, e.g. 2026-11-10T18:00:00.', input_schema: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } }, required: ['title', 'start', 'end'] } },
  { name: 'set_reminder', description: 'Send the user a WhatsApp reminder at a time. Local wall-clock ISO without offset.', input_schema: { type: 'object', properties: { text: { type: 'string' }, at: { type: 'string' } }, required: ['text', 'at'] } },
  { name: 'add_task', description: 'Add a to-do.', input_schema: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' } }, required: ['title'] } },
  { name: 'list_tasks', description: 'List open to-dos with ids.', input_schema: { type: 'object', properties: {} } },
  { name: 'complete_task', description: 'Mark a to-do done.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'save_note', description: 'Remember something the user tells you (preferences, goals, facts).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'get_notes', description: 'Read saved notes about the user.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_google_connect_link', description: 'Get a secure link for the user to connect Gmail and Google Calendar.', input_schema: { type: 'object', properties: {} } },
  { name: 'set_permission', description: 'Change how Dioma uses an app: ask (approve each time), always, or off.', input_schema: { type: 'object', properties: { app: { type: 'string', enum: APPS }, mode: { type: 'string', enum: ['ask', 'always', 'off'] } }, required: ['app', 'mode'] } },
  { name: 'update_profile', description: 'Set the user\'s name, time zone (IANA) or morning brief time (HH:MM, or "off").', input_schema: { type: 'object', properties: { name: { type: 'string' }, timezone: { type: 'string' }, brief_time: { type: 'string' } } } }
];

function systemPrompt(user, notes) {
  const perms = APPS.map((a) => `${a}: ${getPerm(user.phone, a)}`).join(', ');
  return `You are Dioma, a personal AI assistant that lives in WhatsApp, for students and young professionals in the UAE.
You turn what the user wants into done tasks. Plan the steps yourself and use tools to act.

Now: ${localNow(user.timezone)} (${user.timezone}).
User: ${user.name || 'unknown name'} · WhatsApp ${user.phone}.
Google connected: ${isConnected(user) ? `yes (${user.google_email || 'account'})` : 'no'}.
Permissions: ${perms}. "ask" = the user gets Approve/Cancel buttons; "always" = it runs immediately; "off" = never.
Saved notes about the user: ${notes || 'none yet'}.

Rules:
- Anything that leaves Dioma (sending an email, creating a calendar event) goes through a propose_ tool. Never claim it was sent until a tool says done. When a tool returns awaiting_approval, say it is ready and that they can tap Approve.
- Never send anything to anyone without going through those tools. You never message the user's contacts on WhatsApp.
- If Gmail or Calendar is needed and Google is not connected, call get_google_connect_link and send the link.
- Read before you write: check the calendar before proposing a time; read the email before drafting a reply.
- Times you pass to tools are local wall-clock ISO without offset.
- WhatsApp style: short, warm, clear. Use *bold* sparingly, short lists with "•". No long essays. Match the user's language.
- When you finish a multi-step task, add one short line "Tip:" teaching how they could ask even better next time. Do this at most once per conversation turn and only after real tasks.
- Money: education and budgeting help only, no investment advice. Health: scheduling only, no diagnosis.
- If the user just says hi, introduce yourself in 3 lines and suggest 3 things you can do.`;
}

async function runTool(user, name, input, created) {
  const phone = user.phone;
  try {
    switch (name) {
      case 'get_calendar':
        return await listEvents(user, { daysAhead: input.days_ahead || 1, fromIso: input.from_date ? new Date(localToUtc(input.from_date + (input.from_date.length === 10 ? 'T00:00:00' : ''), user.timezone)).toISOString() : undefined });
      case 'list_emails':
        return await listEmails(user, { query: input.query || 'in:inbox is:unread', max: input.max || 8 });
      case 'read_email':
        return await readEmail(user, input.id);
      case 'propose_send_email': {
        const summary = `Send email to ${input.to}\nSubject: ${input.subject}\n\n${input.body}`.slice(0, 900);
        const r = await propose(phone, 'Email', 'send_email', { to: input.to, subject: input.subject, body: input.body, replyToId: input.reply_to_id }, summary);
        if (r.action_id) created.push(r.action_id);
        return r;
      }
      case 'propose_calendar_event': {
        const summary = `Add to your calendar\n${input.title}\n${input.start.replace('T', ' ').slice(0, 16)} → ${input.end.replace('T', ' ').slice(11, 16)}${input.location ? `\n${input.location}` : ''}`;
        const r = await propose(phone, 'Calendar', 'calendar_event', input, summary);
        if (r.action_id) created.push(r.action_id);
        return r;
      }
      case 'set_reminder': {
        const due = localToUtc(input.at, user.timezone);
        if (!(due > Date.now())) return { error: 'That time is in the past.' };
        db.prepare('INSERT INTO reminders (phone, text, due_at) VALUES (?, ?, ?)').run(phone, input.text, due);
        return { ok: true, at_local: input.at };
      }
      case 'add_task': {
        const r = db.prepare('INSERT INTO tasks (phone, title, due, created_at) VALUES (?, ?, ?, ?)').run(phone, input.title, input.due || null, Date.now());
        return { ok: true, id: r.lastInsertRowid };
      }
      case 'list_tasks':
        return db.prepare('SELECT id, title, due FROM tasks WHERE phone = ? AND done = 0 ORDER BY id').all(phone);
      case 'complete_task':
        db.prepare('UPDATE tasks SET done = 1 WHERE id = ? AND phone = ?').run(input.id, phone);
        return { ok: true };
      case 'save_note':
        db.prepare('INSERT INTO notes (phone, text, created_at) VALUES (?, ?, ?)').run(phone, input.text, Date.now());
        return { ok: true };
      case 'get_notes':
        return db.prepare('SELECT text FROM notes WHERE phone = ? ORDER BY id DESC LIMIT 30').all(phone).map((n) => n.text);
      case 'get_google_connect_link':
        return { link: connectLink(phone), note: 'Link works for 30 minutes.' };
      case 'set_permission':
        setPerm(phone, input.app, input.mode);
        return { ok: true };
      case 'update_profile': {
        const f = {};
        if (input.name) f.name = input.name;
        if (input.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); f.timezone = input.timezone; } catch { return { error: 'Unknown time zone' }; } }
        if (input.brief_time) f.brief_time = input.brief_time;
        updateUser(phone, f);
        return { ok: true };
      }
      default:
        return { error: 'Unknown tool' };
    }
  } catch (e) {
    if (String(e.message).includes('GOOGLE_NOT_CONNECTED')) return { error: 'Google is not connected. Call get_google_connect_link.' };
    console.error('Tool error', name, e);
    return { error: String(e.message).slice(0, 300) };
  }
}

// Handle one user message end to end. Returns { reply, actionIds }.
export async function handleMessage(phone, text) {
  let user = getUser(phone);
  const notes = db.prepare('SELECT text FROM notes WHERE phone = ? ORDER BY id DESC LIMIT 15').all(phone).map((n) => n.text).join(' | ');
  const messages = history(phone).map((m) => ({ role: m.role, content: m.content }));
  // The API needs alternating turns starting with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const merged = [];
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += '\n' + m.content;
    else merged.push({ ...m });
  }
  if (merged.length && merged[merged.length - 1].role === 'user') merged[merged.length - 1].content += '\n' + text;
  else merged.push({ role: 'user', content: text });
  saveMessage(phone, 'user', text);

  const created = [];
  let reply = '';
  for (let i = 0; i < 8; i++) {
    user = getUser(phone);
    const res = await anthropic.messages.create({ model: MODEL(), max_tokens: 1500, system: systemPrompt(user, notes), tools, messages: merged });
    merged.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (res.stop_reason !== 'tool_use' || !uses.length) break;
    const results = [];
    for (const u of uses) {
      const out = await runTool(user, u.name, u.input || {}, created);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    merged.push({ role: 'user', content: results });
  }
  if (!reply) reply = created.length ? 'Ready for your approval:' : 'Done.';
  saveMessage(phone, 'assistant', reply);
  return { reply, actionIds: created };
}

export async function sendApprovals(actionIds) {
  for (const id of actionIds) {
    const a = getAction(id);
    if (a && a.status === 'pending') await askForApproval(a);
  }
}

// One short morning brief written by Claude from real data.
export async function writeBrief(user) {
  const data = { now: localNow(user.timezone), name: user.name };
  if (isConnected(user)) {
    try { data.events_today = await listEvents(user, { daysAhead: 1 }); } catch (e) { data.calendar_error = e.message; }
    try { data.unread_emails = (await listEmails(user, { max: 6 })).map((m) => ({ from: m.from, subject: m.subject })); } catch (e) { data.email_error = e.message; }
  }
  data.open_tasks = db.prepare('SELECT title, due FROM tasks WHERE phone = ? AND done = 0 ORDER BY id LIMIT 8').all(user.phone);
  const res = await anthropic.messages.create({
    model: MODEL(), max_tokens: 500,
    system: 'You are Dioma. Write a WhatsApp morning brief: a greeting line, today\'s schedule, emails that need attention, open tasks, and one focus for the day. Under 120 words, "•" bullets, *bold* headings. If Google is not connected, suggest saying "connect Google".',
    messages: [{ role: 'user', content: JSON.stringify(data) }]
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
