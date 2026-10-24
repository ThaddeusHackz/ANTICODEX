// "Bring your setup" tests — the parser and the mapping, without a server.
//
// The fixtures are the *shape* recovered from two shipped desktop apps:
// a Codex `~/.codex/config.toml` and a Claude `.claude/settings.json` +
// `policy-limits.json`. See docs/REA-EVIDENCE.md for where each key came from.
//
// Run: node tests/test-import-config.mjs

import assert from 'node:assert';
import { parseToml, mapCodexConfig, mapClaudeSettings, buildImportPlan, planToRows } from '../lib/configimport.js';
import { DEFAULT_POLICY, normalizePolicy, policyAllows, flagsFromRestrictions, POLICY_FLAGS } from '../lib/policy.js';

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
function throws(fn, re, name) {
  try { fn(); ok(name, false, '(no throw)'); }
  catch (e) { ok(name, re ? re.test(e.message) : true, e.message); }
}

const CODEX = `
# recovered shape — comments, arrays, inline tables, a quoted dotted key
model = "gpt-6-luna"
model_provider = "omniroute"
model_reasoning_effort = "xhigh"

notify = [ "C:\\\\tools\\\\codex-computer-use.exe", "turn-ended" ]

[model_providers.omniroute]
name = "OmniRoute"
base_url = "http://localhost:20128/v1"
env_key = "OMNIROUTE_API_KEY"
requires_openai_auth = false
wire_api = "responses"

[marketplaces.openai-bundled]
source_type = "local"
source = 'C:\\Users\\User\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled'

[plugins."codex-app-tools@openai-bundled"]
enabled = true

[plugins."pdf@openai-primary-runtime"]
enabled = false

[mcp_servers.node_repl]
args = []
command = 'C:\\tools\\node_repl.exe'
env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_TRUSTED_SERVICES = '{"browser":"C:/x/browser-service.mjs"}'
CODEX_HOME = 'C:\\Users\\User\\.codex'

[mcp_servers.browseros-neo]
url = "http://127.0.0.1:9010/mcp"

[windows]
sandbox = "elevated"

[desktop]
followUpQueueMode = "steer"
toys-confetti-enabled = false
git-always-force-push = true
git-pr-watch-auto-merge = true

[notice.model_migrations]
"gpt-5.5" = "gpt-6-sol"
`;

const CLAUDE_SETTINGS = JSON.stringify({
  enableWorkflows: true,
  hasCompletedOnboarding: true,
  env: {
    ANTHROPIC_BASE_URL: 'http://localhost:20128',
    ANTHROPIC_AUTH_TOKEN: 'sk-test-token-do-not-print-1234',
    ANTHROPIC_MODEL: 'cc/claude-sonnet-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-5'
  }
});

const CLAUDE_POLICY = JSON.stringify({
  restrictions: {
    allow_remote_control: { allowed: false },
    allow_routines: { allowed: false },
    allow_quick_web_setup: { allowed: false },
    enforce_web_search_mcp_isolation: { allowed: true }
  },
  compliance_taints: [],
  monitoring_notice: null,
  defaults: { remote_control_at_startup: false }
});

console.log('\nTOML reader');
{
  const t = parseToml(CODEX);
  ok('scalars', t.model === 'gpt-6-luna' && t.model_reasoning_effort === 'xhigh');
  ok('array of strings', Array.isArray(t.notify) && t.notify[1] === 'turn-ended');
  ok('table', t.model_providers.omniroute.base_url === 'http://localhost:20128/v1');
  ok('booleans unquoted', t.model_providers.omniroute.requires_openai_auth === false);
  ok('literal string keeps backslashes', t.marketplaces['openai-bundled'].source.includes('\\Users\\User'));
  ok('quoted dotted key is one segment', Object.keys(t.plugins).includes('codex-app-tools@openai-bundled'));
  ok('dotted env table', t.mcp_servers.node_repl.env.CODEX_HOME === 'C:\\Users\\User\\.codex');
  ok('number', t.mcp_servers.node_repl.startup_timeout_sec === 120);
  ok('empty array', Array.isArray(t.mcp_servers.node_repl.args) && t.mcp_servers.node_repl.args.length === 0);
  ok('inline table in a string is not parsed as a table',
    typeof t.mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES === 'string');
  ok('comment stripped', parseToml('a = "x#y" # trailing').a === 'x#y');
  ok('migration key survives the dot', t.notice.model_migrations['gpt-5.5'] === 'gpt-6-sol');
}

