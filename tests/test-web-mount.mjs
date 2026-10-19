// ANTICODEX — mounts the real React app in jsdom against the real bridge.
//
// Why this exists: `loadThreads().then(...)` in the sidebar was calling a
// synchronous helper, so the moment a user signed in the effect threw a
// TypeError and React tore down the whole signed-in shell — a blank screen that
// looked like "the workspace is broken". renderToString cannot catch that
// (effects never run), so this mounts with react-dom/client inside jsdom and
// asserts the shell actually stays on screen, per page, with the account's data.
//
//   node tests/test-web-mount.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'anticodex-mount-'));
let passed = 0; let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref();
  s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const waitFor = async (base, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"health"}' }); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: root, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ANTICODEX_DATA: DATA, SITE_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
server.stderr.on('data', (c) => { stderr += c.toString(); });

let entryPath = '';
let bundlePath = '';
try {
  if (!fs.existsSync(path.join(web, 'node_modules', 'react'))) {
    console.log('\n  ! web/node_modules missing — run `npm install` in web/ first. Skipping.');
    process.exit(0);
  }
  ok('server is up', await waitFor(BASE), stderr.slice(-200));
  // A stale listener on a reused port must never be able to answer for us.
  const cfg0 = await (await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"config"}' })).json();
  ok('this is the app under test', cfg0.name === 'ANTICODEX');

  // --- an account with a chat on the server ---------------------------------
  const reg = await (await fetch(`${BASE}/api/bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email: 'mount.user@gmail.com', password: 'mountpass123', name: 'Mount User' })
  })).json();
  ok('sign-up returns a session', Boolean(reg.token), JSON.stringify(reg).slice(0, 160));
  await fetch(`${BASE}/api/bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ action: 'threads', op: 'save', token: reg.token, thread: { id: 't_mount', title: 'Mount Rail Chat', messages: [{ role: 'user', content: 'from the rail' }] } })
  });

  // --- bundle the app for the jsdom realm -----------------------------------
  const esbuild = await import(pathToFileURL(path.join(web, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  entryPath = path.join(web, 'src', '__mount-entry.jsx');
  fs.writeFileSync(entryPath, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './lib/state.jsx';
import App from './App.jsx';
globalThis.__mount = (route) => {
  const root = createRoot(document.getElementById('root'));
  root.render(React.createElement(MemoryRouter, { initialEntries: [route], future: { v7_startTransition: true, v7_relativeSplatPath: true } },
    React.createElement(AppProvider, null, React.createElement(App))));
  return root;
};
`);
  bundlePath = path.join(DATA, 'app.bundle.js');
  await esbuild.build({
    entryPoints: [entryPath], outfile: bundlePath, bundle: true, format: 'iife',
    jsx: 'automatic', absWorkingDir: web, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }
  });
  const code = fs.readFileSync(bundlePath, 'utf8');

  const { JSDOM } = await import(pathToFileURL(path.join(web, 'node_modules', 'jsdom', 'lib', 'api.js')).href);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `${BASE}/`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const win = dom.window;
  // jsdom gaps the app would otherwise trip over (not app bugs).
  win.Element.prototype.scrollTo = () => {};
  win.Element.prototype.scrollIntoView = () => {};
  win.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(typeof input === 'string' ? input : input.url, `${BASE}/`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.end(init.body ? String(init.body) : undefined);
  });
  const errors = [];
  win.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  const consoleErrors = [];
  win.console.error = (...a) => consoleErrors.push(a.map(String).join(' '));

  const settle = async (ticks = 12) => {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 25));
  };
  const mountAt = async (route, { token, user } = {}) => {
    win.eval('document.getElementById("root").innerHTML = ""');
    for (const [k, v] of Object.entries({ acx_token: token, acx_user: user ? JSON.stringify(user) : null })) {
      if (v === null || v === undefined) continue;
      win.eval(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
    }
    win.eval(code);
    win.eval(`__mount(${JSON.stringify(route)})`);
    await settle();
    return win.document.getElementById('root').textContent.replace(/\s+/g, ' ');
  };

  console.log('\n— signed-in shell (the crash the user hit) —');
  const chatText = await mountAt('/', { token: reg.token, user: reg.user });
  ok('the app survives login (shell still mounted)', chatText.length > 20, `root is empty → the tree unmounted`);
  ok('no uncaught errors from effects', errors.length === 0, errors.join(' | '));
  ok('no React errors during mount', !consoleErrors.some((e) => /TypeError|Cannot read|unmount/i.test(e)), consoleErrors.filter((e) => /TypeError|Cannot read/i.test(e)).join(' | ').slice(0, 200));
  ok('the signed-in user is in the rail', chatText.includes('Mount User'), chatText.slice(0, 160));
  ok('server threads reach the rail', chatText.includes('Mount Rail Chat'), chatText.slice(0, 220));
  {
    const ta = win.document.querySelector('#root .composer textarea');
    ok('the composer is rendered', Boolean(ta), 'no textarea.composer');
    ok('composer placeholder is intact', ta?.getAttribute('placeholder') === 'Ask anything', String(ta?.getAttribute('placeholder')));
  }

  console.log('\n— the Codex workspace —');
  const wsText = await mountAt('/codex', { token: reg.token, user: reg.user });
  ok('workspace renders', wsText.length > 20);
  ok('sandbox file tree is visible', wsText.includes('SANDBOX FILES') && wsText.includes('src/index.js'), wsText.slice(0, 200));
  ok('approval modes are listed', wsText.includes('Suggest') && wsText.includes('Auto-run'));
  ok('agent pane is present', wsText.includes('Codex agent'));
  const wsDom = win.document.getElementById('root');
  const panes = wsDom.querySelector('.workspace');
  ok('workspace has all three panes', Boolean(panes && panes.querySelector('.file-tree') && panes.querySelector('.editor-pane') && panes.querySelector('.agent-pane')));
  ok('editor textarea is wired to the file', (panes?.querySelector('.editor-pane textarea')?.value || '').includes('greet'));

  console.log('\n— signed out —');
  win.eval('localStorage.clear()');
  const loginText = await mountAt('/login');
  ok('login screen renders', loginText.includes('Sign in') || loginText.includes('Welcome'), loginText.slice(0, 120));
  ok('no provider internals leak into the UI', !/Bearer token|PostgREST|supabase_co|service_role/i.test(loginText), loginText.slice(0, 160));

  console.log('\n— workspace data is per account —');
  win.eval('localStorage.clear()');
  const r2 = await (await fetch(`${BASE}/api/bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', email: 'other.user@gmail.com', password: 'otherpass123', name: 'Other User' })
  })).json();
  const other = await mountAt('/codex', { token: r2.token, user: r2.user });
  ok('a second account still gets its own workspace', other.includes('SANDBOX FILES'));
  const keys = win.eval('Object.keys(localStorage).join(",")');
  ok('workspace files are keyed by account, not shared', !/(^|,)acx_fs(,|$)/.test(String(keys)) || String(keys).includes('acx_fs:'), String(keys));
  const railOther = await mountAt('/', { token: r2.token, user: r2.user });
  ok("one account's chats do not leak into another's rail", !railOther.includes('Mount Rail Chat'), railOther.slice(0, 180));

  ok('server stayed alive throughout', server.exitCode === null, `exit ${server.exitCode}`);
} catch (e) {
  failed++;
  console.log(`\n  ✗ harness error: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* tmp */ }
  try { fs.rmSync(entryPath, { force: true }); } catch { /* temp entry */ }
  server.kill('SIGTERM');
  setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
