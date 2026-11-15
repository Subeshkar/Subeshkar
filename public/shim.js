// Dioma runtime: gives the Dioma app what it needs (connected apps, the AI, saved state, downloads),
// all served by the Dioma backend at app.dioma.life.
(() => {
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dioma': '1' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = '/'; throw Object.assign(new Error('Please sign in.'), { code: 'not_granted' }); }
    if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { code: j.code || 'tool_error', retryable: r.status >= 500 || r.status === 429 });
    return j;
  };
  const mcp = {
    callTool: (server, tool, input) => post('/api/owner/mcp', { server, tool, input }),
    watchTool(server, tool, input, handler, opts = {}) {
      let stop = false;
      const run = () => mcp.callTool(server, tool, input).then((result) => !stop && handler({ type: 'data', result, cache: { storedAt: Date.now() } }), (error) => !stop && handler({ type: 'error', error }));
      run();
      const t = setInterval(run, Math.max(60e3, opts.refetchInterval || 300e3));
      return () => { stop = true; clearInterval(t); };
    },
    invalidate: async () => {},
    describeTool: async () => { throw Object.assign(new Error('Not available'), { code: 'tool_not_found' }); },
    listTools: async () => [],
  };

  const asTurns = (input) => (typeof input === 'string' ? [{ role: 'user', content: input }] : input.map((m) => ({ role: m.role, content: m.content })));
  async function sample(input, opts = {}) {
    const tools = (opts.tools || []).filter((t) => t && t.name);
    const defs = tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 1000), input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    const msgs = asTurns(input);
    for (let round = 0; round < 10; round++) {
      if (opts.signal?.aborted) throw Object.assign(new Error('Stopped.'), { code: 'cancelled' });
      const r = await post('/api/owner/sample', { messages: msgs, tools: defs, modelTier: opts.modelTier, system: opts.system });
      const content = r.content || [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const uses = content.filter((b) => b.type === 'tool_use');
      if (r.stop_reason !== 'tool_use' || !uses.length) { opts.onText?.({ text, delta: text }); return { text, truncated: r.stop_reason === 'max_tokens' }; }
      msgs.push({ role: 'assistant', content });
      const results = [];
      for (const u of uses) {
        const t = tools.find((x) => x.name === u.name);
        let out; try { out = t ? await t.execute(u.input || {}) : { error: 'Unknown tool' }; } catch (e) { out = { error: String(e?.message || e) }; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: (typeof out === 'string' ? out : JSON.stringify(out ?? null)).slice(0, 30000) });
      }
      msgs.push({ role: 'user', content: results });
    }
    return { text: 'Done.', truncated: true };
  }
  sample.json = async (input, opts = {}) => {
    const turns = asTurns(input);
    const last = turns[turns.length - 1];
    if (typeof last.content === 'string') last.content += '\n\nReply with valid JSON only, no other text.';
    const { text } = await sample(turns, { ...opts, tools: undefined });
    const m = text.match(/[[{][\s\S]*[\]}]/);
    try { return JSON.parse(m ? m[0] : text); } catch { throw Object.assign(new Error('The AI did not return JSON.'), { code: 'model_error', text }); }
  };
  sample.limits = async () => ({ images: false, tools: { maxCount: 64 } });

  const db = {
    doc(path) {
      return {
        get: async () => { const r = await fetch('/api/owner/db?path=' + encodeURIComponent(path)); const j = await r.json(); return { exists: j.data != null, data: () => j.data }; },
        set: (data, o = {}) => post('/api/owner/db', { path, data, merge: !!o.merge }),
        update: (data) => post('/api/owner/db', { path, data, merge: true }),
        onSnapshot: () => () => {},
      };
    },
  };
  const user = { id: async () => 'owner', me: async () => ({ id: 'owner' }), isOwner: () => true, canEdit: () => true, profiles: async () => ({}) };
  const downloads = {
    save: async ({ filename, data }) => { const blob = data instanceof Blob ? data : new Blob([data]); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'file'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30e3); },
  };
  const caps = { mcp, sample, db, user, downloads };
  window.claude = Object.freeze({ use: async (name) => caps[name] || null });
})();
