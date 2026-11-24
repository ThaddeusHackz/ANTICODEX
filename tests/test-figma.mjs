// /imp — Figma → design tokens. No network: parseFigmaRef, tokensFromFile,
// the artifact builders and readFigmaFile (with an injected fetch) are all pure
// enough to assert on, and the bridge action is exercised against a live server
// with no token configured, because "refuses with a fix" is the behaviour that
// matters most when the token is missing.
process.env.ANTICODEX_DATA = new URL('./.tmp-figma-data', import.meta.url).pathname;
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const { parseFigmaRef, tokensFromFile, buildTokensJson, buildTokensCss, buildDesignBrief, buildArtifacts, readFigmaFile, hexOf, luminance, sourceRef } = await import('../lib/figma.js');

let p = 0, f = 0;
const ok = (n, c, x) => { if (c) { p++; console.log('  + ' + n); } else { f++; console.log('  FAIL ' + n + ' ' + (x || '')); } };

console.log('--- parseFigmaRef: a link, a key, or a refusal ---');
{
  const r = parseFigmaRef('https://www.figma.com/design/CMniAtkBVTE0mPTwYnvg23/Design-System?node-id=12-34&t=x');
  ok('design URL yields the key', r.ok && r.file_key === 'CMniAtkBVTE0mPTwYnvg23', JSON.stringify(r));
  ok('node-id is converted to the colon form', r.node_id === '12:34', r.node_id);
  ok('/file/ URLs also parse', parseFigmaRef('https://figma.com/file/AbCdEf123456789x/Foo').file_key === 'AbCdEf123456789x');
  ok('a bare key parses', parseFigmaRef('CMniAtkBVTE0mPTwYnvg23').ok === true);
  ok('a team URL is refused (nothing to import)', parseFigmaRef('https://www.figma.com/files/team/123/Team').ok === false);
  ok('a community post is refused', parseFigmaRef('https://www.figma.com/community/file/123/template').ok === false);
  ok('a non-figma host is named in the error', /not figma\.com/.test(parseFigmaRef('https://evil.example/design/abc').error));
  ok('empty input has a fix', parseFigmaRef('').ok === false && /Paste a Figma link/.test(parseFigmaRef('').fix));
  ok('a too-short token is refused', parseFigmaRef('abc').ok === false);
}

console.log('--- hexOf / luminance ---');
ok('white maps to #FFFFFF', hexOf({ r: 1, g: 1, b: 1 }).hex === '#FFFFFF');
ok('paint opacity multiplies colour alpha', hexOf({ r: 0, g: 0, b: 0, a: 0.5 }, 0.5).alpha === 0.25);
ok('black is darker than white', luminance('#000000') < luminance('#FFFFFF'));

// A miniature but honest file: a page, a frame with padding, a component, an
// instance of it, text with a published style, a shadow, radii, and a gradient
// that must NOT become a token.
const FILE = {
  name: 'Acme DS', lastModified: '2026-11-01T10:00:00Z', version: '111', editorType: 'figma',
  styles: { S1: { name: 'brand/primary', styleType: 'FILL' }, S2: { name: 'text/body', styleType: 'TEXT' } },
  components: { C1: { name: 'Button' } },
  componentSets: {},
  document: {
    id: '0:0', type: 'DOCUMENT', children: [{
      id: '0:1', type: 'PAGE', name: 'Screens', children: [{
        id: '1:1', type: 'FRAME', name: 'Home', paddingLeft: 16, paddingRight: 16, paddingTop: 24, itemSpacing: 8,
        children: [
          { id: '1:2', type: 'COMPONENT', name: 'Button/Primary', cornerRadius: 8, fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.3, b: 0.9 } , boundVariables: { color: { id: 'S1' } } }] },
          { id: '1:3', type: 'INSTANCE', name: 'Button/Primary' },
          { id: '1:4', type: 'INSTANCE', name: 'Button/Primary' },
          { id: '1:5', type: 'TEXT', name: 'Title', characters: 'Welcome',
            style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 32, lineHeightPx: 40 }, styles: { text: 'S2' } },
          { id: '1:6', type: 'TEXT', name: 'Chip', characters: 'beta',
            style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 32, lineHeightPx: 40 } },
          { id: '1:7', type: 'RECTANGLE', name: 'Card', cornerRadius: 12,
            effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true }],
            fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [] }, { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, visible: false }] },
          { id: '1:8', type: 'RECTANGLE', name: 'Ghost', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }
        ]
      }]
    }]
  }
};

