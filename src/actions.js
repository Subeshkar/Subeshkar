import crypto from 'node:crypto';
import { db, getUser, getPerm, setPerm, logActivity } from './db.js';
import { sendEmail, createEvent } from './google.js';
import { sendText, sendButtons } from './whatsapp.js';

export function createAction(phone, app, type, payload, summary) {
  const id = crypto.randomBytes(5).toString('hex');
  db.prepare(`INSERT INTO actions (id, phone, app, type, payload, summary, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, phone, app, type, JSON.stringify(payload), summary, Date.now());
  return id;
}

export function getAction(id) {
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
}

export function pendingActions(phone) {
  return phone
    ? db.prepare(`SELECT * FROM actions WHERE phone = ? AND status = 'pending' ORDER BY created_at DESC`).all(phone)
    : db.prepare(`SELECT * FROM actions WHERE status = 'pending' ORDER BY created_at DESC`).all();
}

export async function execute(action) {
  const user = getUser(action.phone);
  const p = JSON.parse(action.payload);
  if (action.type === 'send_email') {
    await sendEmail(user, p);
    return `Email sent to ${p.to}.`;
  }
  if (action.type === 'calendar_event') {
    const link = await createEvent(user, p);
    return `"${p.title}" is on your calendar.${link ? ' ' + link : ''}`;
  }
  throw new Error('Unknown action type');
}

// Called by the agent when it wants to do something that leaves Dioma.
// Respects the user's permission: off / always / ask.
export async function propose(phone, app, type, payload, summary) {
  const mode = getPerm(phone, app);
  if (mode === 'off') {
    logActivity(phone, summary, 'OFF');
    return { status: 'blocked', message: `${app} is turned off in the user's permissions. Nothing was done.` };
  }
  const id = createAction(phone, app, type, payload, summary);
  if (mode === 'always') {
    const a = getAction(id);
    try {
      const result = await execute(a);
      db.prepare(`UPDATE actions SET status = 'done', result = ?, decided_at = ? WHERE id = ?`).run(result, Date.now(), id);
      logActivity(phone, summary, 'AUTO');
      return { status: 'done_automatically', message: result };
    } catch (e) {
      db.prepare(`UPDATE actions SET status = 'failed', result = ? WHERE id = ?`).run(String(e.message), id);
      return { status: 'failed', message: String(e.message) };
    }
  }
  return { status: 'awaiting_approval', action_id: id, message: 'The user will get Approve / Cancel buttons on WhatsApp. Tell them it is ready for their approval.' };
}

export async function askForApproval(action) {
  const body = `Dioma needs your OK · ${action.app}\n\n${action.summary}`;
  await sendButtons(action.phone, body, [
    { id: `approve:${action.id}`, title: 'Approve' },
    { id: `cancel:${action.id}`, title: 'Cancel' },
    { id: `always:${action.id}`, title: `Always allow ${action.app}`.slice(0, 20) }
  ]);
}

export async function decide(id, decision, notify = true) {
  const a = getAction(id);
  if (!a) return 'That request no longer exists.';
  if (a.status !== 'pending') return `Already ${a.status}.`;
  if (decision === 'cancel') {
    db.prepare(`UPDATE actions SET status = 'cancelled', decided_at = ? WHERE id = ?`).run(Date.now(), id);
    logActivity(a.phone, a.summary, 'DENIED');
    if (notify) await sendText(a.phone, 'Cancelled. Nothing was sent.');
    return 'Cancelled';
  }
  if (decision === 'always') setPerm(a.phone, a.app, 'always');
  try {
    const result = await execute(a);
    db.prepare(`UPDATE actions SET status = 'done', result = ?, decided_at = ? WHERE id = ?`).run(result, Date.now(), id);
    logActivity(a.phone, a.summary, 'ALLOWED');
    if (notify) await sendText(a.phone, `Done. ${result}${decision === 'always' ? `\n\n${a.app} is now set to "Always allow". Change it any time by telling me.` : ''}`);
    return result;
  } catch (e) {
    db.prepare(`UPDATE actions SET status = 'failed', result = ? WHERE id = ?`).run(String(e.message), id);
    logActivity(a.phone, a.summary, 'FAILED');
    const msg = String(e.message).includes('GOOGLE_NOT_CONNECTED') ? 'Your Google account is not connected yet. Say "connect Google" and I will send a link.' : `That didn't work: ${e.message}`;
    if (notify) await sendText(a.phone, msg);
    return msg;
  }
}
