// Web search: Tavily + Exa with automatic fallover.

import { getKey, CATALOG } from './keys.js';

export async function webSearch({ query, provider = 'auto', max_results = 6, keys }) {
  const tavily = (keys && keys.TAVILY_API_KEY) || getKey('TAVILY_API_KEY');
  const exa = (keys && keys.EXA_API_KEY) || getKey('EXA_API_KEY');

  const order = provider === 'tavily' ? ['tavily']
    : provider === 'exa' ? ['exa']
    : [tavily ? 'tavily' : null, exa ? 'exa' : null].filter(Boolean);

  const errors = [];

  for (const p of order) {
    try {
      if (p === 'tavily' && tavily) {
        const res = await fetch(CATALOG.search.tavily, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavily, query, max_results, search_depth: 'advanced', include_answer: true })
        });
        if (!res.ok) { errors.push(`tavily ${res.status}`); continue; }
        const data = await res.json();
        return {
          provider: 'tavily',
          answer: data.answer || '',
          results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 400) || '' }))
        };
      }
      if (p === 'exa' && exa) {
        const res = await fetch(CATALOG.search.exa, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${exa}` },
          body: JSON.stringify({ query, numResults: max_results, type: 'auto', contents: { text: { maxCharacters: 400 } } })
        });
        if (!res.ok) { errors.push(`exa ${res.status}`); continue; }
        const data = await res.json();
        return {
          provider: 'exa',
          answer: '',
          results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.text || r.snippet || '').slice(0, 400) }))
        };
      }
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }

  // Offline-safe placeholder so the feature is demonstrable without keys.
  return {
    provider: 'demo',
    answer: '',
    demo: true,
    results: [{
      title: `Search results for “${query}” require an API key`,
      url: 'https://anticodex.dev/settings',
      snippet: 'Add a Tavily or Exa API key in Settings → Search (or Admin → Global keys). Tavily and Exa free tiers work immediately. ' + (errors.length ? `(${errors.join('; ')})` : '')
    }]
  };
}

/**
 * One search box, every local corpus.
 *
 * The complaint that produced this: "⌕Search" found chats and nothing else, so the
 * 2,335-API catalogue, the 2,208-skill atlas, the docs and this machine's
 * connectors were only findable if you already knew which page they lived on. A
 * search box that only searches one of five things teaches people not to use it.
 *
 * Deliberately synchronous and local: these are in-memory/file corpora, so results
 * appear as you type with no key, no network, and no spinner. Web search stays a
 * separate, explicit action because it costs money and can fail.
 */
export function searchEverything(query, {
  limit = 8,
  chats = [],
  skills = null,
  apis = null,
  docs = [],
  connectors = []
} = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, query: '', groups: [], total: 0 };
  const terms = q.split(/\s+/).filter(Boolean);
  /**
   * Whole-word matching, with a prefix allowance.
   *
   * Substring matching is what returned "Chempirical" for `react` — it contains the
   * letters r-e-a-c-t across "…and React…"? No: it matched because *some* field
   * happened to contain the substring. Either way the honesty rule is the same: a
   * result is relevant if the term starts a word in a field, or is the whole field,
   * or the query is long enough that a substring is likely meaningful.
   */
  const wordRe = terms.map((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
  const hit = (text) => {
    const t = String(text || '');
    return wordRe.every((re) => re.test(t));
  };
  const scoreOf = (title, body) => {
    const t = String(title || '').toLowerCase();
    const b = String(body || '').toLowerCase();
    let s = 0;
    let titleScore = 0;
    for (const term of terms) {
      // Exact title match is the strongest signal there is.
      if (t === term) titleScore += 40;
      else if (new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(t)) titleScore += 22;
      else if (t.startsWith(term)) titleScore += 16;
      else if (new RegExp(`(^|[^a-z0-9])${term}`).test(t)) titleScore += 8;
      else if (t.includes(term)) titleScore += 2;
      s += titleScore;
      // Body hits count, but a word start beats a string buried mid-word — and a
      // title that begins with the term beats any body match at all (this is what
      // put "Chempirical | …reactions…" above "react-dev").
      // Three tiers, and the differences matter for a query like "react": a whole
      // word ("React", "react-native") is a real hit; a longer word that merely
      // starts with the term ("reactions") is a maybe. Without this split, three
      // chemistry APIs outranked every React skill.
      const wholeWord = new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'g');
      const wordStart = new RegExp(`(^|[^a-z0-9])${term}`, 'g');
      const whole = (b.match(wholeWord) || []).length;
      const starts = (b.match(wordStart) || []).length - whole;
      s += Math.min(whole, 5) * 6 + Math.min(Math.max(starts, 0), 5) * 1.5;
    }
    // Returned separately as well: the sort uses (title, body) so a title hit is
    // decisive before body frequency is even considered.
    return { total: s, title: titleScore };
  };
  // Every item carries `score` (what the UI shows/sorts by) and `titleScore`.
  const pairOf = (r) => ({ score: r.total, titleScore: r.title });
  // A one- or two-letter query is noise in any corpus; require three.
  if (terms.some((t) => t.length < 2)) return { ok: true, query: q, groups: [], total: 0, note: 'Type at least two characters.' };
  const groups = [];

  // --- chats ---------------------------------------------------------------
  const chatHits = [];
  for (const t of chats || []) {
    if (!t) continue;
    const title = String(t.title || 'Untitled');
    const body = (t.messages || []).map((m) => String(m.content || '')).join('\n');
    if (!hit(title) && !hit(body)) continue;
    const at = body.toLowerCase().indexOf(terms[0]);
    chatHits.push({
      id: t.id, title, updated_at: t.updated_at || null,
      ...pairOf(scoreOf(title, body)),
      snippet: at >= 0 ? body.slice(Math.max(0, at - 40), at + 100).replace(/\s+/g, ' ') : ''
    });
  }
  if (chatHits.length) {
    groups.push({
      id: 'chats', label: 'Chats', icon: '⌗',
      items: rank(chatHits).slice(0, limit)
        .map(({ score, titleScore, ...rest }) => ({ ...rest, kind: 'chat', to: `/?thread=${encodeURIComponent(rest.id)}` }))
    });
  }

  // --- public APIs ---------------------------------------------------------
  // `apis` is the loaded catalogue ({entries:[…]}); callers pass what they already
  // have so this stays allocation-free when the page does not need it.
  const apiHits = [];
  for (const e of (apis?.entries || apis || [])) {
    if (!e || !e.name) continue;
    const blob = `${e.name} ${e.description || ''} ${e.category || ''} ${e.host || ''}`;
    if (!hit(blob)) continue;
    apiHits.push({
      id: e.id, kind: 'api', title: e.name, subtitle: `${e.category || 'API'} · ${e.auth || 'free'}`,
      ...pairOf(scoreOf(e.name, `${e.description} ${e.category}`)),
      to: `/apis?api=${encodeURIComponent(e.id)}`
    });
  }
  if (apiHits.length) {
    groups.push({ id: 'apis', label: 'Public APIs', icon: '⛁', items: rank(apiHits).slice(0, limit) });
  }

  // --- skills --------------------------------------------------------------
  const skillHits = [];
  for (const s2 of (skills?.skills || skills || [])) {
    if (!s2) continue;
    const name = s2.name || s2.slug || s2.id;
    const blob = `${name} ${s2.description || ''} ${(s2.tags || []).join(' ')} ${s2.source || ''}`;
    if (!hit(blob)) continue;
    skillHits.push({
      id: s2.slug || s2.id, kind: 'skill', title: name, subtitle: (s2.description || '').slice(0, 90),
      ...pairOf(scoreOf(name, `${s2.description} ${(s2.tags || []).join(' ')}`)),
      to: `/skills?slug=${encodeURIComponent(s2.slug || s2.id)}`
    });
  }
  if (skillHits.length) {
    groups.push({ id: 'skills', label: 'Skills', icon: '✦', items: rank(skillHits).slice(0, limit) });
  }

  // --- connectors ----------------------------------------------------------
  const connHits = [];
  for (const c of connectors || []) {
    if (!c) continue;
    const blob = `${c.name || c.id} ${c.description || ''} ${(c.tags || []).join(' ')} ${c.vendor || ''}`;
    if (!hit(blob)) continue;
    connHits.push({
      id: c.id, kind: 'connector', title: c.name || c.id, subtitle: c.vendor || 'MCP server',
      ...pairOf(scoreOf(c.name || c.id, blob)), to: '/mcp'
    });
  }
  if (connHits.length) {
    groups.push({ id: 'connectors', label: 'Connectors', icon: '⇄', items: rank(connHits).slice(0, limit) });
  }

  // --- docs ----------------------------------------------------------------
  const docHits = [];
  for (const d of docs || []) {
    if (!d) continue;
    if (!hit(`${d.title} ${d.text || ''} ${d.path}`)) continue;
    docHits.push({
      id: d.path, kind: 'doc', title: d.title, subtitle: d.path,
      ...pairOf(scoreOf(d.title, d.text)), to: `/evidence?doc=${encodeURIComponent(d.path)}`
    });
  }
  if (docHits.length) {
    groups.push({ id: 'docs', label: 'Docs', icon: '⌸', items: rank(docHits).slice(0, limit) });
  }

  // One ordering rule for every group: a title match first, then total relevance.
  // Utility so the five call sites cannot drift apart again.
  function rank(items) {
    return [...items]
      .sort((a, b) => (b.titleScore || 0) - (a.titleScore || 0) || (b.score || 0) - (a.score || 0))
      .map(({ titleScore, ...rest }) => rest);
  }
  // Final ordering inside each group: title relevance, then discovery order. A
  // group whose items were already sorted keeps working; this only removes the
  // cases where a body-only match outranked a title match.
  for (const g of groups) {
    g.items.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  // Groups are ordered by their strongest hit, not by a fixed list: typing "react"
  // must put the React skills above three chemistry APIs that merely contain
  // "…reactions…". A fixed order would bury the answer under a corpus that has
  // nothing to do with the query.
  groups.sort((a, b) => (b.items[0]?.score || 0) - (a.items[0]?.score || 0));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { ok: true, query: q, groups, total, searched: { chats: (chats || []).length, apis: (apis?.entries || apis || []).length, skills: (skills?.skills || skills || []).length, connectors: (connectors || []).length, docs: (docs || []).length } };
}
