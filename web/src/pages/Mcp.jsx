import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { mcp as mcpApi } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Modal, Field, Pill, Switch, Empty, Brand } from '../ui.jsx';

// Full OAuth-style authorization page (the pattern ChatGPT uses when you add a
// connector: open a page, sign in, pick permissions, approve).
function AuthorizePage({ ticket, connectionId }) {
  const { notify } = useApp();
  const [conn, setConn] = useState(null);
  const [scopes, setScopes] = useState({ tools: true, resources: true, prompts: true, read: true, write: false });
  const [state, setState] = useState('form');

  useEffect(() => {
    mcpApi.list().then((r) => {
      const c = (r.connections || []).find((x) => x.id === connectionId) ||
        { id: connectionId, name: connectionId, transport: 'http', desc: 'MCP server' };
      setConn(c);
    }).catch(() => setConn({ id: connectionId, name: connectionId }));
  }, [connectionId]);

  async function approve() {
    setState('working');
    try {
      await mcpApi.approve(ticket, Object.keys(scopes).filter((k) => scopes[k]));
      setState('done');
      notify('Connector authorized');
      setTimeout(() => { window.location.href = '/mcp'; }, 1200);
    } catch (e) {
      setState('form');
      notify(e.message, 'error');
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card spark" style={{ width: 480 }}>
        <Brand />
        <h2>Authorize connector</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          <b>{conn?.name || connectionId}</b> is requesting access to your ANTICODEX workspace.
        </p>
        <div className="card" style={{ background: 'var(--bg-soft)' }}>
          <div className="tiny" style={{ fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>PERMISSIONS</div>
          {[
            ['tools', 'Call tools', 'Let this server run its tools on your behalf'],
            ['resources', 'Read resources', 'Expose files/records the server provides'],
            ['prompts', 'Use prompts', 'Allow the prompt templates of this server'],
            ['read', 'Read-only access', 'Observe workspace context'],
            ['write', 'Write access', 'Modify data through this server']
          ].map(([k, label, desc]) => (
            <div className="perm-row" key={k}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
                <div className="tiny">{desc}</div>
              </div>
              <Switch on={scopes[k]} onChange={(v) => setScopes({ ...scopes, [k]: v })} />
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => { window.location.href = '/mcp'; }}>Cancel</button>
          <button className="btn primary" style={{ flex: 1 }} disabled={state !== 'form'} onClick={approve}>
            {state === 'working' ? 'Authorizing…' : state === 'done' ? '✓ Approved' : 'Authorize'}
          </button>
        </div>
        <div className="tiny" style={{ marginTop: 10, textAlign: 'center' }}>
          Ticket <span className="kbd">{(ticket || '').slice(0, 14)}…</span> · permissions are stored with the connection and revocable anytime.
        </div>
      </div>
    </div>
  );
}

export default function McpPage({ authorizeOnly = false }) {
  const [params] = useSearchParams();
  const { notify } = useApp();

  if (authorizeOnly || location.pathname === '/mcp/authorize') {
    return <AuthorizePage ticket={params.get('ticket') || ''} connectionId={params.get('connection') || 'custom'} />;
  }

  const [catalog, setCatalog] = useState([]);
  const [connections, setConnections] = useState([]);
  const [filter, setFilter] = useState('');
  const [wizard, setWizard] = useState(null);
  const [toolModal, setToolModal] = useState(null);
  const [toolOut, setToolOut] = useState('');

  function refresh() {
    mcpApi.catalog().then((r) => setCatalog(r.catalog || [])).catch(() => {});
    mcpApi.list().then((r) => setConnections(r.connections || [])).catch(() => {});
  }
  useEffect(refresh, []);

  async function connect(c) {
    try {
      const saved = await mcpApi.save({
        id: c.id, name: c.name, transport: c.transport, url: c.url, cmd: c.cmd,
        status: 'disconnected', permissions: { tools: true, resources: true, prompts: true, read: true, write: false }
      });
      const r = await mcpApi.authorize(c.id, ['tools', 'resources', 'read']);
      window.location.href = r.authorize_path;
    } catch (e) { notify(e.message, 'error'); }
  }

  async function disconnect(id) {
    await mcpApi.remove(id);
    refresh();
    notify('Connector removed');
  }

  async function callTool() {
    try {
      const r = await mcpApi.call(toolModal.id, toolModal.tool || 'tools/list', toolModal.args || {});
      setToolOut(JSON.stringify(r, null, 2));
    } catch (e) { setToolOut('⚠ ' + e.message); }
  }

  const connectedIds = new Set(connections.map((c) => c.id));
  const filtered = catalog.filter((c) =>
    !filter || c.name.toLowerCase().includes(filter.toLowerCase()) || c.category.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>MCP Connectors</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Model Context Protocol servers — connect GitHub, Drive, Slack, Notion, databases, browsers… exactly like ChatGPT connectors.
          </p>
        </div>
        <div className="row">
          <input placeholder="Search connectors…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
          <button className="btn primary" onClick={() => setWizard({ transport: 'http', permissions: { tools: true, resources: true, prompts: true, read: true, write: false } })}>+ Custom MCP</button>
        </div>
      </div>

      {connections.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Connected ({connections.length})</h3>
          <div className="grid-3" style={{ marginTop: 10 }}>
            {connections.map((c) => (
              <div key={c.id} className="card" style={{ background: 'var(--bg-soft)' }}>
                <div className="row between">
                  <b>{c.name}</b>
                  <Pill kind={c.status === 'connected' ? 'ok' : 'warn'}>{c.status}</Pill>
                </div>
                <div className="tiny" style={{ margin: '6px 0' }}>{c.transport} {c.url || c.cmd}</div>
                <div className="row">
                  <button className="btn small" onClick={() => setToolModal({ id: c.id, name: c.name, tool: 'tools/list' })}>Run tool</button>
                  <button className="btn small danger" onClick={() => disconnect(c.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mcp-grid">
        {filtered.map((c) => (
          <div key={c.id} className="card mcp-card">
            <div className="head">
              <div className="mcp-icon">{c.icon}</div>
              <div>
                <div style={{ fontWeight: 800 }}>{c.name}</div>
                <div className="tiny">{c.category} · {c.transport}</div>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: '2px 0', flex: 1 }}>{c.desc}</p>
            <div className="row">
              {connectedIds.has(c.id)
                ? <button className="btn small danger" onClick={() => disconnect(c.id)}>Disconnect</button>
                : <button className="btn small primary" onClick={() => connect(c)}>Connect</button>}
              <button className="btn small ghost" onClick={() => setWizard({ ...c, permissions: { tools: true, resources: true, prompts: true, read: true, write: false } })}>Configure</button>
            </div>
          </div>
        ))}
      </div>

      {wizard && (
        <Modal title={wizard.name ? `Configure ${wizard.name}` : 'Custom MCP server'} onClose={() => setWizard(null)}>
          <div className="row" style={{ marginBottom: 12 }}>
            {['http', 'stdio'].map((t) => (
              <button key={t} className={`chip-toggle ${wizard.transport === t ? 'on' : ''}`}
                onClick={() => setWizard({ ...wizard, transport: t })}>{t === 'http' ? 'HTTP / SSE' : 'stdio command'}</button>
            ))}
          </div>
          {wizard.transport === 'http' ? (
            <Field label="MCP endpoint URL" hint="Streamable HTTP or SSE endpoint of the MCP server.">
              <input value={wizard.url || ''} onChange={(e) => setWizard({ ...wizard, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
            </Field>
          ) : (
            <Field label="Launch command" hint="Executed by the desktop app's MCP host process.">
              <input value={wizard.cmd || ''} onChange={(e) => setWizard({ ...wizard, cmd: e.target.value })} placeholder="npx -y @modelcontextprotocol/server-filesystem /path" />
            </Field>
          )}
          <Field label="Display name">
            <input value={wizard.name || ''} onChange={(e) => setWizard({ ...wizard, name: e.target.value })} placeholder="My connector" />
          </Field>
          <div className="card" style={{ background: 'var(--bg-soft)', padding: 12 }}>
            <div className="tiny" style={{ fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>PERMISSIONS</div>
            {Object.entries({ tools: 'Call tools', resources: 'Read resources', prompts: 'Use prompts', read: 'Read-only', write: 'Write access' }).map(([k, label]) => (
              <div className="perm-row" key={k}>
                <span style={{ fontSize: 13 }}>{label}</span>
                <Switch on={wizard.permissions?.[k]} onChange={(v) => setWizard({ ...wizard, permissions: { ...wizard.permissions, [k]: v } })} />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => setWizard(null)}>Cancel</button>
            <button className="btn primary" style={{ flex: 1 }} onClick={async () => {
              const id = wizard.id || `custom_${Date.now().toString(36)}`;
              await mcpApi.save({ ...wizard, id, status: 'disconnected' });
              const r = await mcpApi.authorize(id, Object.keys(wizard.permissions || {}).filter((k) => wizard.permissions[k]));
              window.location.href = r.authorize_path;
            }}>Save & authorize</button>
          </div>
        </Modal>
      )}

      {toolModal && (
        <Modal title={`Tool call · ${toolModal.name}`} onClose={() => setToolModal(null)}>
          <Field label="Tool name"><input value={toolModal.tool} onChange={(e) => setToolModal({ ...toolModal, tool: e.target.value })} /></Field>
          <Field label="Arguments (JSON)">
            <textarea value={JSON.stringify(toolModal.args || {}, null, 2)}
              onChange={(e) => { try { setToolModal({ ...toolModal, args: JSON.parse(e.target.value) }); } catch { /* live typing */ } }}
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
          </Field>
          <button className="btn primary" onClick={callTool}>Execute tool</button>
          {toolOut && <pre style={{ background: 'var(--bg-soft)', padding: 12, borderRadius: 10, fontSize: 12, overflowX: 'auto' }}>{toolOut}</pre>}
        </Modal>
      )}
    </div>
  );
}
