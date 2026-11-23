// One event contract for browser and Electron. Keys remain in the main process.
export async function streamV3(action, payload, { signal, onEvent } = {}) {
  if (!['teams', 'sites'].includes(action)) throw new Error('Unknown v3 action.');
  if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
  let terminal;
  const event = (e) => {
    if (signal?.aborted) return;
    if (['done', 'error', 'aborted'].includes(e.type)) terminal = e;
    onEvent?.(e);
  };
  const body = { ...payload, token: localStorage.getItem('acx_token') || undefined };
  const native = globalThis.window?.anticodexDesktop;
  if (native?.streamApi) {
    const id = `v3_${crypto.randomUUID()}`;
    const stop = () => native.abortStream?.(id);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const out = await native.streamApi(action, body, event, id);
      if (out?.aborted || signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
      if (!terminal && out?.error) throw new Error(out.error);
    } finally { signal?.removeEventListener('abort', stop); }
  } else {
    try {
      const defs = JSON.parse(localStorage.getItem('acx_custom_providers') || '[]');
      if (Array.isArray(defs)) body.provider_defs = defs.map(({ id, name, type, endpoint, key_env, default_model }) => ({ id, name, type, endpoint, key_env, default_model }));
    } catch { /* malformed device settings are not credentials */ }
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (body.token) headers.Authorization = `Bearer ${body.token}`;
    const response = await fetch('/api/bridge', { method: 'POST', headers, body: JSON.stringify({ ...body, action }), signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const out = await response.json().catch(() => ({})); throw new Error(out.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    const parse = (block) => {
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (data) event(JSON.parse(data));
    };
    try {
      for (;;) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done }).replace(/\r/g, '');
        let end; while ((end = buffer.indexOf('\n\n')) !== -1) { parse(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
        if (next.done) { if (buffer.trim()) parse(buffer); break; }
      }
    } finally { try { await reader.cancel(); } catch { /* closed */ } reader.releaseLock(); }
  }
  if (signal?.aborted || terminal?.type === 'aborted') throw new DOMException('Stopped.', 'AbortError');
  if (!terminal) throw new Error('The connection ended before completion. Retry; no completion was confirmed.');
  if (terminal.type === 'error' || terminal.ok === false) throw new Error(terminal.error || 'The run did not complete.');
  return terminal;
}