console.log('--- tokensFromFile: read what the file says ---');
const tokens = tokensFromFile(FILE);
{
  ok('file name + version carried', tokens.file.name === 'Acme DS' && tokens.file.version === '111');
  ok('pages listed', tokens.pages.length === 1 && tokens.pages[0] === 'Screens');
  ok('node count is the whole tree', tokens.counts.nodes === 10, String(tokens.counts.nodes));
  ok('text nodes counted', tokens.counts.text_nodes === 2);
  const brand = tokens.colors.find((c) => c.hex === '#334CD6' || c.hex.startsWith('#33'));
  ok('a solid fill becomes a colour token', Boolean(brand), JSON.stringify(tokens.colors.map((c) => c.hex)));
  ok('the bound style name travels with the token', Boolean(tokens.colors.find((c) => c.name === 'brand/primary')));
  ok('a gradient is not flattened into a colour token', !tokens.colors.some((c) => c.hex === '#FF0000'));
  ok('a hidden paint is ignored', tokens.colors.filter((c) => c.hex === '#FFFFFF').length === 1, JSON.stringify(tokens.colors));
  ok('fills in use are counted', tokens.colors.find((c) => c.name === 'brand/primary').uses === 1);

  const h1 = tokens.typography.find((t) => t.size === 32);
  ok('type ramp keeps family/weight/size', h1 && h1.family === 'Inter' && h1.weight === 700 && h1.size === 32);
  ok('two identical text styles merge with uses=2', h1.uses === 2, String(h1.uses));
  ok('published text style name kept', h1.name === 'text/body');
  ok('line height kept', h1.lineHeight === 40);

  ok('spacing from padding + gap, sorted', JSON.stringify(tokens.spacing) === '[8,16,24]', JSON.stringify(tokens.spacing));
  ok('radii sorted and deduped', JSON.stringify(tokens.radii) === '[8,12]', JSON.stringify(tokens.radii));
  ok('shadow becomes a css value', tokens.shadows.length === 1 && /0px 4px 12px 0px #00000040/.test(tokens.shadows[0]), tokens.shadows[0]);

  const btn = tokens.components.find((c) => c.name === 'Button/Primary');
  ok('component + its instances are one row', btn && btn.kind === 'component' && btn.instances === 2, JSON.stringify(tokens.components));
  ok('frames recorded', tokens.frames.includes('Home'));
  ok('not truncated on a small file', tokens.truncated.walk === false);
}

console.log('--- the cap is reported, never silent ---');
{
  const big = { name: 'big', document: { type: 'DOCUMENT', children: [{ type: 'PAGE', name: 'p', children: Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, type: 'RECTANGLE', name: 'r' + i, fills: [{ type: 'SOLID', color: { r: i / 40, g: 0, b: 0 } }] })) }] } };
  const t = tokensFromFile(big, { maxNodes: 10 });
  ok('walk cap is flagged', t.truncated.walk === true && /10 nodes/.test(t.truncated.horizon));
  ok('cap stops the walk at the limit', t.counts.nodes === 10, String(t.counts.nodes));
  const many = { name: 'many', document: { type: 'DOCUMENT', children: [{ type: 'PAGE', name: 'p', children: Array.from({ length: 20 }, (_, i) => ({ id: 'n' + i, type: 'RECTANGLE', name: 'r' + i, fills: [{ type: 'SOLID', color: { r: i / 30, g: 1 / 30, b: 0 } }] })) }] } };
  const t2 = tokensFromFile(many, { limits: { colors: 5 } });
  ok('colour overflow is counted', t2.colors.length === 5 && t2.truncated.colors === 15, JSON.stringify(t2.truncated));
  ok('duplicate slugs get their hex appended', new Set(t2.colors.map((c) => c.token)).size === t2.colors.length);
}

