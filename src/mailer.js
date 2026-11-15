// Sign-in codes by email through Resend (RESEND_API_KEY, MAIL_FROM). Without a key (local tests) the code is only logged.
export async function sendCode(email, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Dioma <noreply@dioma.life>';
  const subject = `${code} is your Dioma code`;
  const text = `Your Dioma sign-in code is ${code}\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this email.\n\nDioma · dioma.life`;
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#111">
  <div style="font-size:13px;letter-spacing:.3em;color:#666">DIOMA</div>
  <p style="font-size:15px;margin:24px 0 8px">Your sign-in code</p>
  <div style="font-family:'IBM Plex Mono',monospace;font-size:34px;letter-spacing:.25em;font-weight:500">${code}</div>
  <p style="font-size:13px;color:#666;margin-top:24px">It works for 10 minutes. If you did not ask for it, you can ignore this email.</p></div>`;
  if (!key) { console.log(`[dev] sign-in code for ${email}: ${code}`); return { dev: true }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject, text, html }),
  });
  if (!r.ok) throw new Error(`mail ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { sent: true };
}
