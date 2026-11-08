import crypto from 'node:crypto';
import { logActivity } from './db.js';

const version = () => process.env.WA_API_VERSION || 'v23.0';
const endpoint = () => `https://graph.facebook.com/${version()}/${process.env.WA_PHONE_NUMBER_ID}/messages`;

async function call(body) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('WhatsApp API error', res.status, t);
    throw new Error(`WhatsApp API ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

export async function sendText(to, text) {
  const chunks = [];
  let s = String(text || '').trim() || '…';
  while (s.length > 3800) { chunks.push(s.slice(0, 3800)); s = s.slice(3800); }
  chunks.push(s);
  for (const c of chunks) await call({ to, type: 'text', text: { body: c, preview_url: false } });
}

// Up to 3 buttons; titles max 20 characters, body max 1024.
export async function sendButtons(to, body, buttons) {
  await call({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } }))
      }
    }
  });
}

export async function sendTemplate(to, text) {
  const clean = String(text).replace(/[\n\t]+/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 1000);
  await call({
    to,
    type: 'template',
    template: {
      name: process.env.WA_TEMPLATE_NAME,
      language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: clean }] }]
    }
  });
}

export async function markRead(messageId) {
  try { await call({ status: 'read', message_id: messageId }); } catch { /* not critical */ }
}

// WhatsApp only allows free-form messages within 24 hours of the user's last message.
export function inWindow(user) {
  return user.last_inbound && Date.now() - user.last_inbound < 23.5 * 3600 * 1000;
}

// For messages Dioma starts itself (morning brief, reminders).
export async function sendProactive(user, text) {
  if (inWindow(user)) return sendText(user.phone, text);
  if (process.env.WA_TEMPLATE_NAME) return sendTemplate(user.phone, text);
  logActivity(user.phone, 'Proactive message not sent: user has not messaged in 24h and no template is set', 'SKIPPED');
}

export function verifySignature(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}