console.log('--- artifacts ---');
{
  const json = buildTokensJson(tokens, { fileKey: 'K1', url: 'https://www.figma.com/design/K1' });
  ok('tokens.json cites its source', json.$source.file_key === 'K1' && json.$source.version === '111');
  ok('colour tokens are keyed by token name', Object.keys(json.color).some((k) => k.startsWith('color-')));
  ok('spacing becomes space-N', Object.keys(json.space).includes('space-16'));
  ok('shadow keys exist', Object.keys(json.shadow).length === 1);
  ok('component keys exist', Object.keys(json.component).includes('button-primary'));
  const css = buildTokensCss(tokens, { fileKey: 'K1' });
  ok('css declares :root', css.includes(':root {') && css.trim().endsWith('}'));
  ok('css carries the file key + name', css.includes('K1') && css.includes('Acme DS'));
  ok('css values are lowercase hex', !/#[0-9a-f]{0,5}[A-F]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  const brief = buildDesignBrief({ fileKey: 'K1', url: 'https://www.figma.com/design/K1', tokens, sections: { comments: 'Figma returned 403: needs file_comments:read' } });
  ok('brief names the file and key', brief.includes('# Acme DS') && brief.includes('K1'));
  ok('brief says it is REST, not Dev Mode MCP', /not\*\* the Dev Mode MCP/.test(brief));
  ok('brief tables the colours', brief.includes('| `--') && brief.includes('| token | value | uses |'));
  ok('brief reports the unreadable section instead of hiding it', brief.includes('Sections that could not be read') && brief.includes('file_comments:read'));
  ok('brief does not claim Code Connect', /Code Connect mappings are not included/.test(brief));
  const arts = buildArtifacts({ fileKey: 'K1', tokens, sections: {} });
  ok('three artifacts, brief first', arts.length === 3 && arts[0].path === '.figma/design-brief.md' && arts[2].path === '.figma/tokens.css');
  ok('every artifact has content', arts.every((a) => a.content.length > 50));
  ok('sourceRef changes with the version', sourceRef({ file_key: 'K1', version: '1' }) !== sourceRef({ file_key: 'K1', version: '2' }));
}

console.log('--- readFigmaFile: request shape + honest failures (injected fetch) ---');
{
  const calls = [];
  const fake = (status, body) => async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const noTok = await readFigmaFile({ fileKey: 'K1', token: '' });
  ok('no token is a refusal with a fix', noTok.ok === false && noTok.needs_token === true && /file_content:read/.test(noTok.fix));

  const r = await readFigmaFile({ fileKey: 'K1', token: 'fig-secret', fetchImpl: fake(200, FILE) });
  ok('reads the file and tokenises it', r.ok === true && r.tokens.colors.length > 0);
  ok('sends the token as X-Figma-Token, never in the URL', calls[0].opts.headers['X-Figma-Token'] === 'fig-secret' && !calls[0].url.includes('fig-secret'));
  ok('hits the documented endpoint', calls[0].url === 'https://api.figma.com/v1/files/K1');
  ok('comments + library were attempted', calls.some((c) => c.url.endsWith('/comments')) && calls.some((c) => c.url.endsWith('/components')));
  ok('a 200 with no comments array still succeeds', r.ok === true && Array.isArray(r.comments));
  ok('the token is never echoed into the result', !JSON.stringify(r).includes('fig-secret'));

  calls.length = 0;
  const forbidden = await readFigmaFile({
    fileKey: 'K1', token: 'x',
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (/\/files\/K1(\?|$)/.test(String(url))) return { ok: true, status: 200, text: async () => JSON.stringify(FILE) };
      return { ok: false, status: 403, text: async () => JSON.stringify({ err: 'Invalid scope' }) };
    }
  });
  ok('403 on comments does not fail the import', forbidden.ok === true);
  ok('403 is explained as a scope problem', /missing a scope/.test(forbidden.sections.comments));
  ok('403 on library is reported separately', /scope/.test(forbidden.sections.library));

  const nf = await readFigmaFile({ fileKey: 'NOPE', token: 'x', fetchImpl: fake(404, { err: 'not found' }) });
  ok('404 explains the key, not the network', nf.ok === false && /no file with that key/.test(nf.error));

  const rl = await readFigmaFile({ fileKey: 'K1', token: 'x', fetchImpl: fake(429, {}) });
  ok('429 says to wait', rl.ok === false && /rate-limited/.test(rl.error));

  const bad = await readFigmaFile({ fileKey: 'K1', token: 'x', fetchImpl: fake(200, { name: 'x' }) });
  ok('a body with no document is refused, not reported empty', bad.ok === false && /without a document/.test(bad.error));
}

// --- the bridge action against a real server ------------------------------
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); }); }

console.log('--- bridge: figma status / import ---');
{
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FIGMA_TOKEN$/.test(k)));
  const server = spawn('node', ['server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...cleanEnv, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', ANTICODEX_LOCAL: '1', ANTICODEX_DATA: process.env.ANTICODEX_DATA },
    stdio: 'ignore'
  });
  const api = async (payload) => {
    const res = await fetch(`${BASE}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await api({ action: 'health' }); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ok('server booted', up);
  try {
    let r = await api({ action: 'figma', op: 'status' });
    ok('status with no token: configured=false and a fix', r.status === 200 && r.data.configured === false && /FIGMA_TOKEN/.test(r.data.fix));
    ok('status does not leak a token field', !('token' in r.data) && !JSON.stringify(r.data).includes('fig-'));

    r = await api({ action: 'figma', op: 'import', ref: 'https://www.figma.com/files/team/1/Team' });
    ok('a team link is a 400 with the reason', r.status === 400 && /does not name a file/.test(r.data.error));

    r = await api({ action: 'figma', op: 'import', ref: 'CMniAtkBVTE0mPTwYnvg23' });
    ok('a real key with no token refuses with needs_token', r.status === 200 && r.data.ok === false && r.data.needs_token === true);
    ok('the refusal names the scope', /file_content:read/.test(r.data.fix));

    r = await api({ action: 'figma', op: 'nope' });
    ok('unknown op is a 400', r.status === 400);
  } finally {
    server.kill('SIGTERM');
  }
}

console.log(p + ' passed, ' + f + ' failed');
try { fs.rmSync(process.env.ANTICODEX_DATA, { recursive: true, force: true }); } catch { /* tmp */ }
process.exit(f ? 1 : 0);
