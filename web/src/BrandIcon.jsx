// Brand marks for connector and provider tiles.
//
// The SVGs in `web/public/logos/` are vendored from Simple Icons, unmodified
// except for the root `fill` (Simple Icons ships monochrome black paths; this UI
// is dark, so the root is filled white — every path's `d` data is untouched):
//   https://raw.githubusercontent.com/simple-icons/simple-icons/<tag>/icons/<slug>.svg
//
// Most files come from the `develop` branch. A few brands were later removed
// from Simple Icons, so they are pinned to the last release tag that shipped
// them (checked: the URL returns 200, the file has the official path data):
//   slack.svg, openai.svg ................................ 15.0.0
//   playwright.svg, microsoftazure.svg, amazonwebservices.svg ... 12.4.0
//
// Brands with no Simple Icons mark (Composio, Pipedream, DeepWiki, Context7,
// Memory, REA, Filesystem, Sequential Thinking, …) intentionally render a
// monogram. A monogram is never presented as the official logo: the tooltip
// says "monogram (no bundled brand mark)", and the tile has no brand mark.
import React, { useState } from 'react';
import './brand.css';

/**
 * brand id / provider id → file in web/public/logos/<slug>.svg
 *
 * Keys are the ids used by lib/mcp.js (`MCP_CATALOG[].id`) and lib/providers.js
 * (`PROVIDER_DIRECTORY[].id`), plus a few tag aliases the gateway cards name.
 * Every value must have a matching SVG on disk — tests/test-brands.mjs checks
 * that in both directions, so a typo fails the suite instead of a 404 tile.
 */
export const BRAND_LOGOS = {
  // --- MCP catalog: remote servers / managed gateways -----------------------
  'zapier': 'zapier',
  'notion': 'notion',
  'linear': 'linear',
  'github': 'github',
  'supabase': 'supabase',
  'cloudflare': 'cloudflare',
  'sentry': 'sentry',
  'paypal': 'paypal',
  'stripe': 'stripe',
  'asana': 'asana',
  'intercom': 'intercom',
  'vercel': 'vercel',

  // --- MCP catalog: local (stdio) launchers --------------------------------
  'playwright': 'playwright',
  'chrome-devtools': 'googlechrome',
  'chrome': 'googlechrome',
  'shadcn': 'shadcnui',
  'shadcnui': 'shadcnui',

  // --- apps a gateway connects (kept for gateway rows / future surfaces) ----
  'google-drive': 'googledrive',
  'googledrive': 'googledrive',
  'gmail': 'gmail',
  'slack': 'slack',
  'dropbox': 'dropbox',
  'sheets': 'googlesheets',
  'googlesheets': 'googlesheets',
  'jira': 'jira',
  'hubspot': 'hubspot',
  'figma': 'figma',
  'neon': 'neon',
  'prisma': 'prisma',
  'postgres': 'postgresql',
  'postgresql': 'postgresql',
  'huggingface': 'huggingface',

  // --- settings → providers ------------------------------------------------
  'nvidia': 'nvidia',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'claude': 'anthropic',
  'google': 'googlegemini',
  'gemini': 'googlegemini',
  'googlegemini': 'googlegemini',
  'mistral': 'mistralai',
  'mistralai': 'mistralai',
  'deepseek': 'deepseek',
  'moonshot': 'moonshotai',
  'moonshotai': 'moonshotai',
  'qwen': 'qwen',
  'doubao': 'bytedance',
  'bytedance': 'bytedance',
  'minimax': 'minimax',
  'meta': 'meta',
  'openrouter': 'openrouter',
  'perplexity': 'perplexity',
  'azure': 'microsoftazure',
  'microsoftazure': 'microsoftazure',
  'vertex': 'googlecloud',
  'googlecloud': 'googlecloud',
  'bedrock': 'amazonwebservices',
  'amazonwebservices': 'amazonwebservices'
};

/** Resolve a brand id to a vendored slug, or null when there is no real mark. */
export function brandSlug(brand) {
  if (!brand) return null;
  return BRAND_LOGOS[String(brand).trim().toLowerCase()] || null;
}

/**
 * One square tile: the official brand mark when we have vendored one, otherwise
 * a letter monogram. Both are decorative — the server name is always rendered
 * next to the tile, so the image keeps `alt=""` and `aria-hidden`.
 */
export default function BrandIcon({ brand, name = '', size = 38, className = '' }) {
  const slug = brandSlug(brand);
  // Remember *which* slug failed, not just "failed", so a recycled tile with a
  // different brand does not inherit the previous 404.
  const [brokenSlug, setBrokenSlug] = useState(null);
  const broken = Boolean(slug) && brokenSlug === slug;
  const label = String(name || brand || '').trim();
  const initial = (label.replace(/^[^A-Za-z0-9]+/, '')[0] || label[0] || '?').toUpperCase();
  const cls = className ? `mcp-icon ${className}` : 'mcp-icon';

  return (
    <span
      className={cls}
      style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.42)) }}
      data-brand={slug && !broken ? slug : undefined}
      data-monogram={!slug || broken ? 'true' : undefined}
      title={slug && !broken ? undefined : `${label} — monogram (no bundled brand mark)`}
    >
      {slug && !broken ? (
        <img
          src={`/logos/${slug}.svg`}
          alt=""
          aria-hidden="true"
          draggable="false"
          onError={() => setBrokenSlug(slug)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}
