import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import * as api from '../lib/api.js';
import { useApp, userKey } from '../lib/state.jsx';
import { StatusPill, CopyField, Facts } from '../ui.jsx';
import { renderMarkdown } from '../lib/markdown.js';

const TIERS = [
  { id: '', label: 'All tiers' },
  { id: 'bundled', label: 'Bundled with ANTICODEX' },
  { id: 'curated', label: 'Curated' },
  { id: 'extra', label: 'Extended corpus' }
];

const TABS = [
  { id: 'browse', label: 'Browse' },
  { id: 'retrieve', label: 'Retrieval' },
  { id: 'scan', label: 'Safety scan' },
  { id: 'installed', label: 'Installed on this machine' },
  { id: 'sources', label: 'Sources' }
];

export default function SkillsPage() {
  const { notify, user } = useApp();
  const loc = useLocation();
  const initialSlug = new URLSearchParams(loc.search).get('slug') || '';

  const [tab, setTab] = useState(initialSlug ? 'browse' : 'browse');
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [tier, setTier] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const debounce = useRef(null);

  // --- data ---------------------------------------------------------------
  useEffect(() => { api.skillkit.stats().then(setStats).catch(() => setStats({ available: false, count: 0 })); }, []);

  const load = useCallback((opts = {}) => {
    setLoading(true);
    api.skillkit.list({ q: opts.q ?? q, tag: opts.tag ?? tag, tier: opts.tier ?? tier, page: opts.page ?? page, per: 48 })
      .then((r) => setList(r))
      .catch((e) => setList({ skills: [], total: 0, error: e.message }))
      .finally(() => setLoading(false));
  }, [q, tag, tier, page]);

  useEffect(() => { load(); }, [tag, tier, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { setPage(1); load({ q, page: 1 }); }, 180);
    return () => clearTimeout(debounce.current);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((slug) => {
    if (!slug) return;
    setDetailLoading(true);
    api.skillkit.get(slug)
      .then((r) => { if (r.ok) setDetail(r.skill); else notify(r.error); })
      .catch((e) => notify(e.message))
      .finally(() => setDetailLoading(false));
  }, [notify]);

  useEffect(() => { if (initialSlug) open(initialSlug); }, [initialSlug, open]);

  const tiers = list?.tiers || stats?.tiers || {};

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Skills</h1>
          <p className="sub">
            Instructions a model can follow, not prompt snippets. {stats ? stats.count.toLocaleString() : '—'} skills are pinned from
            seven permissively licensed sources, retrievable by meaning, budgeted into the prompt of whichever model you have
            connected, and installable into <code className="code-inline">~/.qoder/skills</code> in one click.
          </p>
        </div>
        <div className="actions">
          <button className={`btn small ${tab === 'browse' ? 'primary' : ''}`} onClick={() => setTab('browse')}>Browse</button>
          <button className={`btn small ${tab === 'retrieve' ? 'primary' : ''}`} onClick={() => setTab('retrieve')}>Retrieval</button>
          <button className={`btn small ${tab === 'scan' ? 'primary' : ''}`} onClick={() => setTab('scan')}>Safety scan</button>
          <button className={`btn small ${tab === 'installed' ? 'primary' : ''}`} onClick={() => setTab('installed')}>Installed</button>
          <button className={`btn small ${tab === 'sources' ? 'primary' : ''}`} onClick={() => setTab('sources')}>Sources</button>
        </div>
      </div>

      <Facts items={[
        { k: 'Skills', v: (stats?.count ?? 0).toLocaleString(), d: `${(stats?.sources ?? 0)} sources · pinned` },
        { k: 'Bundled', v: tiers.bundled ?? 0, d: 'ship with the app' },
        { k: 'Curated', v: tiers.curated ?? 0, d: 'reviewed collections' },
        { k: 'Extended', v: tiers.extra ?? 0, d: 'indexed, unreviewed prose' },
        { k: 'Flagged', v: stats?.flagged ?? 0, d: 'safety scan hits' },
        { k: 'Corpus', v: `${Math.round((stats?.bytes || 0) / 1024 / 1024)} MB`, d: 'of instructions' }
      ]} />

      {tab === 'browse' && (
        <div className="split" style={{ marginTop: 18 }}>
          <div>
            <div className="searchbar">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search 2,208 skills — “playwright test”, “sql injection”, “docx template”, “seo audit”…"
                aria-label="Search skills"
              />
              <select className="select" value={tier} onChange={(e) => { setTier(e.target.value); setPage(1); }}>
                {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <select className="select" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
                <option value="">Every tag</option>
                {(list?.tags || stats?.tags || []).map((t) => (
                  <option key={t.tag || t} value={t.tag || t}>{(t.tag || t)}{t.count ? ` (${t.count})` : ''}</option>
                ))}
              </select>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="tiny">
                {loading ? 'Searching…' : list ? `${list.total.toLocaleString()} match${list.total === 1 ? '' : 'es'}${list.pages > 1 ? ` · page ${list.page} of ${list.pages}` : ''}` : ''}
              </span>
              {q && <button className="btn small ghost" onClick={() => setQ('')}>Clear search</button>}
            </div>

            {loading && !list ? <div className="empty">Loading the atlas…</div> : null}

            <div className="grid cards">
              {(list?.skills || []).map((s) => (
                <button
                  key={s.slug}
                  className="skill-card"
                  onClick={() => open(s.slug)}
                  style={detail?.slug === s.slug ? { borderColor: 'var(--accent)' } : undefined}
                >
                  <div className="sc-top">
                    <span className="sc-name" title={s.slug}>{s.slug}</span>
                    {s.tier === 'bundled' && <span className="pill grad">bundled</span>}
                    {s.flags?.length ? <span className="sc-flag" title={s.flags.join(', ')}>⚠</span> : null}
                  </div>
                  <div className="sc-desc">{s.description || 'No description in frontmatter.'}</div>
                  <div className="sc-foot">
                    {(s.tags || []).slice(0, 2).map((t) => <span className="pill" key={t}>{t}</span>)}
                    <span style={{ marginLeft: 'auto' }}>{Math.round((s.bytes || 0) / 1024)} KB</span>
                    {s.score != null && <span title="retrieval score">{s.score}</span>}
                  </div>
                </button>
              ))}
            </div>

            {list && list.skills?.length === 0 && !loading && (
              <div className="empty">No skill matches that. Try a broader word — the corpus is prose, so “test”, “design”, “report” all work.</div>
            )}

            {list && list.pages > 1 && (
              <div className="row" style={{ justifyContent: 'center', marginTop: 14, gap: 8 }}>
                <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Previous</button>
                <span className="tiny">page {list.page} / {list.pages}</span>
                <button className="btn small" disabled={page >= list.pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
              </div>
            )}
          </div>

          <div className="detail">
            {!detail && !detailLoading && (
              <div className="empty" style={{ padding: '40px 20px' }}>
                Pick a skill to read it, retrieve it for a prompt, or install it.
                <div className="tiny" style={{ marginTop: 8 }}>Everything shown here is the exact text a model receives.</div>
              </div>
            )}
            {detailLoading && <div className="empty">Loading…</div>}
            {detail && !detailLoading && <SkillDetail skill={detail} onNotify={notify} signedIn={Boolean(user)} />}
          </div>
        </div>
      )}

      {tab === 'retrieve' && <RetrievalPanel onNotify={notify} onOpen={open} />}
      {tab === 'scan' && <ScanPanel onNotify={notify} />}
      {tab === 'installed' && <InstalledPanel onNotify={notify} />}
      {tab === 'sources' && <SourcesPanel />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SkillDetail({ skill, onNotify, signedIn }) {
  const [installing, setInstalling] = useState(false);
  const [ground, setGround] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  async function install(target) {
    setInstalling(true);
    try {
      // Desktop: the main process owns the skill roots, so it writes the file and
      // can say where it went. Browser/local server: the bridge does the same write.
      const desk = typeof window !== 'undefined' ? window.anticodexDesktop : null;
      const r = target !== 'workspace' && desk?.installSkill
        ? await desk.installSkill({ slug: skill.slug, target })
        : await api.skillkit.export(skill.slug, { target });
      if (r?.ok) onNotify(`Installed ${r.slug} → ${r.file}`);
      else onNotify(r?.error || 'Could not install');
    } catch (e) { onNotify(e.message); }
    finally { setInstalling(false); }
  }

  async function groundIt() {
    try {
      const r = await api.skillkit.ground('', { slugs: [skill.slug], max_skills: 1, per_skill_chars: 12000 });
      setGround(r);
    } catch (e) { onNotify(e.message); }
  }

  return (
    <>
      <div className="detail-head">
        <div className="row" style={{ gap: 8 }}>
          <b style={{ fontSize: 14.5 }}>{skill.slug}</b>
          <StatusPill status={skill.tier === 'bundled' ? 'parity' : skill.tier === 'curated' ? 'live' : 'partial'} />
          <div className="between" />
          <span className="tiny">{Math.round(skill.bytes / 1024)} KB</span>
        </div>
        <div className="tiny" style={{ marginTop: 4, lineHeight: 1.5 }}>{skill.description}</div>
        <div className="row wrap" style={{ gap: 5, marginTop: 8 }}>
          {(skill.tags || []).map((t) => <span className="pill" key={t}>{t}</span>)}
          {skill.flags?.length ? <span className="pill warn">⚠ {skill.flags.join(', ')}</span> : null}
        </div>
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          <button className="btn small primary" disabled={installing} onClick={() => install('qoder')}>Install to ~/.qoder</button>
          <button className="btn small" disabled={installing} onClick={() => install('workspace')}>Copy into workspace</button>
          <button className="btn small" onClick={groundIt}>Build prompt block</button>
          <button className="btn small ghost" onClick={() => setShowRaw((v) => !v)}>{showRaw ? 'Rendered' : 'Raw'}</button>
        </div>
        {!signedIn && <div className="tiny" style={{ marginTop: 6 }}>Installing writes to this machine, so it needs the desktop app or a local server.</div>}
      </div>
      <div className="detail-body">
        {ground && (
          <div className="card tight" style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <b style={{ fontSize: 12.5 }}>What the model receives</b>
              <span className="pill">{ground.chars} chars</span>
            </div>
            <pre style={{ maxHeight: 220, overflowY: 'auto' }}>{ground.text}</pre>
            <div className="tiny">This is exactly the injected block — budgets applied, excerpt markers included.</div>
          </div>
        )}
        {skill.source?.url && (
          <div className="tiny" style={{ marginBottom: 8 }}>
            Source: <a href={skill.source.url} target="_blank" rel="noreferrer">{skill.source.repo}</a>
            {' · '}{skill.source.license}{skill.source.commit ? ` · ${String(skill.source.commit).slice(0, 10)}` : ''}
          </div>
        )}
        {skill.files?.length ? (
          <div className="tiny" style={{ marginBottom: 8 }}>{skill.files.length} side file{skill.files.length === 1 ? '' : 's'}: {skill.files.slice(0, 6).map((f) => f.path).join(', ')}</div>
        ) : null}
        {showRaw
          ? <pre>{skill.body}</pre>
          : <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(skill.body) }} />}
      </div>
    </>
  );
}

function RetrievalPanel({ onNotify, onOpen }) {
  const [text, setText] = useState('Build a React settings page with a danger zone and confirm dialogs');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try { setResult(await api.skillkit.resolve(text, { limit: 8 })); }
    catch (e) { onNotify(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="section">
      <div className="card">
        <div className="card-head">
          <h3>What would a turn retrieve?</h3>
          <div className="right"><span className="tiny">hybrid BM25 + name/tag boosts, deterministic</span></div>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: 10, fontSize: 13.5, outline: 'none' }}
          placeholder="Describe the task the way you would type it into chat…"
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={run} disabled={busy}>{busy ? 'Resolving…' : 'Resolve'}</button>
          <span className="tiny">The same query runs on every chat turn when skills are on.</span>
        </div>
      </div>

      {result && (
        <div className="section">
          <div className="row" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>{result.matched.length} skill{result.matched.length === 1 ? '' : 's'} would be offered</b>
            <span className="tiny">budget: up to 4 skills, 6,000 chars each, 24,000 total</span>
          </div>
          <table className="tbl">
            <thead><tr><th>Skill</th><th>Score</th><th>Why</th><th>Tier</th><th /></tr></thead>
            <tbody>
              {result.matched.map((m) => (
                <tr key={m.slug}>
                  <td><b>{m.slug}</b><div className="tiny" style={{ maxWidth: 520 }}>{m.description}</div></td>
                  <td className="num">{m.score}</td>
                  <td className="tiny">{m.why}</td>
                  <td><span className="pill">{m.tier}</span></td>
                  <td><button className="btn small ghost" onClick={() => onOpen(m.slug)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.matched.length === 0 && <div className="empty">Nothing cleared the score floor — a turn with this text injects no skills, which is the correct answer for “hello”.</div>}
        </div>
      )}
    </div>
  );
}

const SAMPLE = `const express = require('express');
const app = express();
app.get('/user', (req, res) => {
  db.query("SELECT * FROM users WHERE id = " + req.query.id);
  res.send(req.query.name);
});
const key = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
eval(process.env.SNIPPET);`;

function ScanPanel({ onNotify }) {
  const [code, setCode] = useState(SAMPLE);
  const [filename, setFilename] = useState('server.js');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try { setResult(await api.skillkit.scan(code, { filename })); }
    catch (e) { onNotify(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="section split">
      <div className="card">
        <div className="card-head">
          <h3>Scan source before it ships</h3>
          <div className="right">
            <input className="select" value={filename} onChange={(e) => setFilename(e.target.value)} style={{ width: 150 }} />
            <button className="btn small primary" onClick={run} disabled={busy}>{busy ? 'Scanning…' : 'Scan'}</button>
          </div>
        </div>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={16}
          spellCheck={false}
          style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', padding: 10, fontFamily: 'var(--mono)', fontSize: 12.5, outline: 'none' }}
        />
        <div className="tiny" style={{ marginTop: 6 }}>
          Nineteen rules with line numbers and a fix for each. This is the fast pass; VibeSec (installed as an MCP server) does taint analysis.
        </div>
      </div>

      <div>
        {!result && <div className="card empty">Press Scan. Findings are ordered by severity, then by line.</div>}
        {result && (
          <>
            <Facts cols={3} items={[
              { k: 'Verdict', v: <StatusPill status={result.summary.verdict} /> },
              { k: 'Findings', v: result.summary.total },
              { k: 'Language', v: result.language }
            ]} />
            <div className="card" style={{ marginTop: 10, padding: 0 }}>
              {result.findings.length === 0 && <div className="empty">No findings. That is not a proof of safety — it means no rule matched.</div>}
              {result.findings.map((f, i) => (
                <div key={`${f.id}-${f.line}-${i}`} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div className="row" style={{ gap: 8 }}>
                    <StatusPill status={f.severity === 'critical' ? 'block' : f.severity === 'high' ? 'review' : f.severity === 'medium' ? 'partial' : 'live'} />
                    <b style={{ fontSize: 13 }}>{f.id}</b>
                    <span className="tiny" style={{ marginLeft: 'auto' }}>line {f.line}</span>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>{f.message}</div>
                  <pre style={{ margin: '6px 0 0', padding: '6px 8px', background: 'var(--bg-input)', borderRadius: 7, fontSize: 11.5, overflowX: 'auto' }}>{f.excerpt}</pre>
                  {f.fix && <div className="tiny" style={{ marginTop: 4 }}>Fix: <code className="code-inline">{f.fix}</code></div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InstalledPanel({ onNotify }) {
  const { user } = useApp();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState(null);
  // Per-account, not per-browser: a shared machine must not remember that *you*
  // disabled a skill for the next person who signs in. Same rule as the workspace
  // data (lib/state.jsx → userKey).
  const enabledKey = userKey('acx_enabled_skills');
  const [enabled, setEnabled] = useState(() => {
    try { const raw = localStorage.getItem(enabledKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(enabledKey, JSON.stringify(enabled)); } catch { /* quota / private mode */ }
  }, [enabled, enabledKey]);

  const load = useCallback(() => {
    setBusy(true);
    api.skillkit.installed().then(setData).catch((e) => onNotify(e.message)).finally(() => setBusy(false));
    api.artifacts.list('document').then(setArtifacts).catch(() => setArtifacts(null));
  }, [onNotify]);

  useEffect(() => { load(); }, [load]);

  const isOn = (name) => enabled[name] !== false;
  const toggle = (name) => setEnabled((e) => ({ ...e, [name]: e[name] === false }));

  return (
    <div className="section">
      <div className="card">
        <div className="card-head">
          <h3>What is on this machine</h3>
          <div className="right">
            <button className="btn small" onClick={load} disabled={busy}>{busy ? 'Reading…' : 'Re-read'}</button>
          </div>
        </div>
        <p className="tiny" style={{ marginTop: 0 }}>
          Read live from <code className="code-inline">~/.qoder/skills</code>, <code className="code-inline">~/.codex/skills</code> and{' '}
          <code className="code-inline">~/.claude/skills</code>. Anything installed by Qoder itself shows up here and is resolvable by the
          same retrieval engine as the pinned corpus — that is how “whatever model is connected can use the skills” covers skills this
          app did not ship. A skill that the runtime would reject is listed under <b>Refused</b> with the reason, instead of looking
          installed but silently never loading.
        </p>
        {data?.note && <div className="pill warn" style={{ marginBottom: 8 }}>{data.note}</div>}
        <div className="stat-row">
          {(data?.roots || []).map((r) => (
            <div className="stat" key={r.id}>
              <div className="k">{r.id}</div>
              <div className="v">{r.count}</div>
              <div className="d" style={{ wordBreak: 'break-all' }}>{r.path}</div>
              <div className="d">{r.exists ? 'present' : 'not created yet'}</div>
            </div>
          ))}
        </div>
      </div>

      {data?.installed?.length ? (
        <table className="tbl" style={{ marginTop: 14 }}>
          <thead><tr><th>Name</th><th>Root</th><th>Description</th><th className="num">Size</th><th>Enabled</th></tr></thead>
          <tbody>
            {data.installed.map((s) => (
              <tr key={s.path}>
                <td><b>{s.name}</b><div className="tiny">{s.dir}</div></td>
                <td><span className="pill">{s.root}</span></td>
                <td className="tiny" style={{ maxWidth: 520 }}>{s.description}</td>
                <td className="num">{(s.bytes / 1024).toFixed(1)} KB</td>
                <td>
                  <button className={`chip ${isOn(s.name) ? 'active' : ''}`} onClick={() => toggle(s.name)}>
                    {isOn(s.name) ? 'on' : 'off'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty">{busy ? 'Reading skill roots…' : 'No skills installed under those roots yet — install one from Browse.'}</div>
      )}

      {data?.refused?.length ? (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Refused</h3>
            <div className="right"><span className="pill warn">{data.refused.length}</span>{data.duplicates ? <span className="pill">{data.duplicates} duplicate{data.duplicates === 1 ? '' : 's'}</span> : null}</div>
          </div>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Root</th><th>Why it will not load</th></tr></thead>
            <tbody>
              {data.refused.map((r) => (
                <tr key={r.path}>
                  <td><b>{r.name || '—'}</b><div className="tiny mono">{r.path}</div></td>
                  <td><span className="pill">{r.root}</span></td>
                  <td className="tiny">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {artifacts && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Template roots</h3>
            <div className="right"><span className="tiny">artifact templates a skill can point at</span></div>
          </div>
          <div className="tiny">
            {artifacts.count ? `${artifacts.count} template${artifacts.count === 1 ? '' : 's'} discovered in this machine's template roots.` : (artifacts.note || 'No artifact templates installed in this ChatGPT/Codex home.')}
          </div>
          <div className="row wrap" style={{ gap: 5, marginTop: 8 }}>
            {(artifacts.cards || []).slice(0, 12).map((c) => <span className="pill" key={c.id}>{c.title || c.id}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function SourcesPanel() {
  const [data, setData] = useState(null);
  useEffect(() => { api.skillkit.sources().then(setData).catch(() => setData({ sources: [] })); }, []);
  return (
    <div className="section">
      <div className="card">
        <div className="card-head">
          <h3>Where the corpus comes from</h3>
          <div className="right"><span className="tiny">{data?.count?.toLocaleString?.() || ''} skills · pinned {data?.generated_at ? new Date(data.generated_at).toLocaleDateString() : ''}</span></div>
        </div>
        <p className="tiny" style={{ marginTop: 0 }}>
          <code className="code-inline">node scripts/build-skill-atlas.mjs</code> is the only way this list changes. Every skill keeps its
          source URL and commit, and a skill whose licence is not permissive is not in the list.
        </p>
        <table className="tbl">
          <thead><tr><th>Source</th><th>Repository</th><th>Licence</th><th>Tier</th><th className="num">Skills</th><th>Commit</th></tr></thead>
          <tbody>
            {(data?.sources || []).map((s) => (
              <tr key={s.id}>
                <td><b>{s.label}</b></td>
                <td className="mono">{s.repo || 'this repository'}</td>
                <td>{s.license}</td>
                <td><span className="pill">{s.tier}</span></td>
                <td className="num">{s.found}</td>
                <td className="mono">{String(s.commit || 'n/a').slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
