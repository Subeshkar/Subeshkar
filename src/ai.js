// The AI behind Dioma: Claude via the Anthropic Messages API (ANTHROPIC_API_KEY). Customers only see "Dioma".
// Without a key (local tests) a simple stand-in answers, so every screen can be tried end to end.
const MODEL = () => process.env.DIOMA_MODEL || 'claude-sonnet-5-5';

export async function claude({ system, messages, tools, max_tokens = 1200, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return mock(messages, tools);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || MODEL(), max_tokens, system, messages, ...(tools ? { tools } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  // A writing model that is not available falls back to the normal one.
  if (!r.ok && model && model !== MODEL() && (r.status === 404 || r.status === 400 || r.status === 403)) return claude({ system, messages, tools, max_tokens });
  if (!r.ok) { const e = new Error(j?.error?.message || `AI ${r.status}`); e.status = r.status; throw e; }
  return j; // { content: [...], stop_reason, usage }
}

// Runs a short tool loop. `handlers` maps tool name -> async (input) => result.
// The best writer for messages people will read (WhatsApp, email, posts).
export const WRITER = () => process.env.DIOMA_WRITE_MODEL || 'claude-opus-5-5';

export async function converse({ system, messages, tools, handlers, maxTurns = 8 }) {
  const msgs = [...messages];
  const actions = [];
  for (let i = 0; i < maxTurns; i++) {
    const res = await claude({ system, messages: msgs, tools });
    msgs.push({ role: 'assistant', content: res.content });
    const uses = (res.content || []).filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) return { text, actions };
      break; // no words: ask for the answer below
    }
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await (handlers[u.name] || (() => ({ error: 'unknown tool' })))(u.input || {}); }
      catch (e) { out = { error: String(e.message || e) }; }
      actions.push({ tool: u.name, input: u.input, result: out });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) });
    }
    msgs.push({ role: 'user', content: results });
  }
  // Never answer with an empty "Done.": one last turn, no tools, to give the real answer from what was found.
  try {
    const last = msgs[msgs.length - 1];
    const tail = last && last.role === 'assistant' ? [...msgs, { role: 'user', content: 'Now answer my question directly and clearly from what you found.' }] : msgs;
    const fin = await claude({ system, messages: tail.map((m) => (Array.isArray(m.content) ? { role: m.role, content: m.content.map((b) => (b.type === 'tool_use' ? { type: 'text', text: `[used ${b.name}]` } : b.type === 'tool_result' ? { type: 'text', text: 'Result: ' + String(b.content).slice(0, 5000) } : b)) } : m)) });
    const text = (fin.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return { text, actions };
  } catch {}
  return { text: actions.length ? 'I checked, but could not put an answer together. Please ask again in a moment.' : 'Sorry, I could not answer that. Please try again.', actions };
}

// ---- local stand-in (no key) ----
let mockId = 0;
function mock(messages, tools) {
  const last = messages[messages.length - 1];
  if (Array.isArray(last?.content) && last.content[0]?.type === 'tool_result') {
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, I added that to your to-do list.' }] };
  }
  const q = typeof last?.content === 'string' ? last.content : '';
  const m = q.match(/^(?:remind me to|add(?: a)? (?:to-?do|task)[: ]+)\s*(.+)$/i);
  if (m && tools?.some((t) => t.name === 'add_todo')) {
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `mock_${++mockId}`, name: 'add_todo', input: { text: m[1] } }] };
  }
  if (/^BRIEF/.test(q)) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Good morning. (Test mode, the real brief is written by the AI once the key is added.)' }] };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: `Test mode: the AI isn't switched on yet, so this is a stand-in reply to “${q.slice(0, 120)}”.` }] };
}
