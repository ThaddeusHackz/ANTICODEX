// ANTICODEX — Figma → code, from the file rather than from a screenshot.
//
// What this module is for: the MCP catalogue already lists Figma
// (`https://mcp.figma.com/mcp`, see lib/mcp.js) — that is the Dev Mode server,
// which answers questions about a file you have open. `/imp` is the other half:
// a host-side read of the REST API that turns the file's own document tree into
// design tokens plus a build brief the repo can commit.
//
// Evidence this design is built from (see the Figma REST docs; classification
// below is honest about which parts were observed in this session):
//
//   * **seen** — the connector wired into this project is authenticated with a
//     Figma *personal access token*: a team/folder listing came back
//     `Figma denied access to team '…' (API error: Invalid scope)`, while a
//     bare credential check succeeded. So an import cannot browse folders here;
//     it must be handed a file key or a figma.com/design URL. That is why
//     parseFigmaRef() insists on one instead of pretending to search.
//   * **inferred** — file reads need `file_content:read`; comments need
//     `file_comments:read`; published library components need
//     `library_content:read`. A token missing one of those fails only that
//     section, and every section failure is reported as its own line, never
//     collapsed into a green badge.
//   * **unknown** — Code Connect mappings are not read here. They live behind
//     the Dev Mode MCP server, and claiming them without a mapping file would be
//     exactly the invented value AGENTS.md forbids.
//
// Nothing in this module writes to disk. It returns content; the caller decides
// where it lands, and the workspace policy decides whether it may.

export const FIGMA_API = 'https://api.figma.com/v1';

// A file key is the 22-ish character id in figma.com/design/<key>/... — it is
// base62, but Figma has also served ids of other lengths, so the check is "looks
// like a key", not "is exactly 22".
const KEY_RE = /^[A-Za-z0-9]{10,64}$/;

/**
 * Parse what a user pastes: a design/board/proto URL, a bare key, or a key with
 * an optional `--node` / `--depth` flag already stripped by the caller.
 *
 * Returns { ok:true, file_key, node_id } or { ok:false, error, fix }. It never
 * guesses: a URL to a *file* gives a key, a URL with node-id=12-34 gives
 * `12:34` (the API wants the colon form, the URL carries the hyphen form).
 */
export function parseFigmaRef(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return {
      ok: false,
      error: 'No Figma file given.',
      fix: 'Paste a Figma link or file key: /imp https://www.figma.com/design/<key>/…'
    };
  }
  const first = raw.split(/\s+/)[0];
  let key = null;
  let node = null;

  if (/^https?:\/\//i.test(first)) {
    let u;
    try { u = new URL(first); } catch {
      return { ok: false, error: `"${first.slice(0, 80)}" is not a URL I can parse.`, fix: 'Use the Share → Copy link value from Figma.' };
    }
    if (!/(^|\.)figma\.com$/i.test(u.hostname)) {
      return { ok: false, error: `That link is on ${u.hostname}, not figma.com.`, fix: 'Copy the link from Figma itself (Share → Copy link).' };
    }
    // /design/<key>/…, /file/<key>/…, /board/<key>/…, /proto/<key>/…
    const parts = u.pathname.split('/').filter(Boolean);
    const at = parts.findIndex((p) => ['design', 'file', 'board', 'proto', 'slides'].includes(p));
    if (at === -1 || !parts[at + 1]) {
      return {
        ok: false,
        error: 'That figma.com link does not name a file (it may be a team, a folder or a community post).',
        fix: 'Open the file, then Share → Copy link — the URL looks like figma.com/design/<key>/<name>.'
      };
    }
    key = parts[at + 1];
    const nodeParam = u.searchParams.get('node-id');
    if (nodeParam) node = nodeParam.replace(/-/g, ':');
  } else if (KEY_RE.test(first)) {
    key = first;
  } else {
    return {
      ok: false,
      error: `"${first.slice(0, 80)}" is neither a figma.com link nor a file key.`,
      fix: 'A key is 10–64 letters/digits, e.g. CMniAtkBVTE0mPTwYnvg23.'
    };
  }

  if (!KEY_RE.test(key)) {
    return { ok: false, error: `"${key.slice(0, 80)}" does not look like a Figma file key.`, fix: 'Re-copy the link; the key sits right after /design/.' };
  }
  return { ok: true, file_key: key, node_id: node, url: `https://www.figma.com/design/${key}` };
}

