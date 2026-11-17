import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadThreads, mergeThreads } from './lib/state.jsx';
import * as api from './lib/api.js';

// Codex/ChatGPT-style chat search: ⌘K opens, type filters titles and message
// bodies, ↑/↓ move, ⏎ opens, esc closes. Recent chats fill the empty query.
function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text.slice(0, 90);
  const start = Math.max(0, i - 30);
  return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 50) + (i + q.length + 50 < text.length ? '…' : '');
}

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export default function SearchChats({ open, onClose }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [threads, setThreads] = useState([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0);
    setThreads(loadThreads());
    api.threads.list()
      .then((r) => setThreads(mergeThreads(loadThreads(), (r && r.threads) || [])))
      .catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = threads.filter((t) => t && t.id);
    if (!query) return list.slice(0, 9).map((t) => ({ t, where: 'title', snip: t.title || 'Untitled chat' }));
    const out = [];
    for (const t of list) {
      const title = (t.title || '').toLowerCase();
      if (title.includes(query)) { out.push({ t, where: 'title', snip: t.title }); continue; }
      const msg = (t.messages || []).find((m) => String(m.content || '').toLowerCase().includes(query));
      if (msg) out.push({ t, where: 'message', snip: snippet(String(msg.content).replace(/\s+/g, ' '), q.trim()) });
      if (out.length >= 30) break;
    }
    return out;
  }, [q, threads]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const go = (r) => { if (!r) return; onClose(); nav(`/?thread=${encodeURIComponent(r.t.id)}`); };

  return (
    <div className="modal-back search-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-modal" role="dialog" aria-label="Search chats">
        <div className="search-input-row">
          <span className="ico">⌕</span>
          <input
            ref={inputRef}
            value={q}
            placeholder="Search chats…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter') go(results[sel]);
            }}
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="search-results" ref={listRef}>
          {!q.trim() && <div className="search-section">Recent chats</div>}
          {results.length === 0 && (
            <div className="search-empty">{q.trim() ? `No chats match “${q.trim()}”` : 'No chats yet — start one and it will appear here.'}</div>
          )}
          {results.map((r, i) => (
            <button key={r.t.id} data-idx={i} className={`search-row ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
              <span className="ico">{r.where === 'message' ? '💬' : '⌗'}</span>
              <span className="search-row-main">
                <span className="search-title"><Highlight text={r.t.title || 'Untitled chat'} q={q.trim()} /></span>
                {r.where === 'message' && <span className="search-snip"><Highlight text={r.snip} q={q.trim()} /></span>}
              </span>
              <span className="search-date">{new Date(r.t.updated_at || r.t.created_at || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </button>
          ))}
        </div>
        <div className="search-foot">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate</span>
          <span><kbd className="kbd">⏎</kbd> open</span>
          <span className="spacer" />
          <span>{threads.length} chat{threads.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}