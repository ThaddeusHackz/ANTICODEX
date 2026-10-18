// Web search: Tavily + Exa with automatic fallover.

import { getKey, CATALOG } from './keys.js';

export async function webSearch({ query, provider = 'auto', max_results = 6 }) {
  const tavily = getKey('TAVILY_API_KEY');
  const exa = getKey('EXA_API_KEY');

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
