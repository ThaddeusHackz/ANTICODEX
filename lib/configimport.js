// ANTICODEX — bring your own setup.
//
// Recovered from two shipped desktop apps (see docs/REA-EVIDENCE.md):
//   * `~/.codex/config.toml`  → model + reasoning effort, `[model_providers.*]`,
//     `[mcp_servers.*]` (command/url/env_vars/startup_timeout_sec),
//     `[marketplaces.*]` + `[plugins."name@marketplace"] enabled`, `[desktop]`
//     behaviour flags, `[windows] sandbox`, `[notice.model_migrations]`.
//   * `~/.claude/settings.json` → `env` block (base URL, model aliases),
//     `enableWorkflows`, and `.claude/policy-limits.json` → `restrictions.*.allowed`
//     with `compliance_taints`, `monitoring_notice`, `defaults`.
//
// This module is pure: text in, plan out. Applying it is the bridge's job, so a
// dry-run and the real import can never disagree.

// ---------------------------------------------------------------------------
// Minimal TOML reader (the subset those configs actually use)
// ---------------------------------------------------------------------------

/** Strip a trailing `#` comment that is not inside a string. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Split on a delimiter that is not inside quotes/brackets. */
function splitTop(str, delim = ',') {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      buf += c;
      if (c === '\\' && quote === '"') { buf += str[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === delim && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
    // basic string: honour the escapes these files use
    return v.slice(1, -1).replace(/\\(["\\nrt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }[c]));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1); // literal
  if (v.startsWith('[') && v.endsWith(']')) return splitTop(v.slice(1, -1)).map(parseValue);
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {};
    for (const part of splitTop(v.slice(1, -1))) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      setPath(obj, part.slice(0, eq).trim().replace(/^["']|["']$/g, ''), parseValue(part.slice(eq + 1)));
    }
    return obj;
  }
  if (/^[+-]?\d+$/.test(v)) return Number(v);
  if (/^[+-]?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

/** Split a dotted key on dots that are not inside quotes: `"gpt-5.5"` is ONE
 *  segment, not two — that bug turned a model migration into garbage. */
function splitPath(path) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (const c of String(path)) {
    if (quote) { if (c === quote) { quote = null; continue; } buf += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '.') { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function setPath(obj, path, value) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Parse the TOML subset used by Codex-style config files. */
export function parseToml(text) {
  const root = {};
  let table = root;
  const lines = String(text || '').split(/\r?\n/);
  for (let raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    const arrayTable = /^\[\[(.+)\]\]$/.exec(line);
    if (arrayTable) {
      const path = arrayTable[1].trim();
      const parentParts = path.split('.').slice(0, -1);
      const key = path.split('.').slice(-1)[0];
      let parent = root;
      for (const p of parentParts) {
        parent[p] = parent[p] || {};
        parent = parent[p];
      }
      parent[key] = Array.isArray(parent[key]) ? parent[key] : [];
      table = {};
      parent[key].push(table);
      continue;
    }

    const tbl = /^\[(.+)\]$/.exec(line);
    if (tbl) {
      table = {};
      setPath(root, tbl[1].trim(), table);
      // setPath created a fresh object; re-resolve it so later writes land there
      const parts = splitPath(tbl[1].trim());
      let cur = root;
      for (const p of parts) cur = cur[p];
      table = cur;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    setPath(table, key, parseValue(value));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Codex → ANTICODEX
// ---------------------------------------------------------------------------

const WIRE = { responses: 'openai-responses', chat: 'openai-chat', completions: 'openai-chat' };

/**
 * Map a parsed Codex config onto ANTICODEX concepts.
 * @returns {{model, reasoning, providers, mcp, marketplaces, plugins, behaviour, sandbox, migrations, warnings}}
 */
export function mapCodexConfig(parsed = {}) {
  const warnings = [];
  const providers = Object.entries(parsed.model_providers || {}).map(([id, p]) => ({
    id,
    name: p.name || id,
    endpoint: p.base_url || p.baseUrl || '',
    key_env: p.env_key || '',
    wire_api: WIRE[p.wire_api] || p.wire_api || 'openai-chat',
    requires_openai_auth: Boolean(p.requires_openai_auth),
    local: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(p.base_url || '')
  })).filter((p) => {
    if (!p.endpoint) warnings.push(`model_providers.${p.id} has no base_url — skipped`);
    return Boolean(p.endpoint);
  });

  const mcp = Object.entries(parsed.mcp_servers || {}).map(([id, s]) => {
    const env = s.env_vars || s.env || {};
    const base = {
      id,
      name: id,
      startup_timeout_sec: Number(s.startup_timeout_sec || 30),
      env_count: Array.isArray(env) ? env.length : Object.keys(env).length
    };
    if (s.url) return { ...base, url: s.url, transport: 'http' };
    if (s.command) {
      return {
        ...base,
        url: 'stdio:' + id,
        transport: 'stdio',
        stdio: { command: s.command, args: Array.isArray(s.args) ? s.args : [] },
        // env_vars are *names* inherited from the parent, env is a literal map.
        env_vars: Array.isArray(s.env_vars) ? s.env_vars : [],
        env: Array.isArray(env) ? {} : env
      };
    }
    warnings.push(`mcp_servers.${id} has neither command nor url — skipped`);
    return null;
  }).filter(Boolean);

  const marketplaces = Object.entries(parsed.marketplaces || {}).map(([id, m]) => ({
    id, source_type: m.source_type || 'local', source: m.source || ''
  }));

  const plugins = Object.entries(parsed.plugins || {}).map(([ref, p]) => {
    const [name, marketplace] = ref.includes('@') ? ref.split('@') : [ref, null];
    return { id: ref, name, marketplace, enabled: p?.enabled !== false };
  });

  const desktop = parsed.desktop || {};
  const behaviour = {
    follow_up_queue_mode: desktop.followUpQueueMode === 'steer' ? 'steer' : 'queue',
    confetti: desktop['toys-confetti-enabled'] !== false,
    git_alwayt_push_note: undefined,
    git_force_push: Boolean(desktop['git-always-force-push']),
    pr_watch_auto_merge: Boolean(desktop['git-pr-watch-auto-merge'])
  };

  const migrations = Object.entries(parsed.notice?.model_migrations || {});
  const notify = Array.isArray(parsed.notify) ? parsed.notify : [];

  return {
    model: parsed.model || null,
    reasoning: parsed.model_reasoning_effort || null,
    default_provider: parsed.model_provider || null,
    providers,
    mcp,
    marketplaces,
    plugins,
    behaviour,
    sandbox: parsed.windows?.sandbox || parsed.sandbox || null,
    migrations: migrations.map(([from, to]) => ({ from, to })),
    notify_hook: notify.length ? { command: notify[0], event: notify[1] || 'turn-ended' } : null,
    tui: parsed.tui || {},
    warnings
  };
}

// ---------------------------------------------------------------------------
// Claude settings + policy limits → ANTICODEX
// ---------------------------------------------------------------------------

const CLAUDE_ENV = {
  ANTHROPIC_BASE_URL: 'endpoint',
  ANTHROPIC_AUTH_TOKEN: 'token', // never echoed back, only counted
  ANTHROPIC_API_KEY: 'token',
  ANTHROPIC_MODEL: 'model',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku'
};

export function mapClaudeSettings(settings = {}, policy = null) {
  const warnings = [];
  const env = settings.env || {};
  const provider = {
    id: 'claude-desktop',
    name: 'Claude Desktop (imported)',
    endpoint: env.ANTHROPIC_BASE_URL || '',
    wire_api: 'anthropic',
    key_env: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
    has_token: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
    local: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(env.ANTHROPIC_BASE_URL || '')
  };
  if (!provider.endpoint && !provider.has_token) warnings.push('no env block — nothing to import from settings.json');

  const aliases = Object.entries(CLAUDE_ENV)
    .filter(([k, role]) => role !== 'endpoint' && role !== 'token' && env[k])
    .map(([k, role]) => ({ env: k, role, model: env[k] }));

  const restrictions = policy?.restrictions || {};
  const flags = Object.entries(restrictions).map(([key, v]) => ({
    key,
    allowed: v?.allowed !== false,
    // Anything the shipped app gates is something this product should gate too.
    source: 'policy-limits'
  }));

  return {
    enable_workflows: settings.enableWorkflows !== false,
    completed_onboarding: Boolean(settings.hasCompletedOnboarding),
    provider,
    aliases,
    flags,
    compliance_taints: policy?.compliance_taints || [],
    monitoring_notice: policy?.monitoring_notice ?? null,
    defaults: policy?.defaults || {},
    warnings
  };
}

/**
 * One call the UI can make: raw text (or already-parsed JSON) → a plan.
 * `apply:false` (the default) produces a preview the user approves.
 */
export function buildImportPlan({ codex_toml, claude_settings, claude_policy } = {}) {
  const out = { ok: true, codex: null, claude: null, summary: { providers: 0, mcp: 0, plugins: 0, flags: 0, aliases: 0 }, warnings: [] };
  if (codex_toml) {
    try {
      const parsed = typeof codex_toml === 'string' ? parseToml(codex_toml) : codex_toml;
      out.codex = mapCodexConfig(parsed);
      out.summary.providers += out.codex.providers.length;
      out.summary.mcp += out.codex.mcp.length;
      out.summary.plugins += out.codex.plugins.length;
      out.warnings.push(...out.codex.warnings);
    } catch (e) {
      out.ok = false;
      out.warnings.push('config.toml could not be parsed: ' + (e.message || e));
    }
  }
  if (claude_settings || claude_policy) {
    try {
      const settings = typeof claude_settings === 'string'
        ? JSON.parse(claude_settings || '{}')
        : (claude_settings || {});
      const policy = claude_policy
        ? (typeof claude_policy === 'string' ? JSON.parse(claude_policy || 'null') : claude_policy)
        : null;
      out.claude = mapClaudeSettings(settings, policy);
      out.summary.flags += out.claude.flags.length;
      out.summary.aliases += out.claude.aliases.length;
      if (out.claude.provider.endpoint || out.claude.provider.has_token) out.summary.providers += 1;
      out.warnings.push(...out.claude.warnings);
    } catch (e) {
      out.ok = false;
      out.warnings.push('.claude settings could not be parsed: ' + (e.message || e));
    }
  }
  return out;
}

/** Turn a plan into the rows the bridge stores, without touching secrets. */
export function planToRows(plan, { home = null } = {}) {
  const providers = [];
  const connections = [];
  if (plan.codex) {
    for (const p of plan.codex.providers) {
      providers.push({
        id: 'codex-' + p.id, name: p.name, endpoint: p.endpoint, wire_api: p.wire_api,
        key_env: p.key_env, origin: 'codex-config', local: p.local
      });
    }
    for (const s of plan.codex.mcp) {
      connections.push({
        id: s.id, name: s.name, url: s.url, status: 'disconnected', enabled: true,
        local: s.transport === 'stdio',
        ...(s.stdio ? { stdio: s.stdio, env_vars: s.env_vars, startup_timeout_sec: s.startup_timeout_sec } : {}),
        origin: 'codex-config'
      });
    }
  }
  if (plan.claude?.provider?.endpoint) {
    providers.push({
      id: 'claude-imported', name: plan.claude.provider.name, endpoint: plan.claude.provider.endpoint,
      wire_api: 'anthropic', key_env: plan.claude.provider.key_env, origin: 'claude-settings',
      local: plan.claude.provider.local
    });
  }
  return { providers, connections, flags: plan.claude?.flags || [], aliases: plan.claude?.aliases || [], home };
}

// ---------------------------------------------------------------------------
// Export — write the same file back out
// ---------------------------------------------------------------------------
//
// Import without export makes the feature a one-way door: a user who adopts
// ANTICODEX could not hand their setup back to Codex. Everything emitted here is
// the subset `mapCodexConfig` reads, so import(export(x)) is stable.

function tomlString(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function tomlLiteral(v) {
  // For Windows paths: a TOML literal string keeps backslashes as written.
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function isWinPath(v) { return /^[A-Za-z]:\\/.test(String(v || '')); }

/**
 * @param {{model?, provider?, reasoning?, providers?, mcp?, plugins?,
 *          sandbox?, behaviour?, migrations?, notify_hook?}} state
 * @returns {string} a config.toml body
 */
export function exportCodexConfig(state = {}) {
  const out = [];
  const line = (k, v) => { if (v !== undefined && v !== null && v !== '') out.push(`${k} = ${v}`); };

  line('model', state.model ? tomlString(state.model) : undefined);
  line('model_provider', state.provider ? tomlString(state.provider) : undefined);
  line('model_reasoning_effort', state.reasoning ? tomlString(state.reasoning) : undefined);
  if (state.notify_hook?.command) {
    out.push(`notify = [ ${isWinPath(state.notify_hook.command) ? tomlLiteral(state.notify_hook.command) : tomlString(state.notify_hook.command)}, ${tomlString(state.notify_hook.event || 'turn-ended')} ]`);
  }

  for (const p of state.providers || []) {
    if (!p.endpoint) continue;
    const id = p.id.replace(/^codex-/, '');
    out.push('', `[model_providers.${/^[\w-]+$/.test(id) ? id : tomlString(id)}]`);
    out.push(`name = ${tomlString(p.name || id)}`);
    out.push(`base_url = ${isWinPath(p.endpoint) ? tomlLiteral(p.endpoint) : tomlString(p.endpoint)}`);
    if (p.key_env) out.push(`env_key = ${tomlString(p.key_env)}`);
    if (p.requires_openai_auth) out.push('requires_openai_auth = true');
    if (p.wire_api) out.push(`wire_api = ${tomlString(String(p.wire_api).replace('openai-', ''))}`);
  }

  for (const c of state.mcp || []) {
    if (!c.name && !c.id) continue;
    const id = c.id || c.name;
    out.push('', `[mcp_servers.${/^[\w-]+$/.test(id) ? id : tomlString(id)}]`);
    if (c.stdio?.command) {
      out.push(`command = ${isWinPath(c.stdio.command) ? tomlLiteral(c.stdio.command) : tomlString(c.stdio.command)}`);
      out.push(`args = [ ${(c.stdio.args || []).map(tomlString).join(', ')} ]`);
      if (Array.isArray(c.env_vars) && c.env_vars.length) out.push(`env_vars = [ ${c.env_vars.map(tomlString).join(', ')} ]`);
      if (c.startup_timeout_sec) out.push(`startup_timeout_sec = ${Number(c.startup_timeout_sec)}`);
    } else if (c.url && !String(c.url).startsWith('stdio:')) {
      out.push(`url = ${tomlString(c.url)}`);
    }
  }

  for (const p of state.plugins || []) {
    const ref = p.id || (p.marketplace ? `${p.name}@${p.marketplace}` : p.name);
    out.push('', `[plugins.${tomlString(ref)}]`, `enabled = ${p.enabled === false ? 'false' : 'true'}`);
  }

  if (state.sandbox) {
    const mode = typeof state.sandbox === 'string' ? state.sandbox : state.sandbox.mode;
    if (mode) out.push('', '[windows]', `sandbox = ${tomlString(mode === 'danger-full-access' ? 'elevated' : mode)}`);
  }
  if (state.approval) out.push('', '[desktop]', `approvalPolicy = ${tomlString(typeof state.approval === 'string' ? state.approval : state.approval.mode)}`);
  if (state.behaviour) {
    if (!state.approval) out.push('', '[desktop]');
    out.push(`followUpQueueMode = ${tomlString(state.behaviour.follow_up_queue_mode || 'queue')}`);
  }
  if (state.migrations?.length) {
    out.push('', '[notice.model_migrations]');
    for (const m of state.migrations) out.push(`${tomlString(m.from)} = ${tomlString(m.to)}`);
  }
  return out.join('\n') + '\n';
}
