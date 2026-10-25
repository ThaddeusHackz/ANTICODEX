import React, { useEffect, useState } from 'react';
import { admin, api } from '../lib/api.js';
import { useApp } from '../lib/state.jsx';
import { Field, Pill, Brand } from '../ui.jsx';

export default function AdminPage() {
  const { notify } = useApp();
  const [token, setToken] = useState(sessionStorage.getItem('acx_admin_token') || '');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState(null);
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [keyForm, setKeyForm] = useState({
    TAVILY_API_KEY: '', EXA_API_KEY: '', NVIDIA_API_KEY: '',
    CF_ACCOUNT_ID: '', CF_API_TOKEN: '', MINIMAX_API_KEY: '', MINIMAX_GROUP_ID: '',
    // sign-in wiring (blank keeps the current value)
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', AUTH_REDIRECT: '', SITE_URL: '',
    REQUIRE_EMAIL_VERIFICATION: '', EXPOSE_RESET_CODES: '',
    OWNER_EMAIL: '', OWNER_NAME: '', OWNER_ROLE: ''
  });
  const [tab, setTab] = useState('overview');

  async function refresh(tok = token) {
    try {
      const [s, u, k] = await Promise.all([
        admin.stats(tok), admin.users(tok), admin.getKeys(tok)
      ]);
      setStats(s); setUsers(u.users || []); setKeys(k.keys || {});
    } catch (e) {
      if (e.status === 401) { setToken(''); sessionStorage.removeItem('acx_admin_token'); }
    }
  }

  useEffect(() => { if (token) refresh(token); }, [token]);

  async function login(e) {
    e.preventDefault();
    try {
      const r = await admin.login(creds);
      sessionStorage.setItem('acx_admin_token', r.token);
      setToken(r.token);
      notify('Admin access granted');
    } catch (e2) { notify(e2.message || 'Invalid credentials', 'error'); }
  }

  if (!token) {
    return (
      <div className="auth-shell">
        <div className="auth-card spark">
          <Brand />
          <h2>Admin console</h2>
          <p className="muted" style={{ marginTop: 0 }}>Restricted area — administrator credentials required.</p>
          <form onSubmit={login}>
            <Field label="Username"><input value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} required autoComplete="username" /></Field>
            <Field label="Password"><input type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} required autoComplete="current-password" /></Field>
            <button className="btn primary" style={{ width: '100%' }}>Enter console</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="content-wide">
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Admin Console</h2>
          <p className="muted" style={{ margin: '4px 0 0' }}>Users, global API keys, broadcasts and release management.</p>
        </div>
        <div className="tabs">
          {['overview', 'users', 'keys'].map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
      </div>

      {tab === 'overview' && stats && (
        <div className="grid-3">
          {[
            ['Registered users', stats.users, '◉'],
            ['Chat threads', stats.threads, '▤'],
            ['MCP connections', stats.mcp_connections, '⇄']
          ].map(([label, value, ico]) => (
            <div className="card" key={label}>
              <div className="row between">
                <div>
                  <div className="tiny" style={{ letterSpacing: 1 }}>{label.toUpperCase()}</div>
                  <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
                </div>
                <div style={{ fontSize: 26, opacity: 0.5 }}>{ico}</div>
              </div>
            </div>
          ))}
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3>System status</h3>
            <div className="row" style={{ gap: 8 }}>
              {(stats.providers || []).map((p) => <Pill key={p.id} kind={p.configured || p.id === 'demo' ? 'ok' : 'warn'}>{p.name}</Pill>)}
            </div>
            <h3 style={{ marginTop: 14 }}>Recent activity</h3>
            <table className="tbl">
              <thead><tr><th>Event</th><th>Detail</th><th>When</th></tr></thead>
              <tbody>
                {(stats.recent || []).slice(0, 12).map((a) => (
                  <tr key={a.id}><td>{a.type}</td><td>{a.message || a.user_id || a.ip || '—'}</td><td>{a.at}</td></tr>
                ))}
                {(stats.recent || []).length === 0 && <tr><td colSpan={3}>No events yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="card">
          <div className="row between" style={{ alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Users ({users.length})</h3>
            <button className="btn" onClick={async () => {
              try {
                const r = await api('admin', { op: 'ensure_owner', token });
                setUsers(r.users || []);
                notify(r.created?.length ? `Owner account created: ${r.created.join(', ')}` : 'Owner account already in place');
              } catch (e) { notify(e.message || 'Could not reach the ledger', 'error'); }
            }}>Check owner account</button>
          </div>
          <p className="sub">Anyone here can sign in to the app and the desktop build with their email and
            password. “Reset” sets a new password directly — no email needed, and it signs that user's other
            devices out.</p>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Provider</th><th>Joined</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.provider}</td>
                  <td>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {!u.confirmed && (
                        <button className="btn small" onClick={async () => {
                          await api('admin', { op: 'verify_user', token, email: u.email }).catch(() => ({}));
                          notify('Marked verified'); refresh();
                        }}>verify</button>
                      )}
                      <button className="btn small" onClick={async () => {
                        const pw = window.prompt(`New password for ${u.email} (at least 8 characters):`, '');
                        if (!pw) return;
                        try {
                          const r = await api('admin', { op: 'reset_user', token, email: u.email, password: pw });
                          notify(r.ok ? `Password reset for ${u.email}` : (r.error || 'Reset failed'));
                        } catch (e) { notify(e.message || 'Reset failed', 'error'); }
                      }}>reset</button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={6}>No users yet — sign-up is open.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'keys' && (
        <div className="card">
          <h3>Global API keys</h3>
          <p className="sub">
            Keys set here apply to the whole deployment (Tavily + Exa are owner-approved to ship inside the product).
            Leave a box blank to keep the value that is already saved.
            Current state: {keys && Object.entries(keys).map(([k, v]) => (
              <span key={k} className="pill" style={{ margin: 3 }}>{k}: {v}</span>
            ))}
          </p>
          {Object.keys(keyForm).map((k) => (
            <Field key={k} label={k}>
              <input value={keyForm[k]} onChange={(e) => setKeyForm({ ...keyForm, [k]: e.target.value })} placeholder={`Leave blank to keep current`} />
            </Field>
          ))}
          <button className="btn primary" onClick={async () => {
            const patch = Object.fromEntries(Object.entries(keyForm).filter(([, v]) => v));
            if (!Object.keys(patch).length) return notify('Nothing to save');
            try {
              await admin.setKeys(token, patch);
              notify('Global keys saved');
              setKeyForm(Object.fromEntries(Object.keys(keyForm).map((k) => [k, ''])));
              refresh();
            } catch (e) { notify(e.message, 'error'); }
          }}>Save global keys</button>
          <button className="btn danger" style={{ marginLeft: 10 }} onClick={async () => {
            await admin.logout(token).catch(() => {});
            sessionStorage.removeItem('acx_admin_token'); setToken(''); notify('Signed out of admin');
          }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
