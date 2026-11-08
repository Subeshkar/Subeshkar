import cron from 'node-cron';
import { db, allUsers, updateUser, logActivity } from './db.js';
import { sendProactive } from './whatsapp.js';
import { writeBrief } from './agent.js';

function localParts(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function dueReminders() {
  const due = db.prepare('SELECT * FROM reminders WHERE sent = 0 AND due_at <= ?').all(Date.now());
  for (const r of due) {
    db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(r.id);
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(r.phone);
    if (!user) continue;
    try {
      await sendProactive(user, `*Reminder*\n${r.text}`);
      logActivity(r.phone, `Reminder: ${r.text}`, 'SENT');
    } catch (e) { console.error('Reminder failed', e.message); }
  }
}

async function morningBriefs() {
  for (const user of allUsers()) {
    if (!user.brief_time || user.brief_time === 'off') continue;
    const { date, time } = localParts(user.timezone || 'Asia/Dubai');
    if (time !== user.brief_time || user.last_brief_date === date) continue;
    updateUser(user.phone, { last_brief_date: date });
    try {
      const text = await writeBrief(user);
      await sendProactive(user, text);
      logActivity(user.phone, 'Morning brief', 'SENT');
    } catch (e) { console.error('Brief failed', e.message); }
  }
}

export function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try { await dueReminders(); } catch (e) { console.error(e); }
    try { await morningBriefs(); } catch (e) { console.error(e); }
  });
}

export { morningBriefs };
