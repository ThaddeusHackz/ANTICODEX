import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { chat as chatApi, models as modelsApi, search as searchApi } from '../lib/api.js';
import { useApp, loadThreads, saveThreadLocal, deleteThreadLocal, syncThread } from '../lib/state.jsx';
import { renderMarkdown, splitCode } from '../lib/markdown.js';
import { Logo, CopyBtn, Pill } from '../ui.jsx';

function ModelPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  useEffect(() => { modelsApi().then((r) => setProviders(r.providers || [])).catch(() => {}); }, []);
  const flat = useMemo(() => (providers || []).flatMap((p) => (p.models || []).map((m) => ({ ...m, providerName: p.name, providerId: p.id }))), [providers]);
  const current = flat.find((m) => m.id === value) || { label: value };

  return (
    <div style={{ position: 'relative' }}>
      <button className="model-select" onClick={() => setOpen(!open)}>
        <span className="status-dot ok" /> {current.label || value} ▾
      </button>
      {open && (
        <div className="modal spark" style={{ position: 'absolute', bottom: 46, left: 0, width: 340, padding: 8, zIndex: 50 }}>
          {providers.map((p) => (
            <div key={p.id}>
              <div className="tiny" style={{ padding: '8px 10px 2px', fontWeight: 800, letterSpacing: 1 }}>
                {p.name} {!p.configured && p.id !== 'demo' && <span className="pill warn" style={{ marginLeft: 6 }}>needs key</span>}
              </div>
              {(p.models || []).map((m) => (
                <button key={m.id} className={`thread-item ${m.id === value ? 'active' : ''}`}
                  onClick={() => { onChange(m.id); setOpen(false); }}>
                  <span>{m.label}</span>
                  {m.vision && <span className="pill" style={{ marginLeft: 'auto' }}>vision</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ m, onRegen }) {
  const isUser = m.role === 'user';
  return (
    <div className="msg-row spark">
      <div className={`avatar ${isUser ? 'user' : 'ai'}`}>{isUser ? 'You' : <Logo size={20} />}</div>
      <div className="msg-body">
        <div className="msg-name">{isUser ? 'You' : m.model || 'ANTICODEX'}</div>
        <div className="msg-text">
          {isUser ? <p style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p> : (
            splitCode(m.content).map((part, i) => part.type === 'code' ? (
              <div key={i} style={{ position: 'relative', margin: '10px 0' }}>
                <div className="row between" style={{ position: 'absolute', top: 6, right: 8, zIndex: 2 }}>
                  <span className="tiny" style={{ marginRight: 8 }}>{part.lang}</span>
                  <CopyBtn text={part.value} label="⧉" />
                </div>
                <pre><code>{part.value}</code></pre>
              </div>
            ) : <span key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(part.value) }} />
            )
          )}
          {m.streaming && <span className="typing" />}
        </div>
        {m.images?.map((img, i) => (
          <img key={i} src={img} alt="attachment" style={{ maxWidth: 260, borderRadius: 12, marginTop: 8, border: '1px solid var(--border)' }} />
        ))}
        {m.sources?.length > 0 && (
          <div className="sources">
            {m.sources.map((s, i) => (
              <a key={i} className="source-chip" href={s.url} target="_blank" rel="noreferrer">⌕ {s.title || s.url}</a>
            ))}
          </div>
        )}
        <div className="msg-actions">
          <CopyBtn text={m.content} label="Copy" />
          {!isUser && onRegen && <button className="btn small ghost" onClick={onRegen}>↻ Regenerate</button>}
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { model, setModel, notify, user } = useApp();
  const [params] = useSearchParams();
  const [threadId, setThreadId] = useState(() => params.get('t') || `thr_${Date.now().toString(36)}`);
  const [title, setTitle] = useState('New chat');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [webOn, setWebOn] = useState(false);
  const [images, setImages] = useState([]);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const t = loadThreads().find((x) => x.id === params.get('t'));
    if (t) { setThreadId(t.id); setMessages(t.messages || []); setTitle(t.title || 'Untitled'); }
  }, [params]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  function persist(msgs, newTitle) {
    const t = {
      id: threadId, title: newTitle || title, model,
      messages: msgs, user_id: user?.id, updated_at: new Date().toISOString()
    };
    saveThreadLocal(t);
    syncThread(t);
    if (newTitle) setTitle(newTitle);
  }

  async function send(text = input, opts = {}) {
    const content = (text || '').trim();
    if (!content && !images.length) return;
    if (busy) return;
    setBusy(true);
    setInput('');

    const userMsg = { role: 'user', content, images: images.length ? [...images] : undefined };
    const next = [...messages, userMsg, { role: 'assistant', content: '', streaming: true, model }];
    setMessages(next);
    setImages([]);

    const newTitle = messages.length === 0 ? content.slice(0, 48) : title;
    persist(next.filter((m) => !m.streaming), newTitle);

    try {
      let sources;
      let enriched = content;
      if (webOn) {
        const s = await searchApi({ query: content });
        if (s?.results?.length) {
          sources = s.results;
          enriched = `${content}\n\n[web results]\n${s.results.map((r) => `- ${r.title}: ${r.snippet}`).join('\n')}`;
        }
      }
      const history = [...messages, { ...userMsg, content: enriched }].filter((m) => !m.streaming);
      const r = await chatApi({ messages: history, model });

      // Simulated token stream for a fluid UX regardless of provider transport.
      const full = r.text || '(empty response)';
      let shown = '';
      const words = full.split(/(\s+)/);
      for (let i = 0; i < words.length; i++) {
        shown += words[i];
        setMessages((ms) => ms.map((m, idx) => idx === ms.length - 1 ? { ...m, content: shown, streaming: i < words.length - 1, model: r.model } : m));
        if (i % 3 === 0) await new Promise((x) => setTimeout(x, 12));
      }
      const done = [...next.slice(0, -1), { role: 'assistant', content: full, model: r.model, sources }];
      setMessages(done);
      persist(done, newTitle);
    } catch (e) {
      const fail = [...next.slice(0, -1), { role: 'assistant', content: `⚠ **Request failed:** ${e.message}\n\nCheck **Settings → Providers** (NVIDIA NIM or any custom endpoint) or try the built-in Demo Core model.`, model }];
      setMessages(fail);
      persist(fail, newTitle);
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function attach(files) {
    const list = [...files].slice(0, 4);
    for (const f of list) {
      const reader = new FileReader();
      reader.onload = () => setImages((im) => [...im, reader.result]);
      reader.readAsDataURL(f);
    }
  }

  function regen() {
    const trimmed = [...messages];
    while (trimmed.length && trimmed[trimmed.length - 1].role === 'assistant') trimmed.pop();
    setMessages(trimmed);
    setTimeout(() => send(trimmed[trimmed.length - 1]?.content || ''), 50);
  }

  return (
    <div className="chat-wrap">
      <div className="messages" style={{ padding: '26px 22px 12px', maxWidth: 860, margin: '0 auto', width: '100%' }}>
        {messages.length === 0 ? (
          <div className="hero">
            <div className="logo-big"><Logo size={84} /></div>
            <h1>What shall we build?</h1>
            <p>One workspace for every model: NVIDIA NIM, custom API endpoints, web search, Flux images, Hailuo video, MCP connectors and computer-use.</p>
            <div className="suggest-grid">
              {[
                ['⚡ Connect an AI', 'Add your NVIDIA API key in Settings and test models instantly'],
                ['⌘ Open Codex Workspace', 'File tree, diff proposals, sandbox terminal, approval modes'],
                ['⇄ Browse MCP connectors', 'GitHub, Drive, Slack, Notion, Postgres, Playwright and more'],
                ['▦ Generate with Flux', 'Cloudflare Workers AI image generation, then Hailuo video']
              ].map(([t, d]) => (
                <button key={t} className="suggest-card" onClick={() => {
                  if (t.includes('Connect')) window.location.hash = '#/settings';
                  else if (t.includes('Codex')) window.location.href = '/codex';
                  else if (t.includes('MCP')) window.location.href = '/mcp';
                  else window.location.href = '/images';
                }}>
                  <div className="t">{t}</div><div className="d">{d}</div>
                </button>
              ))}
            </div>
          </div>
        ) : messages.map((m, i) => (
          <Message key={i} m={m} onRegen={i === messages.length - 1 && !busy ? regen : undefined} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="composer-wrap" style={{ maxWidth: 860, margin: '0 auto', width: '100%', padding: '0 22px 22px' }}>
        <div className="composer">
          <textarea
            value={input}
            placeholder="Message ANTICODEX… (Shift+Enter for newline)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          {images.length > 0 && (
            <div className="row" style={{ padding: '6px 4px' }}>
              {images.map((img, i) => (
                <img key={i} src={img} alt="" style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
              ))}
            </div>
          )}
          <div className="composer-bar">
            <button className={`chip-toggle ${webOn ? 'on' : ''}`} onClick={() => setWebOn(!webOn)}>⌕ Web</button>
            <button className="chip-toggle" onClick={() => fileRef.current?.click()}>⊕ Vision</button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => attach(e.target.files)} />
            <ModelPicker value={model} onChange={setModel} />
            <div style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || (!input.trim() && !images.length)} onClick={() => send()}>
              {busy ? 'Thinking…' : 'Send'} ↑
            </button>
          </div>
        </div>
        <div className="tiny" style={{ textAlign: 'center', marginTop: 8 }}>
          ANTICODEX can make mistakes. Web search uses Tavily/Exa when configured · vision requires a vision-capable model
        </div>
      </div>
    </div>
  );
}
