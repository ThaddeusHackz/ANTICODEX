// PWA / iOS-installability contract: manifest, meta tags, real icon files with
// verified IHDR dimensions, the service worker's /api/* exclusion, and the
// conditional registration in the web entry. Asserts on real files in
// web/public and the built web/dist — a stale bundle fails here on purpose.
//
// Run: node tests/test-pwa.mjs   (needs `npm run build` first for the dist section)

import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pub = path.join(root, 'web', 'public');
const dist = path.join(root, 'web', 'dist');
let passed = 0, failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

// Read width/height straight from the PNG IHDR chunk — never trust a filename.
function pngDims(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24) return null;
  const sig = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!sig || buf.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

console.log('\n— manifest.webmanifest (web/public) —');
const manifestPath = path.join(pub, 'manifest.webmanifest');
ok('manifest exists', exists(manifestPath));
let m = null;
try { m = JSON.parse(read(manifestPath)); } catch { /* asserted below */ }
ok('manifest parses as JSON', !!m);
if (m) {
  ok('name is ANTICODEX', m.name === 'ANTICODEX');
  ok('short_name is ANTICODEX', m.short_name === 'ANTICODEX');
  ok('start_url is /', m.start_url === '/');
  ok('scope is /', m.scope === '/');
  ok('display is standalone', m.display === 'standalone');
  // Colors must be the real tokens from styles.css, not invented hexes.
  const css = read(path.join(root, 'web', 'src', 'styles.css'));
  const bg = (css.match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  const accent = (css.match(/--accent:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  ok(`background_color matches --bg (${bg})`, !!bg && m.background_color.toLowerCase() === bg.toLowerCase());
  ok(`theme_color matches --accent (${accent})`, !!accent && m.theme_color.toLowerCase() === accent.toLowerCase());
  const icons = Array.isArray(m.icons) ? m.icons : [];
  const at = (s) => icons.find((i) => i.sizes === s && !i.purpose);
  ok('icons: 192x192 entry', !!at('192x192'));
  ok('icons: 512x512 entry', !!at('512x512'));
  ok('icons: 512x512 maskable entry', !!icons.find((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  ok('every icon src is an absolute path that exists in public/',
    icons.length > 0 && icons.every((i) => i.src.startsWith('/') && exists(path.join(pub, i.src))));
}

console.log('\n— index.html installability tags (source and built) —');
for (const [label, file] of [['web/index.html', path.join(root, 'web', 'index.html')],
                             ['dist/index.html', path.join(dist, 'index.html')]]) {
  if (!exists(file)) { ok(`${label} exists (run \`npm run build\`)`, false); continue; }
  const html = read(file);
  ok(`${label}: links the manifest`, /<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/.test(html));
  ok(`${label}: theme-color meta`, /<meta[^>]*name="theme-color"[^>]*content="#[0-9a-fA-F]{6}"/.test(html));
  ok(`${label}: apple-touch-icon link`, /<link[^>]*rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/.test(html));
  ok(`${label}: apple-mobile-web-app-capable=Yes`, /<meta[^>]*name="apple-mobile-web-app-capable"[^>]*content="Yes"/i.test(html));
  ok(`${label}: status-bar-style=black-translucent`, /<meta[^>]*name="apple-mobile-web-app-status-bar-style"[^>]*content="black-translucent"/.test(html));
  ok(`${label}: apple-mobile-web-app-title`, /<meta[^>]*name="apple-mobile-web-app-title"[^>]*content="ANTICODEX"/.test(html));
  ok(`${label}: viewport-fit=cover`, /name="viewport"[^>]*viewport-fit=cover/.test(html));
}

console.log('\n— icon files with verified IHDR dimensions (public and dist) —');
const EXPECT = {
  'icon-192.png': [192, 192],
  'icon-512.png': [512, 512],
  'icon-maskable-512.png': [512, 512],
  'apple-touch-icon.png': [180, 180],
};
for (const [dirLabel, dir] of [['web/public', pub], ['web/dist', dist]]) {
  for (const [name, [w, h]] of Object.entries(EXPECT)) {
    const file = path.join(dir, name);
    if (!exists(file)) { ok(`${dirLabel}/${name} exists${dirLabel === 'web/dist' ? ' (run \`npm run build\`)' : ''}`, false); continue; }
    const d = pngDims(file);
    ok(`${dirLabel}/${name} is a real ${w}x${h} PNG`, !!d && d.w === w && d.h === h, d ? `got ${d.w}x${d.h}` : 'bad PNG/IHDR');
  }
}

console.log('\n— service worker (web/public/sw.js and dist) —');
for (const [label, file] of [['public/sw.js', path.join(pub, 'sw.js')], ['dist/sw.js', path.join(dist, 'sw.js')]]) {
  if (!exists(file)) { ok(`${label} exists${label.startsWith('dist') ? ' (run \`npm run build\`)' : ''}`, false); continue; }
  const sw = read(file);
  ok(`${label}: never touches /api/* (early return before any caching)`,
    /pathname === '\/api'[\s\S]{0,80}startsWith\('\/api\/'\)/.test(sw) ||
    (/startsWith\('\/api\/'\)/.test(sw) && sw.indexOf('/api') < sw.indexOf('respondWith')));
  ok(`${label}: precaches the shell on install`, /addEventListener\('install'/.test(sw) && /'\/manifest\.webmanifest'/.test(sw) && /'\/index\.html'/.test(sw));
  ok(`${label}: network-first navigations with offline shell fallback`, /request\.mode === 'navigate'/.test(sw) && /caches\.match\(.*index\.html/.test(sw));
  ok(`${label}: stale-while-revalidate for static assets`, /stale-while-revalidate/i.test(sw) && /cache\.put\(request/.test(sw));
  ok(`${label}: activate cleans old caches`, /caches\.delete\(/.test(sw) && /k !== CACHE/.test(sw));
}

console.log('\n— registration is conditional (entry source + built bundle) —');
const entry = read(path.join(root, 'web', 'src', 'main.jsx'));
ok('registers /sw.js', /serviceWorker\.register\('\/sw\.js'\)/.test(entry));
ok('only in production builds (import.meta.env.PROD)', entry.includes('import.meta.env.PROD'));
ok('skips Electron by user-agent', entry.includes('Electron') && /navigator\.userAgent/.test(entry));
ok('skips Electron by the preload bridge flag (anticodexDesktop)', entry.includes('anticodexDesktop'));
ok('registration failure only console.warns', /console\.warn\(/.test(entry));
const regBlock = entry.slice(entry.indexOf('import.meta.env.PROD'));
ok('the guards precede the register() call', regBlock.includes('!inElectron') && regBlock.indexOf('import.meta.env.PROD') < entry.indexOf("serviceWorker.register"));
if (exists(path.join(dist, 'assets'))) {
  const js = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'))
    .map((f) => read(path.join(dist, 'assets', f))).join('\n');
  ok('built bundle registers /sw.js', js.includes('/sw.js') && js.includes('serviceWorker'));
  ok('built bundle keeps the desktop-bridge guard string', js.includes('anticodexDesktop'));
} else {
  ok('built assets exist for registration checks (run `npm run build`)', false);
}


// --- the install state machine ------------------------------------------------
// lib/pwa.js decides what the Install page is allowed to promise, and every branch
// depends on the user agent plus whether the browser fired `beforeinstallprompt`.
// It is pure enough to exercise directly, with a stubbed window.
console.log('\n— lib/pwa.js across browsers —');
{
  const { pathToFileURL } = await import('node:url');
  const store = new Map();
  const makeWin = ({ ua, standalone = false, touch = 0, search = '' }) => {
    const listeners = new Map();
    const win = {
      location: { search },
      navigator: { userAgent: ua, maxTouchPoints: touch, standalone },
      matchMedia: (q) => ({ matches: q.includes('standalone') ? standalone : false, addEventListener: () => {} }),
      addEventListener: (n, f) => listeners.set(n, f),
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
    };
    return { win, listeners };
  };
  const load = async ({ ua, standalone, touch, search }) => {
    const { win, listeners } = makeWin({ ua, standalone, touch, search });
    // The module reads window/navigator/document/localStorage at call time, so a
    // rebuild of the globals between cases is enough — no module cache reset needed.
    // Node exposes `navigator` as a getter-only global, so it is redefined rather
    // than assigned. The module reads it through `navigator` at call time.
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: win.localStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'matchMedia', { value: win.matchMedia, configurable: true, writable: true });
    const mod = await import(pathToFileURL(path.join(root, 'web', 'src', 'lib', 'pwa.js')).href + `?v=${Math.random()}`);
    return { mod, listeners, win };
  };

  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0';

  {
    const { mod } = await load({ ua: IOS });
    const st = mod.platformState();
    ok('iOS Safari is offered the two taps, not a prompt', st.can === 'ios-steps' && st.ios && st.safari && !st.promptable);
    ok('…and promptInstall says why there is nothing to click', (await mod.promptInstall()).outcome === 'unavailable');
  }
  {
    const { mod } = await load({ ua: IOS_CHROME });
    ok('Chrome on iOS is told to open Safari', mod.platformState().can === 'ios-other-browser');
  }
  {
    const { mod } = await load({ ua: ANDROID });
    ok('Chrome on Android awaits the browser prompt', mod.platformState().can === 'awaiting-prompt');
  }
  {
    const { mod, listeners } = await load({ ua: ANDROID });
    // Fire a fake beforeinstallprompt: the module must keep it and allow prompt().
    let prompted = 0;
    mod.watchInstallability();   // main.jsx does this before the first render
    const evt = { preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
    listeners.get('beforeinstallprompt')(evt);
    const st = mod.platformState();
    ok('…and becomes promptable the moment the event fires', st.can === 'prompt' && st.promptable);
    const r = await mod.promptInstall();
    ok('…prompt() is called exactly once', prompted === 1 && r.outcome === 'accepted');
    ok('…and the event is not reusable', !mod.platformState().promptable);
  }
  {
    const { mod, listeners } = await load({ ua: ANDROID });
    mod.watchInstallability();
    const evt = { preventDefault() {}, prompt() {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) };
    listeners.get('beforeinstallprompt')(evt);
    await mod.promptInstall();
    ok('a dismissed prompt is remembered', mod.platformState().dismissed === true);
    ok('…and can be cleared', (mod.clearDismiss(), mod.platformState().dismissed === false));
  }
  {
    const { mod } = await load({ ua: FIREFOX });
    ok('Firefox desktop is told plainly that it cannot install', mod.platformState().can === 'unsupported');
  }
  {
    const { mod } = await load({ ua: MAC_CHROME, standalone: true });
    ok('an installed app knows it is installed', mod.platformState().can === 'installed' && mod.isStandalone());
  }
  {
    const { mod } = await load({ ua: MAC_CHROME });
    ok('a Chromium desktop tab waits for the prompt', mod.platformState().can === 'awaiting-prompt' && !mod.platformState().installed);
  }
  // The page must be wired to it, and the state must be captured before first paint.
  const entry = read(path.join(root, 'web', 'src', 'main.jsx'));
  ok('installability is captured before React renders', entry.indexOf('watchInstallability()') < entry.indexOf('ReactDOM.createRoot'));
  const page = read(path.join(root, 'web', 'src', 'pages', 'Install.jsx'));
  ok('the Install page offers the real prompt where one exists', /promptInstall\(\)/.test(page) && /Install ANTICODEX/.test(page));
  ok('…the iOS two taps where it does not', /Add to Home Screen/.test(page));
  ok('…and says when the browser cannot install at all', /cannot install a web app/.test(page));
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
