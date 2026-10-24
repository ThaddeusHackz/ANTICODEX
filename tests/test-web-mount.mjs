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

/** Resolve a tool the harness itself needs from wherever npm actually put it.
 *  Hardcoding `node_modules/<pkg>/lib/main.js` works until a lockfile-driven
 *  `npm ci` nests the package differently than a fresh `npm install` does — and
 *  then the suite dies with ERR_MODULE_NOT_FOUND and looks like an app bug. Each
 *  package's own `main` is the truth; the guessed path is only a fallback. */
function resolveDep(name, guess) {
  for (const base of [path.join(web, 'node_modules'), path.join(root, 'node_modules')]) {
    const dir = path.join(base, name);
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const main = path.join(dir, pj.main || 'index.js');
      if (fs.existsSync(main)) return main;
    } catch { /* not here */ }
    const direct = path.join(dir, guess);
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

const MISSING = ['react', 'react-dom', 'esbuild', 'jsdom'].filter((n) => {
  if (n === 'esbuild' || n === 'jsdom') return !resolveDep(n, 'index.js');
  return !fs.existsSync(path.join(web, 'node_modules', n));
});

let entryPath = '';
let bundlePath = '';
try {
  if (MISSING.length) {
    console.log(`\n  ! web/node_modules is missing ${MISSING.join(', ')} — run \`npm install\` in web/ (devDependencies included). Skipping.`);
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
  const esbuildMain = resolveDep('esbuild', path.join('lib', 'main.js'));
  const esbuild = await import(pathToFileURL(esbuildMain).href);
  entryPath = path.join(web, 'src', '__mount-entry.jsx');
  fs.writeFileSync(entryPath, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './lib/state.jsx';
import App from './App.jsx';
globalThis.__mount = (route) => {
  // A previous mount must be unmounted, not innerHTML-wiped, or React's own
  // timers (the toast auto-hide) fire against removed nodes and throw.
  if (globalThis.__root) { try { globalThis.__root.unmount(); } catch (e) { /* already gone */ } }
  const root = createRoot(document.getElementById('root'));
  globalThis.__root = root;
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

  const { JSDOM } = await import(pathToFileURL(resolveDep('jsdom', path.join('lib', 'api.js'))).href);
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
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // The real bridge answers `chat_stream` with server-sent events, so the
        // harness has to hand the app a body reader as well as `json()` — otherwise
        // every streamed reply would be tested through a shape no server sends.
        const bytes = new TextEncoder().encode(body);
        let sent = false;
        resolve({
          ok: res.statusCode < 400,
          status: res.statusCode,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
          json: async () => JSON.parse(body || '{}'),
          text: async () => body,
          body: {
            getReader: () => ({
              read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
              cancel: async () => {}
            })
          }
        });
      });
    });
    req.on('error', reject);
    req.end(init.body ? String(init.body) : undefined);
  });
  // Every bridge call the UI makes is recorded, so "where did my key go?" is
  // answered from the wire, not from reading the component.
  const bridgeCalls = [];
  // Two responses are stubbed, not because the app is wrong but because those
  // branches need an upstream this sandbox cannot reach: a provider that answers
  // 200 with an error body, and a verified/live model list.
  let chatStub = null;
  let modelsStub = null;
  // Chat is streamed now (server-sent events), so the stub has to answer in that
  // shape — a JSON body with no `headers.get` is what a browser would never send.
  const sseStub = (payload) => {
    const frames = payload && payload.ok === false
      ? [{ type: 'error', ...payload }]
      : [
          { type: 'phase', phase: 'connected' },
          ...(payload?.reasoning ? [{ type: 'thinking', text: payload.reasoning }] : []),
          { type: 'delta', text: payload?.text || payload?.content || '' },
          { type: 'done', model: payload?.model, chars: (payload?.text || '').length, ...(payload?.thinking_ms ? { thinking_ms: payload.thinking_ms } : {}) }
        ];
    const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    const bytes = new TextEncoder().encode(raw);
    let sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
      json: async () => payload,
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
          cancel: async () => {}
        })
      }
    };
  };
  const rawFetch = win.fetch;
  win.fetch = (input, init = {}) => {
    let parsed = null;
    if (init && init.body) { try { parsed = JSON.parse(String(init.body)); bridgeCalls.push(parsed); } catch { /* non-json */ } }
    const act = parsed && parsed.action;
    if (act === 'chat' && chatStub) return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => JSON.parse(JSON.stringify(chatStub)) });
    if (act === 'chat_stream' && chatStub) return Promise.resolve(sseStub(JSON.parse(JSON.stringify(chatStub))));
    if (act === 'models' && modelsStub) return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(modelsStub)) });
    return rawFetch(input, init);
  };
  const q = (sel) => win.document.querySelector(sel);
  const qa = (sel) => [...win.document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const typeIn = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  const keydown = (el, key) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const errors = [];
  win.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  const consoleErrors = [];
  win.console.error = (...a) => consoleErrors.push(a.map(String).join(' '));

  // A floor, not a guess. `ticks` keeps its original meaning (×25 ms), and if the
  // DOM is still changing once that elapses the wait extends a little — because
  // "the probe answered" takes as long as the endpoint takes, and a fixed sleep is
  // a coin flip on a cold runner. Short floors are left alone: several callers
  // deliberately assert on transient UI (a toast that auto-hides), and extending
  // past that would assert on UI that has already vanished. (A 900ms-everywhere
  // version of this helper did exactly that and turned 3 assertions red.)
  const settle = async (ticks = 12) => {
    const floor = ticks * 25;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    while (Date.now() - t0 < floor) await wait(25);
    if (floor < 300) return;
    let last = -1; let busy = 0;
    while (Date.now() - t0 < floor + 1500) {
      const len = (win.document.getElementById('root')?.textContent || '').length;
      if (len === last) { if (++busy >= 4) return; } else { busy = 0; last = len; }
      await wait(25);
    }
  };
  /** Poll the condition the assertion is actually about — the only wait that is
   *  right both when a provider answers in 40ms (a runner with egress) and when it
   *  is refused instantly (this sandbox). */
  const settleUntil = async (cond, maxMs = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try { if (cond()) return true; } catch { /* not mounted yet */ }
      await new Promise((r) => setTimeout(r, 30));
    }
    try { return Boolean(cond()); } catch { return false; }
  };

  const mountAt = async (route, { token, user } = {}) => {
    win.eval('if (globalThis.__root) { try { globalThis.__root.unmount(); } catch (e) {} } document.getElementById("root").innerHTML = ""');
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


  console.log('\n— the model picker (topbar, any provider, any id) —');
  await mountAt('/', { token: reg.token, user: reg.user });
  ok('the picker lives in the topbar', Boolean(q('#root .mp-trigger')), 'no .mp-trigger');
  ok('the old hardcoded select is gone', !q('#root .topbar select'), 'a <select> is still in the topbar');
  const triggerText = () => (q('#root .mp-trigger .mp-cur')?.textContent || '').trim();
  ok('it shows the current model by name', triggerText().length > 2 && !/undefined/.test(triggerText()), triggerText());
  click(q('#root .mp-trigger'));
  await settle(6);
  ok('the modal opens on "My keys"', Boolean(q('#root .mp-modal')) && qa('#root .mp-tab')[0].textContent === 'My keys');
  ok('a key-less account still gets the offline model', qa('#root [data-mp-row]').length >= 1, `${qa('#root [data-mp-row]').length} rows`);
  click(qa('#root .mp-tab')[1]);
  await settle(4);
  const allRows = qa('#root [data-mp-row]').length;
  ok('"All providers" lists the whole catalog', allRows > 150, `${allRows} rows`);
  typeIn(q('#root .mp-tools input'), 'deepseek');
  await settle(4);
  const found = qa('#root [data-mp-row]');
  ok('search narrows to matching models', found.length > 0 && found.length < allRows && found.every((el) => /deepseek/i.test(el.textContent)), `${found.length} rows`);
  click(found[0]);
  await settle(6);
  const pickedRef = String(win.eval('localStorage.getItem("acx_model")'));
  ok('clicking a row sets the app model', /::.*deepseek/i.test(pickedRef), pickedRef);
  ok('the picker closes after choosing', !q('#root .mp-modal'));
  ok('the trigger now names that model', triggerText().length > 2 && /deepseek/i.test(triggerText()), triggerText());
  ok('it is remembered for next time', String(win.eval('localStorage.getItem("acx_model_recent")')).includes(pickedRef));
  click(q('#root .mp-trigger'));
  await settle(4);
  typeIn(q('#root .mp-custom input'), 'vendor/totally-new-2027-model');
  await settle(2);
  click(qa('#root .mp-custom button').find((b) => b.textContent.trim() === 'Use'));
  await settle(6);
  ok('any id you type is usable', String(win.eval('localStorage.getItem("acx_model")')) === 'nvidia::vendor/totally-new-2027-model', String(win.eval('localStorage.getItem("acx_model")')));
  ok('the trigger falls back to the raw id', triggerText() === 'vendor/totally-new-2027-model', triggerText());
  click(q('#root .mp-trigger'));
  await settle(3);
  keydown(q('#root .mp'), 'Escape');
  await settle(3);
  ok('Esc closes it', !q('#root .mp-modal'));

  console.log('\n— pasting a key in Settings is an account write —');
  bridgeCalls.length = 0;
  await mountAt('/settings', { token: reg.token, user: reg.user });
  const cards = qa('#root .mcp-grid > *');
  ok('provider cards render', cards.length > 5, `${cards.length} cards`);
  const nvCard = cards.find((c) => /NVIDIA|build.nvidia/i.test(c.textContent));
  ok('the NVIDIA row is there', Boolean(nvCard));
  const beforeCfg = await (await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'config', token: reg.token }) })).json();
  const nvBefore = (beforeCfg.providers || []).find((p) => p.id === 'nvidia');
  typeIn(nvCard.querySelector('input[type=password]'), 'nvapi-mount-test-key-000111222');
  await settle(2);
  click([...nvCard.querySelectorAll('button')].find((b) => /Save key/i.test(b.textContent)));
  await settle(14);
  ok('the save writes to the account, not to server config', bridgeCalls.some((c) => c.action === 'user_keys' && c.key_env === 'NVIDIA_API_KEY'), JSON.stringify(bridgeCalls.map((c) => c.action)));
  ok('the global admin-only action is never called from a user page', !bridgeCalls.some((c) => c.action === 'save_provider_key'), JSON.stringify(bridgeCalls.map((c) => c.action)));
  ok('the toast reports where it landed', /Saved to/i.test(win.document.getElementById('root').textContent), win.document.querySelector('.toast')?.textContent || 'no toast node');
  const afterCfg = await (await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'config', token: reg.token }) })).json();
  const nvAfter = (afterCfg.providers || []).find((p) => p.id === 'nvidia');
  ok('the server now calls nvidia configured for this account', nvAfter?.configured === true && nvAfter?.key_owner === 'you', JSON.stringify(nvAfter));
  ok('and it was not configured before', nvBefore?.configured === false, JSON.stringify(nvBefore));
  ok('a row carries real model ids for the menu', (nvAfter?.models || []).length > 3
    && nvAfter.models.every((m) => typeof (m.id || m) === 'string' && (m.id || m) !== 'default'), JSON.stringify((nvAfter?.models || []).slice(0, 2)));
  ok("someone else's account is untouched by it", await (async () => {
    const stranger = await (await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'register', email: `stranger${Date.now()}@gmail.com`, password: 'strangerpass1', name: 'Stranger' }) })).json();
    const otherCfg = await (await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'config', token: stranger.token }) })).json();
    const p = (otherCfg.providers || []).find((x) => x.id === 'nvidia');
    // 'shared' (the built-in default) is fine — what must never happen is the
    // mount test's key showing up as somebody else's, or their view changing.
    return p?.key_owner !== 'you';
  })());

  console.log('\n— a provider failure is explained, not swallowed —');
  await mountAt('/', { token: reg.token, user: reg.user });
  win.eval(`localStorage.setItem('acx_model', 'nvidia::moonshotai/kimi-k2')`);
  await mountAt('/', { token: reg.token, user: reg.user });
  const box = q('#root .composer textarea');
  ok('the composer is present', Boolean(box));
  typeIn(box, 'hello from the mount test');
  await settle(2);
  click(q('#root .send-btn'));
  await settle(60);
  const msgs = qa('#root .msg-row.assistant .msg-text').map((el) => el.textContent);
  ok('the user message is kept even when the reply fails', /hello from the mount test/.test(win.document.getElementById('root').textContent));
  const last = msgs[msgs.length - 1] || '';
  ok('the reply is not a blank bubble', last.length > 8, JSON.stringify(msgs));
  ok('a broken key says so instead of a bare error', /nvidia|API key|reach/i.test(last), last.slice(0, 160));
  ok('and points at the fix', Boolean(q('#root .msg-fix a[href="/settings"]')), q('#root .msg-fix')?.outerHTML?.slice(0, 160) || 'no .msg-fix row');
  await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'user_keys', op: 'delete', token: reg.token, key_env: 'NVIDIA_API_KEY' }) });


  console.log('\n— the card proves the key, the picker proves the ids —');
  bridgeCalls.length = 0;
  await mountAt('/settings', { token: reg.token, user: reg.user });
  {
    const cards2 = qa('#root .mcp-grid > *');
    const nv = cards2.find((c) => /NVIDIA|build.nvidia/i.test(c.textContent));
    typeIn(nv.querySelector('input[type=password]'), 'nvapi-verification-key-999');
    await settle(2);
    click([...nv.querySelectorAll('button')].find((b) => /Save key/i.test(b.textContent)));
    // Wait for the probe to ANSWER, not for a number of milliseconds: whether the
    // provider is reachable depends on where the test runs, and the in-flight text
    // ("checking it against the provider…") is not a verdict. The line is queried
    // through the card each poll — React creates the node, so holding a reference
    // from before the click would pin a null forever.
    const verdictLine = () => nv.querySelector('.pc-verdict');
    await settleUntil(() => /[✓✗⚠]/.test(verdictLine()?.textContent || ''));
    const verdict = verdictLine();
    const order = bridgeCalls.map((c) => c.action);
    ok('saving a key immediately probes the provider', order.lastIndexOf('test_endpoint') > order.lastIndexOf('user_keys'), JSON.stringify(order));
    ok('the card reports a verdict, never a bare "saved"', Boolean(verdict) && !/key saved$/i.test(verdict.textContent || ''), verdict?.textContent || 'no .pc-verdict node');
    // What must hold is that the sentence matches the class — not which one it ends
    // up being. A sandbox with no outbound access proves "this server could not
    // reach the provider"; a runner with egress proves "the provider refused this
    // key". Both are honest verdicts; "✓ key saved" with either, or a network
    // problem dressed up as a bad key, is the bug. Pinning the wording instead of
    // the agreement is how this assertion went red on CI for the right reason.
    {
      const cls = [...(verdict?.classList || [])].join(' ');
      const txt = verdict?.textContent || '';
      const networkLimit = /\bnet\b/.test(cls) && /could not reach|network limit|not a bad key/i.test(txt);
      const keyRefused = /\bbad\b/.test(cls) && /rejected|authorization failed|invalid|incorrect api key|401|403/i.test(txt);
      const keyWorks = /\bok\b/.test(cls) && /accepted|models|answered/i.test(txt);
      ok('the verdict sentence and the verdict colour agree about what was proved',
        Boolean(networkLimit || keyRefused || keyWorks), `class="${cls}" text=${txt.slice(0, 160)}`);
      ok('and a verdict is never the bare "saved" the app used to print',
        !/^(✓|✗)?\s*(key )?saved\b/i.test(txt.trim()) && !/storing your key|checking it against/i.test(txt), txt.slice(0, 120));
    }
    ok('the verdict line is colour-coded by what it proved', /net|bad|ok/.test([...(verdict?.classList || [])].join(' ')), [...(verdict?.classList || [])].join(' '));
    // This line comes from the config re-pull that follows a successful save, not
    // from the probe itself — so it is its own condition, not a shared sleep.
    await settleUntil(() => /ids from the built-in catalog|ids confirmed by the endpoint/.test(nv.textContent));
    ok('and the card states where its model ids came from', /ids from the built-in catalog|ids confirmed by the endpoint/.test(nv.textContent), nv.textContent.slice(-200));
  }

  console.log('\n— a model list that says what is proven —');
  modelsStub = {
    picker: {
      total_models: 2, configured: 1,
      providers: [{
        id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai', configured: true, key_env: 'NVIDIA_API_KEY',
        verified: true, models_dynamic: true, endpoint: 'https://integrate.api.nvidia.com/v1',
        models: [
          { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1', reasoning: true, live: true },
          { id: 'nvidia/some-2027-guess', label: 'Nemotron Future 900B', live: false, unverified: true }
        ]
      }]
    }
  };
  win.eval('localStorage.removeItem("acx_model_index")');
  win.eval('localStorage.setItem("acx_model", "nvidia::nvidia/some-2027-guess")');
  await mountAt('/', { token: reg.token, user: reg.user });
  click(q('#root .mp-trigger'));
  await settle(10);
  ok('ids the endpoint listed are marked as proven', qa('#root .mp-live').length >= 1, `${qa('#root .mp-live').length} live marks`);
  ok('catalog guesses are marked as unproven, not hidden', qa('#root .mp-unver').length >= 1, `${qa('#root .mp-unver').length} unverified marks`);
  ok('the group header says where the ids came from', /from this endpoint/.test(q('#root .mp-ghead')?.textContent || ''), q('#root .mp-ghead')?.textContent);
  ok('a proven id sorts before a guessed one', (qa('#root [data-mp-row]')[0]?.textContent || '').includes('DeepSeek R1'), qa('#root [data-mp-row]')[0]?.textContent);
  ok('the trigger names the model from the same index', /Nemotron Future 900B/.test(triggerText()), triggerText());
  modelsStub = null;

  console.log('\n— when even the retry cannot help, the reply offers a way out —');
  win.eval('localStorage.removeItem("acx_model_index")');
  chatStub = {
    ok: false, fix: 'model', verdict: 'model', provider: 'nvidia', model: 'nvidia/some-2027-guess',
    error: 'NVIDIA NIM has no model called "nvidia/some-2027-guess". Pick another model in the picker (or Sync models for the live list).',
    model_picker: true,
    fallback: [{ id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1' }, { id: 'nvidia/nemotron-3-nano-30b-a3b', label: 'Nemotron 3 Nano 30B A3B' }]
  };
  await mountAt('/', { token: reg.token, user: reg.user });
  typeIn(q('#root .composer textarea'), 'use the model that exists');
  await settle(2);
  click(q('#root .send-btn'));
  await settle(24);
  const opts = qa('#root .msg-fix-option');
  ok('the failed reply lists models the endpoint really serves', opts.length === 2, JSON.stringify(opts.map((b) => b.textContent)));
  click(opts[0]);
  await settle(8);
  ok('one click switches to a real model', String(win.eval('localStorage.getItem("acx_model")')) === 'nvidia::deepseek-ai/deepseek-r1', String(win.eval('localStorage.getItem("acx_model")')));
  ok('the trigger follows the switch', /DeepSeek R1/.test(triggerText()), triggerText());
  // The index is a cache the app throws away on purpose (a rejected id clears it
  // so the menu re-reads). Losing it must not rename the model back to its raw id
  // in the top bar — the reply already said what this id is called.
  ok('the name it was given is remembered, not only the id',
    /DeepSeek R1/.test(String(win.eval('localStorage.getItem("acx_model_labels")||""'))),
    String(win.eval('localStorage.getItem("acx_model_labels")||""')).slice(0, 120));
  win.eval('localStorage.removeItem("acx_model_index")');
  await mountAt('/', { token: reg.token, user: reg.user });
  ok('and survives the index cache being dropped', /DeepSeek R1/.test(triggerText()), triggerText());
  chatStub = null;

  console.log('\n— model output cannot become markup —');
  {
    const { renderMarkdown } = await import('../web/src/lib/markdown.js');
    const html = (md) => renderMarkdown(md);
    ok('an injected img keeps nothing but a dead src', /src="#"/.test(html('<img src=x onerror=alert(1)>')), html('<img src=x onerror=alert(1)>'));
    ok('…and no event handler survives it', !/onerror=/i.test(html('<img src=x onerror=alert(1)>')));
    ok('…an onclick on a real link is dropped', !/onclick/i.test(html('<a href="https://ok.example" onclick="x()">ok</a>')));
    ok('a script tag is escaped', !/<script/i.test(html('<script>alert(1)</script>')));
    ok('an svg payload is escaped too', !/<svg/i.test(html('<svg onload=alert(1)>')));
    ok('a javascript: link goes nowhere', /href="#"/.test(html('[click](javascript:alert(1))')), html('[click](javascript:alert(1))'));
    ok('a data: image goes nowhere', !/src="data:/i.test(html('![x](data:text/html;base64,AAA)')));
    ok('real markdown still renders', /<strong>bold<\/strong>/.test(html('**bold**')) && /<blockquote>/.test(html('> quoted')));
    ok('a code block keeps its angle brackets as text', /&lt;div&gt;/.test(html('```\n<div>\n```')), html('```\n<div>\n```'));
  }

  console.log('\n— the speed dial, and what the model thought —');
  {
    bridgeCalls.length = 0;
    chatStub = { ok: true, text: 'The answer.', model: 'nvidia/deepseek-r1', reasoning: 'First I read the question, then I answered it.', thinking_ms: 1200 };
    await mountAt('/', { token: reg.token, user: reg.user });
    const dial = qa('#root .effort-btn');
    ok('the topbar offers three speeds', dial.length === 3, `${dial.length} buttons`);
    ok('…and starts on Balanced', dial.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent === 'Balanced', dial.map((b) => b.textContent).join(','));
    click(dial.find((b) => b.textContent === 'Max'));
    await settle(2);
    ok('choosing one is remembered', String(win.eval('localStorage.getItem("acx_effort")')) === 'max', String(win.eval('localStorage.getItem("acx_effort")')));

    typeIn(q('#root .composer textarea'), 'think about this');
    await settle(2);
    click(q('#root .send-btn'));
    await settle(24);
    const sent = bridgeCalls.filter((c) => c.action === 'chat_stream').at(-1);
    ok('the choice goes out with the message', sent?.effort === 'max', JSON.stringify(sent?.effort));
    const think = q('#root .think');
    ok('the reasoning is kept with the answer', Boolean(think) && /Thought for/.test(think.textContent), think?.textContent || 'no .think block');
    ok('…and the answer itself is unchanged', /The answer\./.test(q('#root .msg-row.assistant .msg-text')?.textContent || ''));
    click(think.querySelector('.think-head'));
    await settle(3);
    ok('expanding it shows what it actually thought', /First I read the question/.test(q('#root .think-body')?.textContent || ''), q('#root .think-body')?.textContent || 'no body');
    win.eval('localStorage.setItem("acx_effort", "balanced")');
    chatStub = null;
  }

  console.log('\n— the sandbox page —');
  {
    const text = await mountAt('/sandbox', { token: reg.token, user: reg.user });
    ok('the page renders', /Sandbox/.test(text) && /Run/.test(text), text.slice(0, 120));
    ok('it says what it will run', /JavaScript/.test(text) && /Python/.test(text));
    ok('…and what it will not do', /not a container|only for the person sitting/i.test(text), text.slice(-200));
  }

  console.log('\n— the Qoder page —');
  {
    const text = await mountAt('/qoder', { token: reg.token, user: reg.user });
    ok('the page renders', /Qoder/.test(text) && /49 repositories/i.test(text), text.slice(0, 140));
    ok('it says where the key goes, not the key itself', /QODER_PAT/.test(text) && !/qpat_/.test(text), text.slice(0, 200));
    ok('the atlas is on screen', /integrated/.test(text) && /better-harness/.test(text), text.slice(-260));
    ok('the local agent panel explains ACP', /qodercli --acp/.test(text), text.slice(-260));
  }

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