/** figma colour channel (0..1 float) → 0..255 int. */
const ch = (v) => {
  const n = Math.round(Number(v) * 255);
  return Math.min(255, Math.max(0, Number.isFinite(n) ? n : 0));
};

/** A Figma paint → { hex:'#RRGGBB', alpha } (alpha = paint × colour alpha). */
export function hexOf(color, opacity = 1) {
  if (!color || typeof color !== 'object') return null;
  const a = Number((color.a ?? 1) * (opacity ?? 1));
  const hex = '#' + [color.r, color.g, color.b].map((c) => ch(c).toString(16).padStart(2, '0')).join('').toUpperCase();
  return { hex, alpha: Math.round((Number.isFinite(a) ? a : 1) * 100) / 100 };
}

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** Relative luminance, used only to order the palette light→dark for reading. */
export function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Walk a file document and collect what a build actually needs: colours,
 * type ramps, spacing, radii, shadows, components — each with the number of
 * places it is used, because "the brand purple" and "a purple used once in a
 * tooltip" are not the same token.
 *
 * Bounded on purpose: a real file can hold 200k nodes and this runs inside a
 * request. `truncated` says whether the cap was hit, so a thin result is never
 * mistaken for a thin design.
 */
export function tokensFromFile(file, { maxNodes = 20000, limits = {} } = {}) {
  const cap = { colors: 80, typography: 40, spacing: 24, radii: 12, shadows: 8, components: 60, ...limits };
  const styles = file?.styles && typeof file.styles === 'object' ? file.styles : {};
  const colors = new Map();
  const typography = new Map();
  const spacing = new Map();
  const radii = new Map();
  const shadows = new Map();
  const components = new Map();
  const pageNames = [];
  const frameNames = [];
  let nodeCount = 0;
  let textCount = 0;

  const bump = (map, key, extra = {}) => {
    const hit = map.get(key) || { uses: 0, ...extra };
    hit.uses += 1;
    map.set(key, hit);
    return hit;
  };

  const noteColor = (paintList, node, kind) => {
    if (!Array.isArray(paintList)) return;
    for (const p of paintList) {
      if (!p || p.visible === false) continue;
      const type = String(p.type || '').toUpperCase();
      if (type !== 'SOLID') continue; // gradients/images are not tokens; saying so beats flattening them
      const c = hexOf(p.color, p.opacity ?? node.opacity ?? 1);
      if (!c) continue;
      const styleId = p.boundVariables?.color?.id || (kind === 'fill' ? node.styles?.fill : node.styles?.stroke) || null;
      const name = styleId && styles[styleId]?.name ? styles[styleId].name : null;
      const hit = bump(colors, c.hex, { hex: c.hex, alpha: c.alpha, name: null });
      if (name && !hit.name) hit.name = name;
      hit.alpha = Math.min(hit.alpha, c.alpha);
    }
  };

  const walk = (node, pageName) => {
    if (!node || typeof node !== 'object' || nodeCount >= maxNodes) return;
    nodeCount += 1;
    const type = String(node.type || '');
    if (type === 'PAGE') pageNames.push(node.name || '(unnamed page)');
    if (type === 'FRAME' && pageName && frameNames.length < 60) frameNames.push(node.name);
    if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
      const name = node.name || '(unnamed component)';
      const hit = bump(components, name, { name, kind: type === 'COMPONENT_SET' ? 'set' : 'component', instances: 0 });
      hit.kind = type === 'COMPONENT_SET' ? 'set' : 'component';
    }
    if (type === 'INSTANCE') {
      const name = node.name || '(unnamed instance)';
      const hit = components.get(name) || { name, kind: 'instance-only', instances: 0, uses: 1 };
      hit.instances = (hit.instances || 0) + 1;
      components.set(name, hit);
    }

    noteColor(node.fills, node, 'fill');
    noteColor(node.strokes, node, 'stroke');
    if (node.backgroundColor) noteColor([{ type: 'SOLID', color: node.backgroundColor, opacity: 1 }], node, 'background');

    if (type === 'TEXT' && node.style) {
      textCount += 1;
      const s = node.style;
      const size = Math.round(Number(s.fontSize) * 10) / 10 || null;
      const weight = Number(s.fontWeight) || null;
      const family = String(s.fontFamily || 'unknown');
      const key = `${family}|${weight}|${size}`;
      const styleId = node.styles?.text;
      const name = styleId && styles[styleId]?.name ? styles[styleId].name : null;
      const lineHeight = s.lineHeightPx ? Math.round(Number(s.lineHeightPx) * 10) / 10 : null;
      const letterSpacing = s.letterSpacing != null ? Math.round(Number(s.letterSpacing) * 100) / 100 : null;
      const hit = bump(typography, key, { family, weight, size, lineHeight, letterSpacing, name: null });
      if (name && !hit.name) hit.name = name;
    }

    if (Number(node.cornerRadius) > 0) bump(radii, String(Math.round(node.cornerRadius)), { px: Math.round(node.cornerRadius) });
    if (Array.isArray(node.rectangleCornerRadii)) {
      for (const r of node.rectangleCornerRadii) if (Number(r) > 0) bump(radii, String(Math.round(r)), { px: Math.round(r) });
    }

    for (const side of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) {
      const v = Number(node[side]);
      if (v > 0) bump(spacing, String(Math.round(v)), { px: Math.round(v) });
    }
    if (Number(node.itemSpacing) > 0) bump(spacing, String(Math.round(node.itemSpacing)), { px: Math.round(node.itemSpacing) });

    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        if (!e || e.visible === false) continue;
        const t = String(e.type || '');
        if (t !== 'DROP_SHADOW' && t !== 'INNER_SHADOW') continue;
        const c = hexOf(e.color, 1) || { hex: '#000000', alpha: 0.25 };
        const css = `${t === 'INNER_SHADOW' ? 'inset ' : ''}${Math.round(e.offset?.x || 0)}px ${Math.round(e.offset?.y || 0)}px ${Math.round(e.radius || 0)}px ${Math.round(e.spread || 0)}px ${c.hex.toLowerCase()}${c.alpha < 1 ? Math.round(c.alpha * 255).toString(16).padStart(2, '0') : ''}`;
        bump(shadows, css, { css });
      }
    }

    if (Array.isArray(node.children)) {
      // Pages reset the "current page" so frames are attributed to the right one.
      const nextPage = type === 'PAGE' ? node.name : pageName;
      for (const child of node.children) walk(child, nextPage);
    }
  };

  if (file?.document) walk(file.document, null);

  const byUses = (map) => [...map.values()].sort((a, b) => b.uses - a.uses);
  const colourList = byUses(colors)
    .sort((a, b) => b.uses - a.uses || luminance(a.hex) - luminance(b.hex))
    .slice(0, cap.colors)
    .map((c, i) => ({ ...c, token: slug(c.name) || `color-${c.hex.slice(1).toLowerCase()}`, index: i }));
  // Two style names can slug to the same token; the second one keeps its hex so
  // nothing is silently merged.
  const seenTokens = new Set();
  for (const c of colourList) {
    let t = c.token;
    if (seenTokens.has(t)) t = `${t}-${c.hex.slice(1).toLowerCase()}`;
    seenTokens.add(t);
    c.token = t;
  }

  const typeList = byUses(typography).slice(0, cap.typography).map((t) => ({
    ...t,
    token: slug(t.name) || `text-${slug(t.family)}-${t.size ?? 'auto'}${t.weight ? `-${t.weight}` : ''}`
  }));

  return {
    file: {
      name: file?.name || null,
      last_modified: file?.lastModified || null,
      version: file?.version || null,
      editor_type: file?.editorType || null,
      schema_version: file?.schemaVersion ?? null
    },
    pages: pageNames.slice(0, 60),
    frames: frameNames,
    counts: {
      nodes: nodeCount,
      text_nodes: textCount,
      styles: Object.keys(styles).length,
      published_components: Object.keys(file?.components || {}).length,
      component_sets: Object.keys(file?.componentSets || {}).length
    },
    colors: colourList,
    typography: typeList,
    spacing: byUses(spacing).slice(0, cap.spacing).map((s) => s.px).sort((a, b) => a - b),
    radii: byUses(radii).slice(0, cap.radii).map((r) => r.px).sort((a, b) => a - b),
    shadows: byUses(shadows).slice(0, cap.shadows).map((s) => s.css),
    components: byUses(components).slice(0, cap.components)
      .map((c) => ({ name: c.name, kind: c.kind, instances: c.instances || 0 })),
    truncated: {
      walk: nodeCount >= maxNodes,
      horizon: nodeCount >= maxNodes ? `stopped after ${maxNodes} nodes` : null,
      colors: Math.max(0, colors.size - cap.colors),
      typography: Math.max(0, typography.size - cap.typography)
    }
  };
}

