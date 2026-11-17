import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';
import Icon from '../Icon.jsx';
import '../library.css';
import {
  CREATE_TARGETS,
  KIND_LABELS,
  LIBRARY_KEYS,
  SORT_OPTIONS,
  TIME_FILTERS,
  atMs,
  downloadPlan,
  filterRecords,
  formatBytes,
  libraryExport,
  mediaUrl,
  readLibrary,
  recordBytes,
  recordExport,
  removeRecords,
  sinceFor,
  sortRecords,
  sourceOf,
  summarize,
  titleOf
} from '../library.js';

// Library — the records this browser actually holds.
//
// Image Studio writes `acx_images` and Video Studio writes `acx_videos`; those
// two keys are the whole source of truth. The page does not merge in threads,
// workspace files or skills, because they are not library records and inventing
// a "kind" for them would make the stats and the delete button lie. The Create
// menu links to every surface that can make something, and says where each one
// stores its output.

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

const shortDate = (ms) => {
  if (ms === null || ms === undefined) return 'date unknown';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'date unknown';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
  });
};

const fullDate = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

function CreateMenu() {
  const ref = useRef(null);
  useEffect(() => {
    const close = (event) => {
      if (ref.current && !ref.current.contains(event.target)) ref.current.removeAttribute('open');
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return (
    <details className="acx-lib-create" ref={ref}>
      <summary className="btn primary acx-lib-create-btn">
        <Icon name="plus" size={16} /> Create
      </summary>
      <div className="acx-lib-create-menu" role="menu" aria-label="Create something new">
        <div className="acx-lib-create-head">Start something new</div>
        {CREATE_TARGETS.map((target) => (
          <Link
            key={target.to}
            className="acx-lib-create-item"
            to={target.to}
            role="menuitem"
            onClick={() => ref.current?.removeAttribute('open')}
          >
            <span className="acx-lib-create-icon"><Icon name={target.icon} size={16} /></span>
            <span className="acx-lib-create-text">
              <b>{target.label}</b>
              <small>{target.hint}</small>
            </span>
            <span className={`acx-lib-create-badge ${target.saves ? 'is-here' : ''}`}>
              {target.saves ? 'saved here' : 'elsewhere'}
            </span>
          </Link>
        ))}
      </div>
    </details>
  );
}

function KindTag({ record }) {
  const label = KIND_LABELS[record.kind] || record.kind || 'Record';
  const tone = record.kind === 'image' ? 'acx-lib-tag--image' : record.kind === 'video' ? 'acx-lib-tag--video' : '';
  return (
    <span className={`acx-lib-tag ${tone}`}>
      <Icon name={record.kind === 'video' ? 'video' : 'images'} size={11} />
      {label}
    </span>
  );
}

function StatusTag({ status }) {
  if (!status) return null;
  const tone = status === 'ready' ? 'acx-lib-tag--ok' : status === 'failed' ? 'acx-lib-tag--bad' : 'acx-lib-tag--warn';
  return <span className={`acx-lib-tag ${tone}`}>{status}</span>;
}

function RecordThumb({ record }) {
  const image = record.kind === 'image' ? mediaUrl(record.image) : null;
  const video = record.kind === 'video' ? mediaUrl(record.video) : null;
  return (
    <div className="acx-lib-thumb">
      {image ? (
        <img src={image} alt={titleOf(record)} loading="lazy" />
      ) : video ? (
        <video src={video} muted preload="metadata" playsInline aria-label={titleOf(record)} />
      ) : (
        <div className="acx-lib-thumb-empty">
          <Icon name={record.kind === 'video' ? 'video' : 'images'} size={28} />
        </div>
      )}
      {video && <span className="acx-lib-play" aria-hidden="true"><Icon name="video" size={12} /></span>}
    </div>
  );
}

function Stat({ label, value, hint, title }) {
  return (
    <div className="acx-lib-stat" title={title || hint || undefined}>
      <span className="acx-lib-stat-label">{label}</span>
      <span className="acx-lib-stat-value">{value}</span>
      <span className="acx-lib-stat-hint">{hint || '\u00a0'}</span>
    </div>
  );
}

function GridCard({ record, selected, onOpen, onToggle, onCopy, onDelete }) {
  const size = recordBytes(record);
  const plan = downloadPlan(record);
  const at = atMs(record);
  return (
    <article className={`acx-lib-card ${selected ? 'is-selected' : ''}`}>
      <div className="acx-lib-thumb-wrap">
        <RecordThumb record={record} />
        <button
          type="button"
          className="acx-lib-open-hit"
          onClick={onOpen}
          aria-label={`Preview ${titleOf(record)}`}
        />
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          className={`acx-lib-check ${selected ? 'is-on' : ''}`}
          onClick={onToggle}
          title={selected ? 'Deselect' : 'Select'}
          aria-label={selected ? `Deselect ${titleOf(record)}` : `Select ${titleOf(record)}`}
        >
          {selected && <Icon name="check" size={13} />}
        </button>
        <span className="acx-lib-thumb-top"><KindTag record={record} /></span>
        <div className="acx-lib-thumb-badges">
          {record.demo && <span className="acx-lib-tag acx-lib-tag--warn">preview</span>}
          <StatusTag status={record.status} />
        </div>
        <div className="acx-lib-hover">
          <button type="button" className="acx-lib-hover-btn" onClick={onOpen}>
            <Icon name="external" size={13} /> Preview
          </button>
          {plan && (
            <a
              className="acx-lib-hover-btn"
              href={plan.href}
              {...(plan.download ? { download: plan.filename } : { target: '_blank', rel: 'noreferrer' })}
            >
              {plan.download ? 'Download' : 'Open media'}
            </a>
          )}
        </div>
      </div>
      <div className="acx-lib-card-body">
        <button type="button" className="acx-lib-card-title" onClick={onOpen} title={titleOf(record)}>
          {titleOf(record)}
        </button>
        <div className="acx-lib-card-sub">
          <span title={sourceOf(record) || 'No provider or model recorded'}>{sourceOf(record) || '—'}</span>
          <span>{shortDate(at)}</span>
        </div>
        <div className="acx-lib-card-foot">
          <span className="acx-lib-size" title={size.known ? `${size.bytes.toLocaleString()} bytes` : size.reason}>
            {size.known ? formatBytes(size.bytes) : 'size unknown'}
          </span>
          {record.kind === 'video' && (record.duration || record.resolution) ? (
            <span>{[record.duration ? `${record.duration}s` : null, record.resolution].filter(Boolean).join(' · ')}</span>
          ) : null}
          <span className="acx-lib-card-actions">
            <button
              type="button"
              className="acx-lib-icon-action"
              onClick={onCopy}
              title={record.prompt ? 'Copy prompt' : 'This record has no prompt'}
              aria-label="Copy prompt"
              disabled={!record.prompt}
            >
              <Icon name="copy" size={14} />
            </button>
            <button type="button" className="acx-lib-icon-action" onClick={onDelete} title="Delete record" aria-label="Delete record">
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
      </div>
    </article>
  );
}

function ListRow({ record, selected, onOpen, onToggle, onCopy, onDelete }) {
  const size = recordBytes(record);
  const at = atMs(record);
  return (
    <div className={`acx-lib-row ${selected ? 'is-selected' : ''}`} role="listitem">
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        className={`acx-lib-check ${selected ? 'is-on' : ''}`}
        onClick={onToggle}
        title={selected ? 'Deselect' : 'Select'}
        aria-label={selected ? `Deselect ${titleOf(record)}` : `Select ${titleOf(record)}`}
      >
        {selected && <Icon name="check" size={12} />}
      </button>
      <button type="button" className="acx-lib-row-thumb" onClick={onOpen} aria-label={`Preview ${titleOf(record)}`}>
        <RecordThumb record={record} />
      </button>
      <div className="acx-lib-row-main">
        <button type="button" className="acx-lib-row-title" onClick={onOpen} title={titleOf(record)}>
          {titleOf(record)}
        </button>
        <div className="acx-lib-row-meta">
          <KindTag record={record} />
          <span>{sourceOf(record) || '—'}</span>
          {record.demo && <span className="acx-lib-tag acx-lib-tag--warn">preview</span>}
        </div>
      </div>
      <div className="acx-lib-row-col acx-lib-row-status"><StatusTag status={record.status} /></div>
      <div className="acx-lib-row-col acx-lib-row-size" title={size.known ? `${size.bytes.toLocaleString()} bytes` : size.reason}>
        {size.known ? formatBytes(size.bytes) : '—'}
      </div>
      <div className="acx-lib-row-col acx-lib-row-date" title={fullDate(at)}>{shortDate(at)}</div>
      <div className="acx-lib-row-actions">
        <button
          type="button"
          className="acx-lib-icon-action"
          onClick={onCopy}
          title={record.prompt ? 'Copy prompt' : 'This record has no prompt'}
          aria-label="Copy prompt"
          disabled={!record.prompt}
        >
          <Icon name="copy" size={14} />
        </button>
        <button type="button" className="acx-lib-icon-action" onClick={onDelete} title="Delete record" aria-label="Delete record">
          <Icon name="trash" size={14} />
        </button>
        <button type="button" className="acx-lib-icon-action" onClick={onOpen} title="Preview" aria-label="Preview">
          <Icon name="external" size={14} />
        </button>
      </div>
    </div>
  );
}

function EmptyLibrary({ unreadable = false }) {
  return (
    <div className="acx-lib-empty">
      <div className="acx-lib-empty-icon"><Icon name={unreadable ? 'alert' : 'library'} size={24} /></div>
      <h2>{unreadable ? 'No readable records' : 'No records yet'}</h2>
      <p>
        This library reads <code>acx_images</code> and <code>acx_videos</code> in this browser.
        {unreadable
          ? ' At least one of those keys could not be read; the error above says which one and why.'
          : ' Generate an image or queue a video and its record appears here automatically.'}
      </p>
      <p className="acx-lib-empty-note">
        Chats stay in the sidebar; code and workspace files stay in Codex; installed skills stay in Skills.
        This page does not copy them into a pretend record.
      </p>
      <div className="acx-lib-empty-actions">
        <Link className="btn primary" to="/images"><Icon name="images" size={15} /> Create an image</Link>
        <Link className="btn ghost" to="/video"><Icon name="video" size={15} /> Create a video</Link>
        <Link className="btn ghost" to="/sandbox"><Icon name="sandbox" size={15} /> Open Sandbox</Link>
      </div>
    </div>
  );
}

function NoMatches({ total, onClear }) {
  return (
    <div className="acx-lib-empty">
      <div className="acx-lib-empty-icon"><Icon name="search" size={23} /></div>
      <h2>No records match these filters</h2>
      <p>
        {total === 1 ? 'There is 1 record' : `There are ${total.toLocaleString()} records`} in this browser,
        but none match the current search, kind and time window.
      </p>
      <div className="acx-lib-empty-actions">
        <button type="button" className="btn primary" onClick={onClear}>Clear filters</button>
      </div>
    </div>
  );
}

function mediaReason(record) {
  if (record.kind === 'video') {
    if (record.video === 'demo' || record.demo) return 'This is a simulated job, so there is no video file to play.';
    if (record.status && record.status !== 'ready' && record.status !== 'failed') {
      return `The job is "${record.status}", so no video file is recorded yet.`;
    }
    if (record.status === 'failed') return 'The job failed, so no video file was produced.';
    if (record.video) return `The job stores a provider reference (${String(record.video).slice(0, 90)}), not a URL this page can play.`;
    return 'This record has no video field.';
  }
  return record.image
    ? 'The image field is not a data, http(s), blob or local path this page can display.'
    : 'This record has no image field.';
}

export default function LibraryPage() {
  const { notify } = useApp();
  const store = useMemo(browserStorage, []);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('grid');
  const [selected, setSelected] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  // Artifacts written by the bridge (sandbox output, documents, skills, and the
  // server copy of every image/video render) live in the account's library file,
  // not in localStorage. They are a separate, honest group: this page never
  // pretends a server record is a browser record or vice versa.
  const [server, setServer] = useState({ loading: true, items: [], summary: null, error: null });

  useEffect(() => {
    let alive = true;
    setServer((prev) => ({ ...prev, loading: true }));
    Promise.all([
      api.library.summary().catch((e) => ({ error: e?.message || String(e) })),
      api.library.list({ limit: 60 }).catch((e) => ({ error: e?.message || String(e), items: [] }))
    ]).then(([summary, list]) => {
      if (!alive) return;
      const error = list?.error || summary?.error || null;
      setServer({ loading: false, items: Array.isArray(list?.items) ? list.items : [], summary: summary && !summary.error ? summary : null, error });
    }).catch((e) => {
      if (alive) setServer({ loading: false, items: [], summary: null, error: e?.message || String(e) });
    });
    return () => { alive = false; };
  }, [tick]);

  const data = useMemo(() => readLibrary(store), [store, tick]);
  const summary = useMemo(() => summarize(data.items), [data.items]);
  const shown = useMemo(() => {
    const since = sinceFor(timeFilter, now);
    return sortRecords(filterRecords(data.items, { query, kind, since }), sort);
  }, [data.items, query, kind, timeFilter, sort, now]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onStorage = (event) => {
      if (!event.key || event.key === LIBRARY_KEYS.image || event.key === LIBRARY_KEYS.video) {
        setTick((value) => value + 1);
        setNow(Date.now());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  useEffect(() => {
    setSelected((previous) => {
      if (!previous.size) return previous;
      const alive = new Set(data.items.map((record) => record.uid));
      const next = new Set([...previous].filter((uid) => alive.has(uid)));
      return next.size === previous.size ? previous : next;
    });
  }, [data.items]);

  useEffect(() => {
    if (!preview) return;
    if (!data.items.some((record) => record.uid === preview.uid)) setPreview(null);
  }, [data.items, preview]);

  useEffect(() => {
    setConfirmBulk(false);
  }, [selected]);

  const selectedItems = useMemo(
    () => data.items.filter((record) => selected.has(record.uid)),
    [data.items, selected]
  );
  const allShownSelected = shown.length > 0 && shown.every((record) => selected.has(record.uid));

  const knownCount = summary.total - summary.unknownBytes;
  const bytesValue = knownCount === 0 ? '—' : `${summary.unknownBytes ? '≥ ' : ''}${formatBytes(summary.knownBytes)}`;
  const bytesHint = knownCount === 0
    ? (summary.total ? 'size not recorded' : 'No records')
    : summary.unknownBytes
      ? `${knownCount}/${summary.total} records sized`
      : 'all records sized';
  const bytesTitle = summary.total === 0
    ? 'No records yet.'
    : knownCount === 0
      ? 'None of these records carries a byte size. Images usually store a data URL (size known); remote video links, provider references and simulated jobs do not.'
      : summary.unknownBytes
        ? `${formatBytes(summary.knownBytes)} is known for ${knownCount} of ${summary.total} records. The other ${summary.unknownBytes} do not report a size, so this total is a lower bound.`
        : 'Every record reports a byte size.';
  const kindsHint = summary.total === 0
    ? 'No records'
    : summary.kinds.map((id) => `${summary.counts[id]} ${KIND_LABELS[id].toLowerCase()}${summary.counts[id] === 1 ? '' : 's'}`).join(' · ');
  const lastHint = summary.total === 0
    ? 'No records'
    : summary.lastAt === null
      ? 'no parseable date'
      : new Date(summary.lastAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const lastTitle = summary.total === 0
    ? 'No records yet.'
    : summary.lastAt === null
      ? 'No record carries a parseable at/created_at value.'
      : `Last record written ${new Date(summary.lastAt).toLocaleString()}`;

  function clearFilters() {
    setQuery('');
    setKind('all');
    setTimeFilter('all');
  }

  function toggleSelected(uid) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function selectAllShown() {
    setSelected((previous) => new Set([...previous, ...shown.map((record) => record.uid)]));
  }

  function saveText(file) {
    try {
      const blob = new Blob([file.content], { type: file.mime || 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = file.filename;
      anchor.rel = 'noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      notify(`Exported ${file.filename}`);
    } catch (error) {
      notify(`Could not export: ${String(error?.message || error)}`, 'error');
    }
  }

  function exportRecords(records) {
    if (!records.length) {
      notify('Nothing to export in this view.', 'error');
      return;
    }
    saveText(libraryExport(records));
  }

  async function copyValue(text, message) {
    if (!text) {
      notify('This record has nothing to copy in that field.', 'error');
      return;
    }
    if (!navigator.clipboard?.writeText) {
      notify('Clipboard access is not available in this browser.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify(message);
    } catch (error) {
      notify(`Copy failed: ${String(error?.message || error)}`, 'error');
    }
  }

  function deleteUids(uids) {
    const result = removeRecords(store, uids);
    const parts = [];
    if (result.removed) parts.push(`${result.removed} record${result.removed === 1 ? '' : 's'} removed from this browser`);
    if (result.errors.length) {
      const [first] = result.errors;
      parts.push(result.errors.length > 1 ? `${first.error} (+${result.errors.length - 1} more)` : first.error);
    }
    if (!parts.length) parts.push('Nothing was removed — those records are no longer in storage.');
    notify(parts.join(' · '), result.errors.length ? 'error' : 'info');
    if (preview && uids.includes(preview.uid) && result.removed) setPreview(null);
    setSelected((previous) => {
      const next = new Set(previous);
      for (const uid of uids) next.delete(uid);
      return next;
    });
    setConfirmBulk(false);
    setTick((value) => value + 1);
    setNow(Date.now());
  }

  function deleteOne(record) {
    const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm(`Delete “${titleOf(record)}”? This removes the record from this browser.`);
    if (confirmed) deleteUids([record.uid]);
  }

  function bulkDelete() {
    if (!selected.size) return;
    if (!confirmBulk) {
      setConfirmBulk(true);
      return;
    }
    deleteUids([...selected]);
  }

  function refresh() {
    setTick((value) => value + 1);
    setNow(Date.now());
  }

  const previewBytes = preview ? recordBytes(preview) : null;
  const previewAt = preview ? atMs(preview) : null;
  const previewPlan = preview ? downloadPlan(preview) : null;
  const previewMedia = preview ? (preview.kind === 'video' ? mediaUrl(preview.video) : mediaUrl(preview.image)) : null;
  const previewCopyData = preview
    ? (preview.kind === 'video' ? preview.video : preview.image)
    : null;
  const previewHasDataUrl = typeof previewCopyData === 'string' && previewCopyData.startsWith('data:');

  return (
    <div className="content-wide acx-library">
      <header className="acx-lib-head">
        <div className="acx-lib-head-copy">
          <div className="acx-lib-eyebrow">
            Local records
            <code>{LIBRARY_KEYS.image}</code>
            <span aria-hidden="true">+</span>
            <code>{LIBRARY_KEYS.video}</code>
          </div>
          <h1>Library</h1>
          <p>
            Every image and video generated in this browser. The page reads the two storage keys the
            generators actually write, derives every number below from those records, and never invents
            a record it did not find.
          </p>
        </div>
        <div className="acx-lib-head-actions">
          <button type="button" className="btn ghost" onClick={refresh} title="Re-read browser storage">
            <Icon name="refresh" size={15} /> Refresh
          </button>
          <CreateMenu />
        </div>
      </header>

      <section className="acx-lib-stats" aria-label="Library statistics">
        <Stat
          label="Records"
          value={summary.total.toLocaleString()}
          hint={summary.total === 1 ? 'record in this browser' : 'records in this browser'}
        />
        <Stat
          label="Kinds"
          value={String(summary.kindCount)}
          hint={kindsHint}
          title={summary.total === 0 ? 'No records yet.' : `Kinds present: ${summary.kinds.map((id) => KIND_LABELS[id]).join(', ')}`}
        />
        <Stat label="Known bytes" value={bytesValue} hint={bytesHint} title={bytesTitle} />
        <Stat
          label="Last write"
          value={summary.lastAt === null ? '—' : shortDate(summary.lastAt)}
          hint={lastHint}
          title={lastTitle}
        />
      </section>

      {data.errors.length > 0 && (
        <div className="acx-lib-alert" role="alert">
          <Icon name="alert" size={17} />
          <div>
            <b>Some stored records could not be read.</b>
            {data.errors.map((error, index) => (
              <div key={`${error.key || 'storage'}:${index}`}>
                {error.key ? <code>{error.key}</code> : null} {error.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.skipped.length > 0 && (
        <div className="acx-lib-note">
          Skipped {data.skipped.length} stored {data.skipped.length === 1 ? 'entry' : 'entries'} that
          {data.skipped.length === 1 ? ' is' : ' are'} not record objects in {[...new Set(data.skipped.map((item) => item.key))].join(', ')}.
        </div>
      )}

      <div className="acx-lib-toolbar">
        <label className="acx-lib-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompt, kind or source…"
            aria-label="Search library"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" title="Clear search">
              <Icon name="close" size={13} />
            </button>
          )}
        </label>

        <div className="acx-lib-tabs" role="group" aria-label="Record kind">
          {[['all', 'All'], ['image', 'Images'], ['video', 'Videos']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`acx-lib-tab ${kind === id ? 'is-on' : ''}`}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {label}
              <b>{id === 'all' ? summary.total : summary.counts[id] || 0}</b>
            </button>
          ))}
        </div>

        <label className="acx-lib-select" title="Filter by when the record was written. Records with no parseable date are excluded by a time filter.">
          <Icon name="clock" size={14} />
          <select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)} aria-label="Time filter">
            {TIME_FILTERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>

        <label className="acx-lib-select" title="Sort the filtered records">
          <Icon name="layers" size={14} />
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort order">
            {SORT_OPTIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>

        <div className="acx-lib-view" role="group" aria-label="View">
          <button
            type="button"
            className={view === 'grid' ? 'is-on' : ''}
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
            title="Grid view"
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            type="button"
            className={view === 'list' ? 'is-on' : ''}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
            title="List view"
          >
            <Icon name="layers" size={15} />
          </button>
        </div>
      </div>

      <div className="acx-lib-resultbar">
        <div className="acx-lib-resultline">
          <b>{shown.length}</b> of {data.items.length} {data.items.length === 1 ? 'record' : 'records'}
          {selected.size > 0 ? <span className="acx-lib-selected"> · {selected.size} selected</span> : null}
        </div>
        <div className="acx-lib-resultactions">
          {selected.size > 0 ? (
            <>
              <button type="button" className="btn small ghost" onClick={selectAllShown} disabled={allShownSelected}>
                Select all shown
              </button>
              <button type="button" className="btn small ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
              <button type="button" className="btn small ghost" onClick={() => exportRecords(selectedItems)}>
                Export selected
              </button>
              <button
                type="button"
                className={`btn small ${confirmBulk ? 'danger' : 'ghost'}`}
                onClick={bulkDelete}
                title={confirmBulk ? 'Click again to remove these records from this browser' : 'Select these records for deletion'}
              >
                {confirmBulk ? `Delete ${selected.size}?` : `Delete ${selected.size}`}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn small ghost" onClick={selectAllShown} disabled={!shown.length}>
                Select all shown
              </button>
              <button type="button" className="btn small ghost" onClick={() => exportRecords(shown)} disabled={!shown.length}>
                Export shown
              </button>
            </>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        data.items.length === 0
          ? <EmptyLibrary unreadable={data.errors.length > 0} />
          : <NoMatches total={data.items.length} onClear={clearFilters} />
      ) : view === 'grid' ? (
        <div className="acx-lib-grid">
          {shown.map((record) => (
            <GridCard
              key={record.uid}
              record={record}
              selected={selected.has(record.uid)}
              onOpen={() => setPreview(record)}
              onToggle={() => toggleSelected(record.uid)}
              onCopy={() => copyValue(record.prompt, 'Prompt copied')}
              onDelete={() => deleteOne(record)}
            />
          ))}
        </div>
      ) : (
        <div className="acx-lib-list" role="list">
          {shown.map((record) => (
            <ListRow
              key={record.uid}
              record={record}
              selected={selected.has(record.uid)}
              onOpen={() => setPreview(record)}
              onToggle={() => toggleSelected(record.uid)}
              onCopy={() => copyValue(record.prompt, 'Prompt copied')}
              onDelete={() => deleteOne(record)}
            />
          ))}
        </div>
      )}

      <section className="acx-lib-server" aria-label="Artifacts saved by the workspace">
        <div className="acx-lib-server-head">
          <div>
            <div className="acx-lib-eyebrow">Workspace artifacts</div>
            <h2>Saved by the bridge</h2>
            <p className="tiny">
              Sandbox output, documents, exported skills and the account copy of every image or video render.
              These records live in this account’s library on the server; the local list above is this browser.
            </p>
          </div>
          <div className="acx-lib-server-count">
            {server.loading ? 'Reading…' : server.summary ? `${Number(server.summary.total || 0).toLocaleString()} total` : '—'}
          </div>
        </div>

        {server.error ? (
          <div className="acx-lib-alert" role="alert">
            <Icon name="alert" size={17} />
            <div>
              <b>The workspace library could not be read.</b>
              <div>{server.error}</div>
            </div>
          </div>
        ) : server.loading ? (
          <div className="acx-lib-note">Reading the workspace library…</div>
        ) : server.items.length === 0 ? (
          <div className="acx-lib-note">
            No workspace artifacts yet. Generate an image or video, run code in the Sandbox, or export a
            skill — each one writes a record here. Records made only in this browser stay in the list above.
          </div>
        ) : (
          <div className="acx-lib-server-grid">
            {server.items.map((item) => {
              const href = mediaUrl(item.url) || mediaUrl(item.path);
              const thumb = mediaUrl(item.thumb);
              return (
                <article className="acx-lib-server-card" key={item.id}>
                  <div className="acx-lib-server-thumb">
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon name={item.kind === 'video' ? 'video' : item.kind === 'image' ? 'images' : 'library'} size={22} />}
                    <span className="acx-lib-tag">{item.kind || 'record'}</span>
                  </div>
                  <div className="acx-lib-server-body">
                    <b title={item.title}>{item.title || 'Untitled artifact'}</b>
                    <div className="tiny">
                      {[item.source, item.bytes ? formatBytes(item.bytes) : null, item.created_at ? shortDate(Date.parse(item.created_at)) : null]
                        .filter(Boolean).join(' · ') || 'No source recorded'}
                    </div>
                    <div className="acx-lib-server-actions">
                      {href && <a className="btn small ghost" href={href} target="_blank" rel="noreferrer">Open</a>}
                      <button type="button" className="btn small ghost" onClick={() => copyValue(item.url || item.path || item.id, 'Artifact reference copied')}>
                        Copy ref
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="acx-lib-foot">
        <span>
          Stored in this browser: <code>{LIBRARY_KEYS.image}</code>, <code>{LIBRARY_KEYS.video}</code>.
          Clearing site data removes them; they are not in your account.
        </span>
        <span>
          Bytes are calculated from local data URLs. Remote media, provider references and simulated jobs
          report “size unknown” rather than a guess.
        </span>
      </footer>

      {preview && (
        <div
          className="modal-back"
          role="presentation" aria-hidden="true"
          onClick={(event) => { if (event.target === event.currentTarget) setPreview(null); }}
        >
          <div className="modal acx-lib-modal" role="dialog" aria-modal="true" aria-labelledby="acx-lib-modal-title">
            <div className="acx-lib-modal-head">
              <div>
                <div className="acx-lib-eyebrow">
                  <KindTag record={preview} />
                  {preview.demo && <span className="acx-lib-tag acx-lib-tag--warn">preview</span>}
                  {preview.id !== undefined && preview.id !== null && <code>id {String(preview.id)}</code>}
                </div>
                <h2 id="acx-lib-modal-title">{titleOf(preview)}</h2>
              </div>
              <button type="button" className="icon-btn" onClick={() => setPreview(null)} aria-label="Close preview">
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="acx-lib-modal-body">
              <div className="acx-lib-modal-media">
                {preview.kind === 'image' && previewMedia ? (
                  <img src={previewMedia} alt={titleOf(preview)} />
                ) : preview.kind === 'video' && previewMedia ? (
                  <video key={preview.uid} src={previewMedia} controls playsInline />
                ) : (
                  <div className="acx-lib-no-media">
                    <Icon name={preview.kind === 'video' ? 'video' : 'images'} size={28} />
                    <b>{preview.kind === 'video' ? 'No playable video file' : 'No preview image'}</b>
                    <span>{mediaReason(preview)}</span>
                  </div>
                )}
              </div>

              <div className="acx-lib-modal-side">
                <dl className="acx-lib-meta">
                  <dt>Kind</dt>
                  <dd><KindTag record={preview} /></dd>
                  <dt>Source</dt>
                  <dd title={sourceOf(preview) || 'No provider or model recorded'}>{sourceOf(preview) || '—'}</dd>
                  <dt>Created</dt>
                  <dd title={previewAt === null ? 'No at/created_at field' : new Date(previewAt).toLocaleString()}>
                    {fullDate(previewAt)}
                  </dd>
                  <dt>Size</dt>
                  <dd title={previewBytes.known ? `${previewBytes.bytes.toLocaleString()} bytes` : previewBytes.reason}>
                    {previewBytes.known ? formatBytes(previewBytes.bytes) : '—'}
                  </dd>
                  {preview.status ? (<><dt>Status</dt><dd><StatusTag status={preview.status} /></dd></>) : null}
                  {preview.duration ? (<><dt>Duration</dt><dd>{preview.duration}s</dd></>) : null}
                  {preview.resolution ? (<><dt>Resolution</dt><dd>{preview.resolution}</dd></>) : null}
                  {preview.id !== undefined && preview.id !== null ? (<><dt>Record id</dt><dd><code>{String(preview.id)}</code></dd></>) : null}
                </dl>

                {!previewBytes.known && <div className="acx-lib-meta-note">{previewBytes.reason}</div>}

                {preview.prompt && (
                  <div className="acx-lib-prompt">
                    <div className="acx-lib-prompt-label">Prompt</div>
                    {preview.prompt}
                  </div>
                )}

                <div className="acx-lib-modal-actions">
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => copyValue(preview.prompt, 'Prompt copied')}
                    disabled={!preview.prompt}
                  >
                    <Icon name="copy" size={14} /> Copy prompt
                  </button>
                  {previewHasDataUrl && (
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => copyValue(previewCopyData, `${preview.kind === 'video' ? 'Video' : 'Image'} data copied`)}
                    >
                      <Icon name="copy" size={14} /> Copy {preview.kind === 'video' ? 'video' : 'image'} data
                    </button>
                  )}
                  {previewPlan && (
                    previewPlan.download ? (
                      <a className="btn small ghost" href={previewPlan.href} download={previewPlan.filename}>
                        <Icon name="download" size={14} /> Download
                      </a>
                    ) : (
                      <a className="btn small ghost" href={previewPlan.href} target="_blank" rel="noreferrer">
                        <Icon name="external" size={14} /> Open media
                      </a>
                    )
                  )}
                  <button type="button" className="btn small ghost" onClick={() => saveText(recordExport(preview))}>
                    <Icon name="download" size={14} /> Export JSON
                  </button>
                  <button type="button" className="btn small danger" onClick={() => deleteOne(preview)}>
                    <Icon name="trash" size={14} /> Delete record
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