console.log('\nCodex config → ANTICODEX');
{
  const plan = mapCodexConfig(parseToml(CODEX));
  ok('model surfaced', plan.model === 'gpt-6-luna');
  ok('provider endpoint', plan.providers[0].endpoint === 'http://localhost:20128/v1');
  ok('wire_api translated', plan.providers[0].wire_api === 'openai-responses', plan.providers[0].wire_api);
  ok('local gateway flagged', plan.providers[0].local === true);
  const byId = Object.fromEntries(plan.mcp.map((m) => [m.id, m]));
  ok('stdio server mapped', byId.node_repl.transport === 'stdio' && byId.node_repl.stdio.command.endsWith('node_repl.exe'));
  ok('stdio args default to []', Array.isArray(byId.node_repl.stdio.args));
  ok('http server mapped', byId['browseros-neo'].transport === 'http');
  ok('env var names kept as names', byId.node_repl.env_vars.includes('CODEX_WINDOWS_REGISTERED_CORE'));
  ok('plugin enabled flag', plan.plugins.find((p) => p.name === 'codex-app-tools').enabled === true);
  ok('plugin disabled flag', plan.plugins.find((p) => p.name === 'pdf').enabled === false);
  ok('marketplace scope kept', plan.plugins.find((p) => p.name === 'pdf').marketplace === 'openai-primary-runtime');
  ok('follow-up steering recovered', plan.behaviour.follow_up_queue_mode === 'steer');
  ok('sandbox mode', plan.sandbox === 'elevated');
  ok('migration mapped', plan.migrations[0].from === 'gpt-5.5' && plan.migrations[0].to === 'gpt-6-sol');
  ok('turn-ended hook', plan.notify_hook.event === 'turn-ended' && plan.notify_hook.command.endsWith('.exe'));
  ok('no warnings on a complete file', plan.warnings.length === 0, JSON.stringify(plan.warnings));
  ok('a server with neither command nor url is a warning, not a crash', (() => {
    const p = mapCodexConfig(parseToml('[mcp_servers.broken]\nargs = []'));
    return p.mcp.length === 0 && p.warnings.length === 1;
  })());
}

console.log('\nClaude settings → ANTICODEX');
{
  const m = mapClaudeSettings(JSON.parse(CLAUDE_SETTINGS), JSON.parse(CLAUDE_POLICY));
  ok('base url', m.provider.endpoint === 'http://localhost:20128');
  ok('token detected', m.provider.has_token === true);
  ok('local gateway', m.provider.local === true);
  ok('aliases', m.aliases.find((a) => a.role === 'opus')?.model === 'cc/claude-opus-5');
  ok('flags from restrictions', m.flags.find((f) => f.key === 'allow_routines')?.allowed === false);
  ok('explicit true kept', m.flags.find((f) => f.key === 'enforce_web_search_mcp_isolation')?.allowed === true);
  const dumped = JSON.stringify(m);
  ok('the auth token is never echoed back', !dumped.includes('sk-test-token-do-not-print-1234'));
}

console.log('\nPlan + rows');
{
  const plan = buildImportPlan({ codex_toml: CODEX, claude_settings: CLAUDE_SETTINGS, claude_policy: CLAUDE_POLICY });
  ok('plan ok', plan.ok === true);
  ok('summary counts', plan.summary.providers === 2 && plan.summary.mcp === 2 && plan.summary.plugins === 2);
  ok('summary flags/aliases', plan.summary.flags === 4 && plan.summary.aliases >= 2);
  const rows = planToRows(plan);
  ok('rows carry providers', rows.providers.length === 2);
  ok('rows carry connections', rows.connections.length === 2);
  ok('rows carry no provider key material', !JSON.stringify(rows).includes('sk-test-token'));
  ok('broken json is reported, not thrown', (() => {
    const bad = buildImportPlan({ claude_settings: '{ not json' });
    return bad.ok === false && bad.warnings.some((w) => w.includes('could not be parsed'));
  })());
  ok('empty input is an empty plan', (() => {
    const e = buildImportPlan({});
    return e.ok === true && e.summary.providers === 0;
  })());
}

console.log('\nPolicy');
{
  ok('defaults are the documented ones', DEFAULT_POLICY.flags.allow_local_mcp === true && DEFAULT_POLICY.flags.allow_remote_control === false);
  ok('unknown capability is denied', policyAllows(DEFAULT_POLICY, 'allow_everything') === false);
  ok('flag lookup', policyAllows({ flags: { telemetry: true } }, 'telemetry') === true);
  ok('restriction-shaped input accepted', normalizePolicy({ allow_routines: { allowed: true } }).flags.allow_routines === true);
  ok('non-boolean ignored', normalizePolicy({ flags: { telemetry: 'yes' } }).flags.telemetry === false);
  ok('queue mode defaults to queue', normalizePolicy({}).defaults.follow_up_queue_mode === 'queue');
  ok('steer mode kept', normalizePolicy({ defaults: { follow_up_queue_mode: 'steer' } }).defaults.follow_up_queue_mode === 'steer');
  ok('restrictions → flags', flagsFromRestrictions({ allow_routines: { allowed: false } }).allow_routines === false);
  ok('every flag has a label and a detail', Object.values(POLICY_FLAGS).every((f) => f.label && f.detail && typeof f.default === 'boolean'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