const px = (n) => `${n}px`;

/** tokens.json — the shape a build script or a Tailwind config can read. */
export function buildTokensJson(tokens, { fileKey, url } = {}) {
  return {
    $generator: 'ANTICODEX /imp (Figma REST)',
    $source: { file_key: fileKey || null, url: url || null, name: tokens.file.name, version: tokens.file.version, last_modified: tokens.file.last_modified },
    $note: 'Generated from the file’s own document tree. Usage counts are how many nodes referenced each value.',
    color: Object.fromEntries(tokens.colors.map((c) => [c.token, {
      value: c.hex, alpha: c.alpha, uses: c.uses, style: c.name || null
    }])),
    typography: Object.fromEntries(tokens.typography.map((t) => [t.token, {
      family: t.family, weight: t.weight, size: t.size, line_height: t.lineHeight, letter_spacing: t.letterSpacing, uses: t.uses, style: t.name || null
    }])),
    space: Object.fromEntries(tokens.spacing.map((v) => [`space-${v}`, { value: px(v) }])),
    radius: Object.fromEntries(tokens.radii.map((v) => [`radius-${v}`, { value: px(v) }])),
    shadow: Object.fromEntries(tokens.shadows.map((v, i) => [`shadow-${i + 1}`, { value: v }])),
    component: Object.fromEntries(tokens.components.map((c) => [slug(c.name) || 'component', { name: c.name, kind: c.kind, instances: c.instances }]))
  };
}

