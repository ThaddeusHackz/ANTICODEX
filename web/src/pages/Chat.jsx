import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, saveThreadLocal, threadsChanged, loadThreads } from '../lib/state.jsx';
import { modelLabel } from '../ModelPicker.jsx';
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
  const [speaking, setSpeaking] = useState(false);
  async function speak() {
    setSpeaking(true);
    try {
      const r = await api.extras({ op: 'tts', text: (text || '').slice(0, 2000) });
      if (r.ok === false) { notify(r.error); return; }
      const audio = new Audio('data:' + r.mime + ';base64,' + r.audio_base64);
      await audio.play();
    } catch (e) { notify('Speech failed: ' + e.message); }
    finally { setSpeaking(false); }
  }
  return (
    <div className="msg-actions">
      <button className="icon-btn" title="Copy" onClick={() => {
        navigator.clipboard?.writeText(text || '');
        notify('Copied to clipboard');
      }}>⧉</button>
      <button className="icon-btn" title="Read aloud" onClick={speak}>{speaking ? '⏸' : '🔊'}</button>
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
  // The style picker: a document/deck/sheet template chosen for this turn. The
  // grid mirrors the ChatGPT app's artifact template picker, including the part
  // that matters — nothing is shown that failed validation on disk.
  const [template, setTemplate] = useState(null);
  const [picker, setPicker] = useState(null);
  const [active, setActive] = useState({ search: false, imagine: false, video: false, research: false, mcp: true });
  const [threadId, setThreadId] = useState(() => new URLSearchParams(window.location.search).get('thread') || `th_${Date.now()}`);
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  // Opening a chat from the rail (?thread=…) must work offline too: read the
  // local copy immediately, then let the server copy win if it is newer.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('thread');
    if (!t) return;
    const local = loadThreads().find((x) => x && x.id === t);
    if (local?.messages?.length) { setMessages(local.messages); setThreadId(local.id); }
    api.threads.list().then((r) => {
      const th = (r.threads || []).find((x) => x.id === t);
      if (th?.messages?.length) { setMessages(th.messages); setThreadId(th.id); saveThreadLocal(th); threadsChanged(); }
    }).catch(() => {});
  }, [window.location.search, user?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const persist = async (next) => {
    const thread = {
      id: threadId,
      title: (next.find((m) => m.role === 'user')?.content || 'New chat').slice(0, 60),
      messages: next, model
    };
    // Local first: the rail and an offline desktop app must show the chat even
    // if the network call below never lands. Then tell the rail to re-read.
    saveThreadLocal(thread);
    threadsChanged();
    try {
      await api.threads.save(thread);
      threadsChanged();
    } catch { /* offline ok */ }
  };

  const TEMPLATE_KINDS = [
    { id: 'document', label: 'Document' },
    { id: 'presentation', label: 'Deck' },
    { id: 'spreadsheet', label: 'Sheet' }
  ];

  async function openTemplates(kind = 'document') {
    setPicker({ kind, loading: true, cards: [], note: null });
    try {
      const r = await api.artifacts.list(kind);
      setPicker({ kind, loading: false, cards: r.cards || [], note: r.note || (r.count === 0 && r.local ? 'No templates are installed in your ChatGPT home yet.' : null) });
    } catch (e) {
      setPicker({ kind, loading: false, cards: [], note: e.message || 'Could not read templates.' });
    }
  }

  async function chooseTemplate(card) {
    try {
      const r = await api.artifacts.choose(picker.kind, card.id);
      setTemplate({ ...r, preview: card.preview, title: r.title || card.title });
      setPicker(null);
      notify(`${card.title} template selected — the assistant will follow it.`);
    } catch (e) {
      setPicker((p) => ({ ...p, note: e.message || 'That template is no longer available.' }));
    }
  }

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
        model: model.includes('::') ? model.split('::').slice(1).join('::') : model,
        provider: model.includes('::') ? model.split('::')[0] : undefined,
        system,
        template: template || undefined,
        use_mcp: active.mcp !== false
      });
      // A provider failure comes back as { ok:false, error, settings_link } on a
      // 200 — it used to render as a bare "(no response)" with no explanation,
      // which is what "I added my NVIDIA key and nothing happens" looked like.
      const problem = out.ok === false || (out.error && !out.text);
      const reply = {
        role: 'assistant',
        content: problem ? `⚠ ${out.error}` : (out.text || out.content || '(no response)'),
        tool_calls: out.tool_calls,
        model: out.model,
        error: problem || undefined,
        // The actionable part is UI, not prose: a real button to the key you are
        // missing, or the model menu that has the one that works.
        fix: problem ? out.fix : undefined,
        verdict: problem ? out.verdict : undefined,
        provider: out.provider || undefined,
        settings_link: problem ? out.settings_link : undefined,
        model_picker: problem ? out.model_picker : undefined,
        // ids this endpoint says it really serves → one click to switch
        fallback: problem ? out.fallback : undefined,
        note: out.note || undefined
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
                    {m.note && !m.error ? <div className="tiny msg-note">{m.note}</div> : null}
                    {m.error ? (
                      <div className="msg-fix">
                        {m.settings_link
                          ? <Link className="btn small" to={m.settings_link}>Add or replace the key →</Link>
                          : null}
                        {m.model_picker
                          ? <span className="tiny">Open the model menu above and pick one this endpoint serves.</span>
                          : null}
                        {m.fix === 'quota' ? <span className="tiny">Out of quota on that key — a different model usually answers.</span> : null}
                        {(m.fallback || []).length ? (
                          <span className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                            <span className="tiny">This endpoint does serve:</span>
                            {m.fallback.slice(0, 4).map((f) => (
                              <button
                                key={f.id} type="button" className="pill msg-fix-option"
                                title={`Use ${f.id}`}
                                onClick={() => {
                                  const pid = m.provider || String(model || '').split('::')[0];
                                  setModel(`${pid}::${f.id}`);
                                  notify(`Now using ${f.label || f.id} — send it again and it will answer.`);
                                }}
                              >{f.label || f.id}</button>
                            ))}
                          </span>
                        ) : null}
                        {m.fix === 'retry' ? <button className="btn small ghost" onClick={() => send()}>Try again</button> : null}
                        {m.fix === 'endpoint' ? <span className="tiny">Base URL + key live in Settings → Providers. A key you saved is never blamed for a server that simply cannot reach out.</span> : null}
                      </div>
                    ) : null}
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
          {template && (
            <div className="row between" style={{ padding: '8px 10px 0' }}>
              <span className="pill" title={template.skill_path || ''}>
                ▤ {template.title} · {template.artifact_kind}
              </span>
              <button className="icon-btn" title="Remove template" onClick={() => setTemplate(null)}>×</button>
            </div>
          )}
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
            <label className="icon-btn" title="Voice input (Whisper)" style={{ cursor: 'pointer' }}>
              🎤
              <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
                notify('Transcribing…');
                try {
                  const r = await api.extras({ op: 'stt', audio_base64: b64, mime: f.type || 'audio/webm' });
                  if (r.ok === false) { notify(r.error); return; }
                  setInput((t) => (t ? t + ' ' : '') + (r.text || ''));
                } catch (err) { notify('Transcription failed: ' + err.message); }
              }} />
            </label>
            <button className="icon-btn" title="Choose a document, deck or sheet template" onClick={() => openTemplates(template?.artifact_kind?.replace('google-', '') || 'document')}>▤</button>
            <ToolChips active={active} setActive={setActive} />
            <button className="send-btn" disabled={!input.trim() || busy} onClick={() => send()}>
              {busy ? '■' : '↑'}
            </button>
          </div>
        </div>

        {picker && (
          <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) setPicker(null); }}>
            <div className="modal" style={{ width: 720, maxWidth: '94vw' }}>
              <div className="modal-head row between">
                <span>What style should this {TEMPLATE_KINDS.find((k) => k.id === picker.kind)?.label.toLowerCase() || 'document'} use?</span>
                <button className="icon-btn" onClick={() => setPicker(null)}>×</button>
              </div>
              <div className="row" style={{ padding: '0 22px', gap: 6 }}>
                {TEMPLATE_KINDS.map((k) => (
                  <button key={k.id} className={`chip-toggle ${picker.kind === k.id ? 'on' : ''}`} onClick={() => openTemplates(k.id)}>{k.label}</button>
                ))}
              </div>
              <div className="modal-body">
                {picker.loading && <div className="tiny">Reading templates…</div>}
                {!picker.loading && picker.note && <div className="tiny" style={{ opacity: 0.8 }}>{picker.note}</div>}
                {!picker.loading && picker.cards.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                    {picker.cards.map((card) => (
                      <button key={card.id} className="suggest-card" style={{ padding: 8 }} onClick={() => chooseTemplate(card)}>
                        {card.preview
                          ? <img src={card.preview} alt="" width={card.width} height={card.height} style={{ width: '100%', height: 90, objectFit: 'cover', borderRadius: 8 }} />
                          : <div style={{ height: 90, borderRadius: 8, background: 'var(--bg-soft)' }} />}
                        <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600 }}>{card.title}</div>
                        <div className="tiny" style={{ opacity: 0.75, lineHeight: 1.35 }}>{card.description}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

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
              ANTICODEX can make mistakes. {cfg?.provider_count || 27} provider endpoints · Model: {modelLabel(model, cfg?.picker)}
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
