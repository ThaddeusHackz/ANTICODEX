import React, { useEffect, useState } from 'react';
import { useApp } from '../lib/state.jsx';
import * as api from '../lib/api.js';

function GatewayCard({ g, notify }) {
  return (
    <div className="mcp-card" style={{ borderColor: '#8b5cf666' }}>
      <div className="row">
        <div className="mcp-icon">⚡</div>
        <div>
          <h3>{g.name}</h3>
          <div className="tiny">{g.vendor} · free hosted gateway</div>
        </div>
      </div>
      <div className="small" style={{ color: 'var(--text-2)' }}>{g.description}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0' }}>
        {g.tags.slice(0, 8).map((t) => <span key={t} className="source-chip">{t}</span>)}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn primary" onClick={() => {
          window.open(g.gateway, '_blank', 'noopener');
          notify('Sign-in page opened — connect your apps there, then paste your MCP endpoint URL below');
        }}>Open connect page</button>
        <span className="tiny">sign in → pick apps → copy endpoint</span>
      </div>
    </div>
  );
}

function CatalogCard({ item, onConnect, status }) {
  return (
    <div className="mcp-card">
      <div className="row">
        <div className="mcp-icon">{item.name.slice(0, 1)}</div>
        <div style={{ minWidth: 0 }}>
          <h3>{item.name}</h3>
          <div className="tiny">
          {item.vendor} {item.oauth ? '· OAuth sign-in in browser' : '· no sign-in needed'}
          {item.version ? ` · v${item.version}` : ''}
        </div>
        </div>
      </div>
      <div className="small" style={{ color: 'var(--text-2)', flex: 1 }}>{item.description}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {item.local && <span className="local-chip">⌂ runs on this machine</span>}
        {(item.tags || []).slice(0, 6).map((t) => <span key={t} className="source-chip">{t}</span>)}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn primary" onClick={() => onConnect(item)}>{status || (item.oauth ? 'Connect' : 'Connect')}</button>
        {item.gateway && <a className="tiny" href={item.gateway} target="_blank" rel="noreferrer">gateway ↗</a>}
      </div>
    </div>
  );
}