/** tokens.css — the same values as custom properties, ready to import. */
export function buildTokensCss(tokens, { fileKey } = {}) {
  const lines = [
    `/* Design tokens generated by ANTICODEX /imp from Figma file ${fileKey || '(unknown key)'} — ${tokens.file.name || 'untitled'}.`,
    '   Regenerate with /imp rather than editing by hand: a hand-edit here drifts from the file. */',
    ':root {'
  ];
  for (const c of tokens.colors) {
    lines.push(`  --${c.token}: ${c.hex.toLowerCase()}${c.alpha < 1 ? `; /* alpha ${c.alpha} */` : ';'}`);
  }
  if (tokens.typography.length) lines.push('');
  for (const t of tokens.typography) {
    lines.push(`  --${t.token}: ${t.weight || 400} ${t.size != null ? px(t.size) : '1rem'}${t.lineHeight ? `/${px(t.lineHeight)}` : ''} ${/[\s,]/.test(t.family) ? `"${t.family}"` : t.family};`);
  }
  if (tokens.spacing.length) lines.push('');
  for (const v of tokens.spacing) lines.push(`  --space-${v}: ${px(v)};`);
  if (tokens.radii.length) lines.push('');
  for (const v of tokens.radii) lines.push(`  --radius-${v}: ${px(v)};`);
  if (tokens.shadows.length) lines.push('');
  tokens.shadows.forEach((s, i) => lines.push(`  --shadow-${i + 1}: ${String(s).toLowerCase()};`));
  lines.push('}');
  return lines.join('\n') + '\n';
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/**
 * The brief. Written for a person who has to build the UI: what the tokens are,
 * what is used most, what is NOT in here (gradients, images, Code Connect), and
 * the parts of the read that failed. A section that could not be read says so in
 * place — it is never dropped, because a missing section reads as "nothing to
 * see".
 */
export function buildDesignBrief({ fileKey, url, tokens, sections = {}, nodes = null } = {}) {
  const t = tokens;
  const out = [];
  out.push(`# ${t.file.name || 'Figma file'} — design brief`);
  out.push('');
  out.push(`- Source: ${url || `https://www.figma.com/design/${fileKey}`}`);
  out.push(`- File key: \`${fileKey}\``);
  out.push(`- Last modified: ${t.file.last_modified || 'unknown'}`);
  out.push(`- Version: \`${t.file.version || 'unknown'}\``);
  out.push(`- Read by: ANTICODEX \`/imp\` (Figma REST \`/v1/files\`) — **not** the Dev Mode MCP, so Code Connect mappings are not included.`);
  out.push('');
  out.push('## What is in the file');
  out.push('');
  out.push(`- ${t.counts.nodes} nodes walked${t.truncated.walk ? ` (**capped**: ${t.truncated.horizon}; deeper frames are not represented)` : ''}`);
  out.push(`- ${t.counts.text_nodes} text nodes, ${t.counts.styles} local styles, ${t.counts.published_components} published components, ${t.counts.component_sets} component sets`);
  if (t.pages.length) out.push(`- Pages: ${t.pages.map((p) => `\`${p}\``).join(', ')}`);
  if (t.frames.length) out.push(`- Top frames: ${t.frames.slice(0, 24).map((f) => `\`${f}\``).join(', ')}`);
  out.push('');

  if (t.colors.length) {
    out.push('## Colour tokens');
    out.push('');
    out.push('| token | value | uses | style name |');
    out.push('| --- | --- | ---: | --- |');
    for (const c of t.colors) out.push(`| \`--${c.token}\` | \`${c.hex}${c.alpha < 1 ? ` @${c.alpha}` : ''}\` | ${c.uses} | ${c.name || '—'} |`);
    if (t.truncated.colors) out.push(`\n_${t.truncated.colors} further colours were used less often and are not listed._`);
    out.push('');
  } else {
    out.push('## Colour tokens'); out.push('');
    out.push('_No solid fills or strokes were found in the walked nodes. Gradients and image fills are not turned into tokens._');
    out.push('');
  }

  if (t.typography.length) {
    out.push('## Type ramp');
    out.push('');
    out.push('| token | family | size | weight | line height | uses | style name |');
    out.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
    for (const x of t.typography) {
      out.push(`| \`--${x.token}\` | ${x.family} | ${x.size ?? '—'} | ${x.weight ?? '—'} | ${x.lineHeight ?? '—'} | ${x.uses} | ${x.name || '—'} |`);
    }
    out.push('');
  }

  if (t.spacing.length || t.radii.length || t.shadows.length) {
    out.push('## Spacing, radius, elevation');
    out.push('');
    if (t.spacing.length) out.push(`- Spacing scale (from auto-layout padding and gaps): ${t.spacing.map((v) => `\`${v}\``).join(', ')}`);
    if (t.radii.length) out.push(`- Corner radii: ${t.radii.map((v) => `\`${v}px\``).join(', ')}`);
    if (t.shadows.length) out.push(`- Shadows: ${t.shadows.map((s) => `\`${s}\``).join(', ')}`);
    out.push('');
  }

  if (t.components.length) {
    out.push('## Components');
    out.push('');
    out.push('| component | kind | instances |');
    out.push('| --- | --- | ---: |');
    for (const c of t.components) out.push(`| ${c.name} | ${c.kind} | ${c.instances} |`);
    out.push('');
  }

  if (nodes?.length) {
    out.push('## Focused node');
    out.push('');
    for (const n of nodes) {
      const box = n.absoluteBoundingBox;
      out.push(`- \`${n.id}\` **${n.name}** — ${n.type}${box ? `, ${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}` : ''}`);
      if (n.characters) out.push(`  - text: ${JSON.stringify(n.characters.slice(0, 240))}`);
    }
    out.push('');
  }

  out.push('## Build notes');
  out.push('');
  out.push('- Import `tokens.css` (or read `tokens.json`) and reference tokens — do not paste hex values into components.');
  out.push(`- The most-used colour is \`--${t.colors[0]?.token || 'none'}\` (${t.colors[0]?.uses || 0} nodes)${t.colors[0]?.uses ? ` at ${pct(t.colors[0].uses, t.counts.nodes)}% of the walked tree` : ''}; treat it as the surface/accent decision and check it against the type ramp rather than inventing a contrast pair.`);
  out.push('- Values are read, not designed: if a token looks wrong, the fix belongs in the Figma file and a re-run of `/imp`.');
  out.push('- Layout is not exported. Frames give sizes and names; auto-layout intent (fill/hug) is visible in the node tree only, so derive grid rules from `tokens.json` + the frames list, not from a picture.');
  out.push('');

  if (sections.comments || sections.library || sections.nodes) {
    out.push('## Sections that could not be read');
    out.push('');
    if (sections.comments) out.push(`- Comments: ${sections.comments}`);
    if (sections.library) out.push(`- Published library: ${sections.library}`);
    if (sections.nodes) out.push(`- Focused node: ${sections.nodes}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * A short, stable identity for the exact revision that was read. `/imp` stores it
 * next to the artifacts so a re-run can say "unchanged since <time>" instead of
 * reporting a fresh import that is byte-identical to the last one.
 */
export function sourceRef({ file_key, node_id = null, version = null, last_modified = null } = {}) {
  return [file_key || '-', node_id || '-', version || '-', last_modified || '-'].join('|');
}

/** Every artifact /imp produces, in the order a reader wants them. */
export function buildArtifacts({ fileKey, url, tokens, sections, nodes }) {
  return [
    { path: '.figma/design-brief.md', content: buildDesignBrief({ fileKey, url, tokens, sections, nodes }) },
    { path: '.figma/tokens.json', content: JSON.stringify(buildTokensJson(tokens, { fileKey, url }), null, 2) + '\n' },
    { path: '.figma/tokens.css', content: buildTokensCss(tokens, { fileKey }) }
  ];
}

// --- the client -------------------------------------------------------------

/**
 * Read one file. `fetchImpl` is injectable so the test suite can prove the
 * request shape (header name, URL, timeout) without a network.
 *
 * A missing/invalid token is returned as { ok:false, error, fix } — never as an
 * empty success. The token is not echoed anywhere in the result.
 */
export async function readFigmaFile({
  fileKey, token, nodeId = null, depth = null, fetchImpl = globalThis.fetch, timeoutMs = 25000
} = {}) {
  if (!token) {
    return {
      ok: false, needs_token: true,
      error: 'No Figma token is configured, and Figma’s REST API will not serve a file without one.',
      fix: 'Figma → Settings → Security → Personal access tokens → create a token with `file_content:read` (add `file_comments:read` for comments, `library_content:read` for library components), then save it as FIGMA_TOKEN in Settings → Providers.'
    };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'This runtime has no fetch(), so the Figma API cannot be reached.' };
  }
  const get = async (path) => {
    const res = await fetchImpl(`${FIGMA_API}${path}`, {
      headers: { 'X-Figma-Token': token },
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
    return { status: res.status, ok: res.ok, body };
  };

  const explain = (r) => {
    if (r.status === 403) {
      return 'Figma refused the read (403). The token is valid but is missing a scope this file needs — likely `file_content:read`, and possibly `library_content:read` for published components.';
    }
    if (r.status === 404) return `Figma has no file with that key, or this token’s account cannot see it (404). A branch file answers 404 for some endpoints.`;
    if (r.status === 429) return 'Figma rate-limited the request (429). Wait a minute and run /imp again.';
    return `Figma returned ${r.status}: ${String(r.body?.err || r.body?.message || '').slice(0, 200) || 'no message'}`;
  };

  let file = null;
  let nodes = null;
  const sections = {};

  if (nodeId) {
    // A focused read: /nodes returns exactly the requested subtree.
    const r = await get(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}${depth ? `&depth=${Number(depth)}` : ''}`);
    if (!r.ok) return { ok: false, status: r.status, error: explain(r), fix: 'Check the node id (it looks like 12:34) and the token scopes.' };
    nodes = Object.values(r.body?.nodes || {}).map((n) => n?.document).filter(Boolean);
    if (!nodes.length) return { ok: false, status: r.status, error: `Node ${nodeId} is not in that file.`, fix: 'Open the frame in Figma and copy its link — the node-id is in the URL.' };
    // Tokenising needs a document root; the node's own subtree is enough, and the
    // file metadata comes from a cheap metadata read.
    file = { name: r.body?.name || null, document: { type: 'DOCUMENT', children: nodes }, styles: r.body?.styles || {} };
    const meta = await get(`/files/${encodeURIComponent(fileKey)}/meta`);
    if (meta.ok && meta.body?.file) {
      file.name = meta.body.file.name || file.name;
      file.lastModified = meta.body.file.lastModified || null;
      file.version = meta.body.file.version || null;
    }
  } else {
    const q = depth ? `?depth=${Number(depth)}` : '';
    const r = await get(`/files/${encodeURIComponent(fileKey)}${q}`);
    if (!r.ok) return { ok: false, status: r.status, error: explain(r), fix: 'Check the key and the token scopes (`file_content:read`).' };
    file = r.body;
  }
  if (!file || !file.document) {
    return { ok: false, error: 'Figma answered without a document tree, so there is nothing to tokenise.', fix: 'Try the file in a browser; if it renders, re-run /imp with the file key.' };
  }

  // Optional sections. Each failure is its own line, and none of them fails the
  // import — a comment thread is not the design.
  let comments = null;
  if (!nodeId) {
    const c = await get(`/files/${encodeURIComponent(fileKey)}/comments`);
    if (c.ok) comments = Array.isArray(c.body?.comments) ? c.body.comments : [];
    else sections.comments = explain(c);
  }
  let library = null;
  {
    const l = await get(`/files/${encodeURIComponent(fileKey)}/components`);
    if (l.ok) library = { components: l.body?.meta?.components || [], component_sets: l.body?.meta?.component_sets || [] };
    else sections.library = explain(l);
  }

  const tokens = tokensFromFile(file);
  return {
    ok: true,
    file_key: fileKey, url: `https://www.figma.com/design/${fileKey}`,
    tokens, nodes, sections,
    comments: comments ? comments.slice(0, 40).map((c) => ({
      id: c.id, message: String(c.message || '').slice(0, 400),
      author: c.user?.handle || c.user?.name || null,
      created_at: c.created_at, resolved: Boolean(c.resolved_at)
    })) : null,
    library: library ? {
      components: library.components.slice(0, 60).map((c) => ({ name: c.name, key: c.key, description: String(c.description || '').slice(0, 160) })),
      count: library.components.length
    } : null
  };
}
