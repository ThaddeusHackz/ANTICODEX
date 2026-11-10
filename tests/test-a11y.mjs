// Accessibility & interaction coverage across every page.
//
// Why a separate suite: the mount suite proves a page renders, the bundle suite
// proves it is styled, and neither can see whether a screen reader has anything to
// say. Two real bugs lived through both of them:
//
//   * `Field` rendered `<label>` with no `htmlFor` and a child with no `id` — 19
//     inputs across 19 pages looked labelled and were not;
//   * `Modal` had no `role="dialog"`, no Escape handler, and a ✕ with no name.
//
// Both were one-line fixes in `ui.jsx`, which is the point: the shared primitives
// are where this either gets fixed once or re-broken per page.
//
//   node tests/test-a11y.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web', 'src');
let passed = 0; let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) files.push(p);
  }
})(src);

const read = (p) => fs.readFileSync(path.join(src, p), 'utf8');
const all = files.map((f) => ({ name: path.relative(src, f), text: fs.readFileSync(f, 'utf8') }));
const ui = read('ui.jsx');
const css = read('styles.css');

/** Every `<input …/>` that has nothing to name it. */
function unlabelledInputs() {
  const out = [];
  for (const { name, text } of all) {
    for (const m of text.matchAll(/<input\b[\s\S]{0,400}?\/>/g)) {
      const tag = m[0];
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      // Labelled programmatically…
      if (/aria-label|aria-labelledby|placeholder|id=/.test(tag)) continue;
      // …by a <Field> parent, which injects the id via cloneElement…
      if (/<Field\b[^>]*>\s*$/.test(before)) continue;
      // …or implicitly, by being the only control inside a <label>.
      const open = before.lastIndexOf('<label');
      const close = before.lastIndexOf('</label>');
      if (open > close) continue;
      out.push(`${name}:${tag.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
  return out;
}

console.log('\n— labels —');
{
  const bad = unlabelledInputs();
  ok('every input has an accessible name', bad.length === 0, bad.slice(0, 4).join(' | '));

  // The components that make that true must keep doing it.
  ok('Field connects its label to the control', /<label htmlFor=\{id\}>/.test(ui) && /cloneElement\(children, \{ id/.test(ui));
  ok('…and carries the hint to the field too', /aria-describedby/.test(ui));
  ok('Switch exposes a name and a role', /role="switch"/.test(ui) && /aria-checked/.test(ui) && /aria-label=\{label\}/.test(ui));
  ok('Switch call sites that need a name pass one', (() => {
    const calls = [...ui.matchAll(/<Switch\b[^>]*>/g)].map((m) => m[0]);
    return calls.every((c) => /label=/.test(c));
  })());
}

console.log('\n— dialogs and live regions —');
{
  ok('Modal is a dialog', /role="dialog"/.test(ui) && /aria-modal="true"/.test(ui));
  ok('…named by its own title', /aria-labelledby=\{titleId\}/.test(ui) && /id=\{titleId\}/.test(ui));
  ok('…closes on Escape', /key === 'Escape'/.test(ui));
  ok('…returns focus to where it came from', /prev\.focus\(\)/.test(ui));
  ok('…and its ✕ is named', /aria-label="Close dialog"/.test(ui));
  // A toast that is never announced does not exist for a screen-reader user.
  ok('toasts are announced', /role="status"/.test(ui) && /aria-live="polite"/.test(ui));
  ok('decorative glyphs are hidden', /aria-hidden="true"/.test(ui));
}

console.log('\n— keyboard —');
{
  ok('there is a visible focus ring', /:focus-visible/.test(css));
  ok('…and it is offset so it does not sit on the border', /outline-offset/.test(css));
  // A div with an onClick is not reachable by Tab and cannot be activated by Enter
  // or Space; role + tabIndex is the minimum honest substitute for a button.
  const clickDivs = [];
  for (const { name, text } of all) {
    for (const m of text.matchAll(/<div\b/g)) {
      // Read to the closing `>` of THIS tag, tracking (), {} and "" so an arrow
      // function or a style object in the attributes does not end it early.
      let i = m.index + 4, depth = 0, quote = null, tag = '';
      for (; i < text.length; i++) {
        const c = text[i];
        tag += c;
        if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
        if (c === '"' || c === "'" ) { quote = c; continue; }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === '>' && depth === 0) break;
      }
      if (!/onClick=/.test(tag)) continue;
      if (/role="(button|option|tab|menuitem)"/.test(tag) && /tabIndex/.test(tag)) continue;
      // A click-away scrim is deliberately not a control: hidden from the tree and
      // closed by the Escape handler or the dialog's own button.
      if (/aria-hidden="true"/.test(tag) && /role="presentation"/.test(tag)) continue;
      if (/className="(scrim|modal-back)"/.test(tag) && /role="presentation"/.test(tag)) continue;
      clickDivs.push(`${name}: ${tag.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
  ok('clickable divs are real controls (role + tabIndex)', clickDivs.length === 0, clickDivs.slice(0, 3).join(' | '));
}

console.log('\n— semantics that were missing —');
{
  // A data table without <thead>/scope is a grid of text: a screen reader reads
  // each cell with no idea what column it belongs to.
  const headless = [];
  for (const { name, text } of all) {
    // Non-greedy to the real closing tag: a fixed character window reported tables
    // as headerless when the header simply sat further down.
    for (const m of text.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
      if (/<thead|scope=/.test(m[0])) continue;
      headless.push(name);
    }
  }
  ok('data tables have a header row (or explicit scope)', headless.length === 0, [...new Set(headless)].join(' '));

  // Images need alt text, and an empty alt is a deliberate choice ("decorative"),
  // not an omission — so the attribute must be present either way.
  const noAlt = [];
  for (const { name, text } of all) {
    // Strip comments first: an `<img>` shown as an example inside a comment is not
    // an element that ships, and flagging it trains people to ignore the check.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/<img\b[^>]*>/g)) if (!/\balt=/.test(m[0])) noAlt.push(name);
  }
  ok('every <img> declares alt (even if empty)', noAlt.length === 0, [...new Set(noAlt)].join(' '));
}


console.log('\n— ⌕Search spans every corpus —');
{
  const { searchEverything } = await import('../lib/search.js');

  const chats = [
    { id: 't1', title: 'Deploying the agent', messages: [{ content: 'the sandbox lost its ssh key' }] },
    { id: 't2', title: 'Weather widget', messages: [{ content: 'map tiles and a forecast' }] }
  ];
  const apis = { entries: [
    { id: 'open-meteo', name: 'Open Meteo', description: 'Free weather forecast API', category: 'Weather', auth: 'none', host: 'open-meteo.com' },
    { id: 'chempirical', name: 'Chempirical', description: 'Compounds with reactions', category: 'Science', auth: 'none', host: 'chempirical.com' }
  ] };
  const skills = { skills: [
    { id: 'react-dev', name: 'react-dev', description: 'Building React components', tags: ['react', 'ui'] },
    { id: 'unrelated', name: 'unrelated', description: 'nothing to do with it' }
  ] };
  const connectors = [{ id: 'playwright', name: 'Playwright', description: 'browser automation', tags: ['browser'] }];

  const all = searchEverything('weather', { chats, apis, skills, connectors });
  ok('a query finds results in more than one corpus', (all.groups || []).length >= 2, JSON.stringify(all.groups?.map((g) => g.label)));
  ok('…and reports what it searched', all.searched.apis === 2 && all.searched.chats === 2 && all.searched.skills === 2);

  const byId = Object.fromEntries((all.groups || []).map((g) => [g.id, g]));
  ok('the API is found by name, not just by category', byId.apis?.items.some((i) => i.title === 'Open Meteo'));
  ok('every hit knows where it lives', (all.groups || []).every((g) => g.items.every((i) => typeof i.to === 'string' && i.to.startsWith('/'))));

  // The ranking bug this was written for: "…reactions…" contains "react", and with
  // substring scoring three chemistry APIs outranked every React skill.
  const react = searchEverything('react', { apis, skills });
  const rg = Object.fromEntries((react.groups || []).map((g) => [g.id, g]));
  ok('a title match beats a body substring', rg.skills?.items[0]?.title === 'react-dev', JSON.stringify(rg.skills?.items?.map((i) => i.title)));
  ok('…and the more relevant group is listed first', (react.groups || [])[0]?.id === 'skills', (react.groups || []).map((g) => g.id).join(','));
  ok('a substring-only match is still found, just ranked below', rg.apis?.items.some((i) => i.title === 'Chempirical'));

  ok('an empty query returns nothing rather than everything', searchEverything('   ').total === 0);
  ok('a one-character query is refused as noise', searchEverything('a').total === 0);
  ok('no corpus at all still returns a shape', searchEverything('react').ok === true);

  // Wiring: the sidebar box calls the bridge, and the bridge reads every corpus.
  const app = read('App.jsx');
  ok('the sidebar search asks for all corpora', /searchAll\(/.test(app) && /searchGroups/.test(app));
  ok('…and renders a group per corpus', /searchGroups\?\.groups/.test(app) || /searchGroups\.groups/.test(app));
  const api = read('lib/api.js');
  ok('the client exposes searchAll', /export const searchAll/.test(api));
  const bridge = fs.readFileSync(path.join(root, 'api', 'bridge.js'), 'utf8');
  ok('the bridge has a search_all op', /case 'search_all'/.test(bridge));
  ok('…that reads the atlas and the API catalogue', /loadAtlas\(\)/.test(bridge) && /loadCatalogue\(\)/.test(bridge));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
