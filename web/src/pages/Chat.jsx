import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';

const SUGGESTIONS = [
  { icon: '⌘', title: 'Write code with Codex', text: 'Build me a REST API scaffold with auth and tests', to: '/codex' },
  { icon: '✦', title: 'Search the web', text: 'Search: what changed in AI this week?' , tool: 'search' },
  { icon: '▦', title: 'Generate an image', text: 'Imagine a clean geometric logo in cyan and violet', to: '/images' },
  { icon: '▶', title: 'Generate a video', text: 'A short product teaser video with smooth camera motion', to: '/video' }
];

function ToolChips({ active, setActive }) {
  const chips = [
    { id: 'search', label: '⌕ Search' },
    { id: 'imagine', label: '✦ Imagine' },
    { id: 'video', label: '▶ Video' },
    { id: 'research', label: '∞ Deep research' },
    { id: 'mcp', label: '⇄ MCP tools' }
  ];
  return (
    <>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`chip-toggle ${active[c.id] ? 'on' : ''}`}
          onClick={() => setActive((a) => ({ ...a, [c.id]: !a[c.id] }))}
        >
          {c.label}
        </button>
      ))}
    </>
  );
}

function MessageActions({ text, onRegen }) {
  const { notify } = useApp();
  return (
    <div className="msg-actions">
      <button className="icon-btn" title="Copy" onClick={() => {
        navigator.clipboard?.writeText(text || '');
        notify('Copied to clipboard');
      }}>⧉</button>
      <button className="icon-btn" title="Good response">👍</button>
      <button className="icon-btn" title="Bad response">👎</button>
      {onRegen && <button className="icon-btn" title="Regenerate" onClick={onRegen}>↻</button>}
    </div>
  );
}

export default function ChatPage() {
  const { model, setModel, user, notify, cfg } = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState({ search: false, imagine: false, video: false, research: false, mcp: true });
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(() => new URLSearchParams(window.location.search).get('thread') || `th_${Date.now()}`);
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('thread');
    if (t) {
      api.threads.list().then((r) => {
        const th = (r.threads || []).find((x) => x.id === t);
        if (th?.messages?.length) { setMessages(th.messages); setThreadId(th.id); }
      }).catch(() => {});
    }
  }, [window.location.search]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const persist = async (next) => {
    try {
      await api.threads.save({
        id: threadId,
        title: (next.find((m) => m.role === 'user')?.content || 'New chat').slice(0, 60),
        messages: next, model
      });
    } catch { /* offline ok */ }
  };

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    // Mode shortcuts — chips route into dedicated generators like ChatGPT's
    // tool menu does for canvas/images.
    if (active.imagine && text === undefined) {
      window.location.href = `/images?q=${encodeURIComponent(content)}`;
      return;
    }
    if (active.video && text === undefined) {
      window.location.href = `/video?q=${encodeURIComponent(content)}`;
      return;
    }

    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setBusy(true);
    try {
      let system = active.research
        ? 'You are ANTICODEX in Deep Research mode. Plan, use the search tool when available, and produce a structured, cited report.'
        : undefined;
      if (active.search) system = ((system ? system + '\n' : '') + 'Use web search results when the search tool is available; cite sources as [n].');
      const out = await api.chat({
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        model: model.includes('::') ? model.split('::')[1] : model,
        provider: model.includes('::') ? model.split('::')[0] : undefined,
        system,
        use_mcp: active.mcp !== false
      });
      const reply = {
        role: 'assistant',
        content: out.text || out.content || '(no response)',
        tool_calls: out.tool_calls,
        model: out.model
      };
      const merged = [...next, reply];
      setMessages(merged);
      persist(merged);
    } catch (e) {
      const merged = [...next, { role: 'assistant', content: `⚠ ${e.message || e}` }];
      setMessages(merged);
    } finally {
      setBusy(false);
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="chat-wrap" ref={scrollRef} style={{ display: 'flex', flexDirection: 'column' }}>
      <div className={empty ? 'composer-wrap floating' : 'chat-col'} style={empty ? { width: '100%' } : {}}>
        {empty && (
          <div className="hero">
            <h1>What can I do for you?</h1>
            <div className="sub">ANTICODEX · Chat, Codex, Agents, Connectors — powered by your models</div>
          </div>
        )}
        {!empty && (
          <>
            {messages.map((m, i) => (
              <div key={i} className={`msg-row ${m.role}`}>
                {m.role === 'assistant' && <div className="msg-name">ANTICODEX</div>}
                {m.role === 'user' ? (
                  <div className="msg-user-pill">{m.content}</div>
                ) : (
                  <>
                    <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                    {m.tool_calls?.map((tc, j) => (
                      <div key={j} className="tool-card">
                        <div className="tool-name">⇄ {tc.function?.name || 'tool'}</div>
                        <div className="tiny">{(tc.function?.arguments || '').slice(0, 240)}</div>
                      </div>
                    ))}
                    <MessageActions text={m.content} onRegen={i === messages.length - 1 ? () => send() : undefined} />
                  </>
                )}
              </div>
            ))}
            {busy && <div className="typing"><i /><i /><i /></div>}
          </>
        )}

        <div className="composer" style={empty ? { marginTop: 18 } : {}}>
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder={active.imagine ? 'Describe the image to generate…' : active.video ? 'Describe the video to generate…' : 'Ask anything'}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(240, e.target.scrollHeight) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <div className="composer-bar">
            <button className="icon-btn" title="Add files" onClick={() => notify('Attach from the Codex workspace — drag & drop lands in v0.2')}>＋</button>
            <ToolChips active={active} setActive={setActive} />
            <button className="send-btn" disabled={!input.trim() || busy} onClick={() => send()}>
              {busy ? '■' : '↑'}
            </button>
          </div>
        </div>

        {empty && (
          <>
            <div className="suggest-grid">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="suggest-card" onClick={() => {
                  if (s.to) { window.location.href = s.to + (s.text ? `?q=${encodeURIComponent(s.text)}` : ''); return; }
                  if (s.tool) setActive((a) => ({ ...a, [s.tool]: true }));
                  send(s.text);
                }}>
                  <strong>{s.icon} {s.title}</strong>
                  <div className="tiny" style={{ marginTop: 4 }}>{s.text}</div>
                </button>
              ))}
            </div>
            <div className="disclaimer">
              ANTICODEX can make mistakes. {cfg?.provider_count || 26} provider endpoints · Model: {model.includes('::') ? model.split('::')[1] : model}
            </div>
          </>
        )}
        {!empty && (
          <div className="disclaimer">
            {user?.name ? `Chatting as ${user.name} · ` : ''}ANTICODEX can make mistakes. Check important info.
          </div>
        )}
      </div>
    </div>
  );
}