export default function McpPage() {
  const { notify } = useApp();
  const [catalog, setCatalog] = useState([]);
  const [gateways, setGateways] = useState([]);
  const [connections, setConnections] = useState([]);
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [busy, setBusy] = useState('');
  const [probeOut, setProbeOut] = useState(null);

  const refresh = async () => {
    try {
      const [c, l] = await Promise.all([api.mcp.catalog(), api.mcp.list()]);
      setCatalog(c.catalog || []);
      setGateways((c.catalog || []).filter((x) => x.gateway));
      setConnections(l.connections || []);
    } catch (e) { notify('Could not load connectors: ' + e.message); }
  };
  useEffect(() => { refresh(); }, []);

  // /mcp/callback?code=...&state=... — finish the OAuth dance
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code'); const state = q.get('state');
    if (code && state) {
      setBusy('oauth');
      api.mcp.connectCallback({ code, state }).then((r) => {
        notify(r.ok ? `Connected ${r.connection?.name}` : (r.error || 'OAuth failed'));
        refresh();
        window.history.replaceState({}, '', '/mcp');
      }).catch((e) => notify('OAuth failed: ' + e.message)).finally(() => setBusy(''));
    }
  }, []);

  async function connect(item) {
    setBusy(item.id);
    setProbeOut(null);
    try {
      if (item.local && !window.anticodexDesktop) {
        notify('This server runs on your machine — connect it from the desktop app or a local `npm start`, not from the hosted site.');
      }
      if (item.url?.startsWith('REPLACE') || item.url?.includes('YOUR-')) {
        notify('This one needs your personal endpoint URL — open its gateway page first, then paste the URL below');
        window.open(item.gateway || item.url, '_blank', 'noopener');
        return;
      }
      const r = await api.mcp.connectBegin({
        url: item.url,
        connection_id: item.id,
        redirect_uri: window.location.origin + '/mcp/callback'
      });
      if (r.authorize_url) {
        window.open(r.authorize_url, '_blank', 'noopener');
        notify('Sign-in page opened in a new tab — approve access and you will be connected');
      } else if (r.connected) {
        notify(`Connected ${r.connection?.name} — ${r.connection?.tools?.length || 0} tools available`);
      } else {
        notify(r.message || r.error || 'Connection needs extra setup');
        if (r.fix) notify(r.fix, 'info');
      }
      await refresh();
    } catch (e) {
      notify('Connect failed: ' + e.message);
    } finally { setBusy(''); }
  }

  async function addCustom() {
    if (!customUrl.trim()) return;
    setBusy('custom');
    try {
      const probe = await api.mcp.probe(customUrl.trim());
      setProbeOut(probe);
      if (probe.ok) {
        const r = await api.mcp.connectBegin({
          url: customUrl.trim(),
          connection_id: 'custom-' + Date.now().toString(36),
          redirect_uri: window.location.origin + '/mcp/callback'
        });
        if (r.authorize_url) {
          window.open(r.authorize_url, '_blank', 'noopener');
          notify('Server found — complete sign-in in the opened tab');
        } else if (r.connected) {
          notify(`Connected — ${probe.tools?.length || 0} tools found`);
        } else notify(r.message || r.error || 'Added');
        await refresh();
      } else {
        notify('Server handshake failed: ' + (probe.error || 'unknown'));
      }
    } catch (e) { notify('Failed: ' + e.message); }
    finally { setBusy(''); }
  }

  async function testConn(id) {
    setBusy('test-' + id);
    try {
      const r = await api.mcp.test(id);
      if (r.ok) notify(`✓ ${r.server?.name || 'server'} — ${r.tools?.length || 0} tools (${r.transport})`);
      else notify('✗ ' + (r.error || 'failed'));
      setProbeOut(r);
      await refresh();
    } finally { setBusy(''); }
  }

  return (
    <div className="content-wide">
      <div className="head">
        <h2 style={{ margin: 0 }}>Connectors</h2>
        <span className="badge">MCP · Model Context Protocol</span>
        <div className="between" />
        <span className="tiny">{connections.filter((c) => c.status === 'connected').length} connected</span>
      </div>
      <p className="small" style={{ color: 'var(--text-2)', marginTop: 0 }}>
        Connect tool servers exactly like ChatGPT connectors: pick one, sign in on its own authorization page in the
        browser, edit what it may do, then chat or run Codex with those tools live.
      </p>

      {connections.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3 style={{ marginTop: 0 }}>Connected</h3>
          {connections.map((c) => (
            <div key={c.id} className="perm-row">
              <div className="row">
                <span className="status-dot ok" />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                  <div className="tiny">{c.url} · {c.tools?.length || 0} tools · {c.has_token ? 'authorized' : 'public'}</div>
                </div>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={() => testConn(c.id)}>{busy === 'test-' + c.id ? 'Testing…' : 'Test'}</button>
                <button className="btn ghost" onClick={async () => {
                  if (!confirm('Disconnect and forget this connector?')) return;
                  await api.mcp.remove(c.id); refresh();
                }}>Disconnect</button>
              </div>
            </div>
          ))}
          {probeOut && (
            <pre className="term" style={{ marginTop: 10, maxHeight: 160 }}>
              {JSON.stringify(probeOut, null, 2).slice(0, 1400)}
            </pre>
          )}
        </div>
      )}

      <h3>One sign-in → connect Google Drive, Gmail, GitHub, Slack…</h3>
      <p className="small" style={{ color: 'var(--text-2)' }}>
        These free hosted gateways are the “connect your Google or GitHub account” website — the sign-in and permission
        editor opens in your browser, and you get a personal MCP endpoint URL to paste below.
      </p>
      <div className="mcp-grid" style={{ marginBottom: 22 }}>
        {gateways.map((g) => <GatewayCard key={g.id} g={g} notify={notify} />)}
      </div>

      <h3>Add a custom MCP server</h3>
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="grid-2">
          <div className="field">
            <label className="tiny">Name</label>
            <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="My server" />
          </div>
          <div className="field">
            <label className="tiny">MCP endpoint URL (Streamable HTTP or SSE)</label>
            <input value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://…/mcp or https://…/sse" />
          </div>
        </div>
        <button className="btn primary" onClick={addCustom} disabled={busy === 'custom'}>
          {busy === 'custom' ? 'Handshaking…' : 'Probe & Connect'}
        </button>
        <div className="tiny" style={{ marginTop: 8 }}>
          Also works with any server from <a href="https://mcpservers.org" target="_blank" rel="noreferrer">mcpservers.org</a> —
          paste its HTTP/SSE URL and ANTICODEX runs the full initialize → tools/list → tools/call handshake.
        </div>
      </div>

      <h3>Directory</h3>
      <div className="mcp-grid">
        {catalog.filter((c) => !c.gateway).map((item) => (
          <CatalogCard key={item.id} item={item} onConnect={connect} status={busy === item.id ? 'Connecting…' : ''} />
        ))}
      </div>
    </div>
  );
}
