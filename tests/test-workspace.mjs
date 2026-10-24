// Workspace tests — AGENTS.md discovery and the Codex sandbox/approval model.
//
// Expected behaviour is taken from `openai/codex` (Apache-2.0) as cloned on
// 2026-10-24: `codex-rs/protocol/src/protocol.rs` for the two enums and
// `codex-rs/core/src/compact_tests.rs` + `tui/src/status/helpers.rs` for the
// AGENTS.md wrapper and search order. See docs/REA-EVIDENCE.md §9.
//
// Run: node tests/test-workspace.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverAgentDocs, composeInstructions, displayPath,
  normalizeSandboxPolicy, serdeSandboxPolicy, SANDBOX_MODES,
  normalizeApprovalPolicy, serdeApprovalPolicy, APPROVAL_MODES,
  decideApproval, describePolicy, PROJECT_DOC_MAX_BYTES
} from '../lib/workspace.js';
import { parseToml, mapCodexConfig, exportCodexConfig } from '../lib/configimport.js';

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-ws-'));
const home = path.join(tmp, 'codex-home');
const repo = path.join(tmp, 'repo');
const nested = path.join(repo, 'src', 'feature');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(nested, { recursive: true });
fs.writeFileSync(path.join(home, 'AGENTS.md'), 'GLOBAL RULE');
fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'REPO RULE');
fs.writeFileSync(path.join(repo, 'src', 'AGENTS.md'), 'SRC RULE');
fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'NESTED RULE');

console.log('\nAGENTS.md discovery');
{
  const found = discoverAgentDocs({ cwd: nested, codexHome: home, stopAt: repo });
  ok('global doc first', found.docs[0].scope === 'global' && found.docs[0].path === path.join(home, 'AGENTS.md'));
  ok('repo root before the cwd',
    found.docs[1].path === path.join(repo, 'AGENTS.md') && found.docs[2].path === path.join(repo, 'src', 'AGENTS.md'));
  ok('most specific doc last (the cwd has one too)', found.composed.endsWith('NESTED RULE'));
  ok('a doc per directory on the way down',
    found.docs.map((d) => d.scope).join(',') === 'global,project-parent,project-parent,project');
  ok('global comes before project in the text', found.composed.indexOf('GLOBAL RULE') < found.composed.indexOf('REPO RULE'));
  ok('stopAt keeps ancestors out', !found.docs.some((d) => d.path === path.join(tmp, 'AGENTS.md')));
  ok('and never reads above the stop root', found.docs.every((d) => d.path.startsWith(repo) || d.path.startsWith(home)));

  // A directory that was already visited is not read twice…
  const duplicate = discoverAgentDocs({ cwd: nested, codexHome: home, stopAt: repo, nestedPaths: ['src/feature'] });
  ok('re-listing the cwd does not duplicate its doc', duplicate.docs.filter((d) => d.path.endsWith('AGENTS.md')).length === duplicate.docs.length);
  // …but a sibling directory the agent touches is loaded and labelled.
  fs.mkdirSync(path.join(repo, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extra', 'AGENTS.md'), 'EXTRA RULE');
  const withNested = discoverAgentDocs({ cwd: nested, codexHome: home, stopAt: repo, nestedPaths: ['extra'] });
  ok('nested docs load when touched', withNested.composed.endsWith('EXTRA RULE'));
  ok('nested scope labelled', withNested.docs.at(-1).scope === 'nested');

  const escaped = discoverAgentDocs({ cwd: nested, codexHome: home, stopAt: repo, nestedPaths: ['../../../../etc'] });
  ok('a nested path cannot escape the workspace', escaped.docs.every((d) => !d.path.startsWith('/etc')));
}

console.log('\nThe wrapper');
{
  const wrapped = composeInstructions('project', 'do things');
  ok('exact shape', wrapped === '# AGENTS.md instructions for project\n\n<INSTRUCTIONS>\ndo things\n</INSTRUCTIONS>');
  const found = discoverAgentDocs({ cwd: repo, codexHome: home, stopAt: repo });
  ok('instructions use the workspace name', found.instructions.startsWith('# AGENTS.md instructions for repo'));
  ok('display path is ~-relative for the global doc', displayPath(path.join(home, 'AGENTS.md'), repo, home) === '~/.codex/AGENTS.md');
  ok('display path is repo-relative otherwise', displayPath(path.join(repo, 'src', 'AGENTS.md'), repo, home) === 'src/AGENTS.md');
}

console.log('\nByte budget');
{
  const big = path.join(tmp, 'big');
  fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(big, 'AGENTS.md'), 'x'.repeat(PROJECT_DOC_MAX_BYTES + 5000));
  const found = discoverAgentDocs({ cwd: big, codexHome: path.join(tmp, 'empty-home'), stopAt: big });
  ok('default budget is 32 KiB', PROJECT_DOC_MAX_BYTES === 32768);
  ok('over-budget is truncated', found.truncated === true && found.bytes <= PROJECT_DOC_MAX_BYTES);
  ok('the truncation is reported per document', found.docs[0].truncated === true);
  const none = discoverAgentDocs({ cwd: tmp, codexHome: path.join(tmp, 'empty-home') });
  ok('no docs is an empty result, not an error', none.docs.length === 0 && none.instructions === '');
}

console.log('\nSandbox policy');
{
  ok('four modes', Object.keys(SANDBOX_MODES).length === 4 && Boolean(SANDBOX_MODES['danger-full-access']));
  ok('string form', normalizeSandboxPolicy('read-only').mode === 'read-only');
  ok('wire form', normalizeSandboxPolicy({ 'workspace-write': { network_access: true, writable_roots: ['/srv/x'] } }).network_access === true);
  ok('wire form keeps roots', normalizeSandboxPolicy({ 'workspace-write': { writable_roots: ['/srv/x'] } }).writable_roots[0] === '/srv/x');
  ok('object form', normalizeSandboxPolicy({ mode: 'external-sandbox', network_access: true }).mode === 'external-sandbox');
  ok('network as enum', normalizeSandboxPolicy({ 'external-sandbox': { network_access: 'enabled' } }).network_access === true);
  const unknown = normalizeSandboxPolicy('yolo-full-power');
  ok('an unknown mode never escalates', unknown.mode === 'workspace-write' && unknown.coerced_from === 'yolo-full-power');
  ok('undefined is the safe default', normalizeSandboxPolicy(undefined).mode === 'workspace-write');
  ok('serde danger is a bare string', serdeSandboxPolicy('danger-full-access') === 'danger-full-access');
  ok('serde round-trips read-only', normalizeSandboxPolicy(serdeSandboxPolicy({ mode: 'read-only', network_access: true })).network_access === true);
  ok('serde round-trips workspace-write', (() => {
    const p = normalizeSandboxPolicy({ mode: 'workspace-write', network_access: true, writable_roots: ['/a'], exclude_slash_tmp: true });
    const back = normalizeSandboxPolicy(serdeSandboxPolicy(p));
    return back.mode === p.mode && back.network_access === true && back.writable_roots[0] === '/a' && back.exclude_slash_tmp === true;
  })());
}

console.log('\nApproval policy');
{
  ok('four modes', Object.keys(APPROVAL_MODES).length === 4);
  ok('default is on-request', normalizeApprovalPolicy(undefined).mode === 'on-request');
  const legacy = normalizeApprovalPolicy('on-failure');
  ok('on-failure is an alias of on-request', legacy.mode === 'on-request' && legacy.aliased_from === 'on-failure');
  ok('granular defaults to all categories on', normalizeApprovalPolicy('granular').granular.sandbox_approval === true);
  ok('granular wire form', normalizeApprovalPolicy({ granular: { rules: false } }).granular.rules === false);
  ok('granular keeps the other categories', normalizeApprovalPolicy({ granular: { rules: false } }).granular.mcp_elicitations === true);
  ok('serde granular', Object.keys(serdeApprovalPolicy('granular').granular).length === 5);
  ok('serde plain', serdeApprovalPolicy('never') === 'never');
  ok('unknown approval is not "never"', normalizeApprovalPolicy('whatever').mode === 'on-request');
}

console.log('\nThe decision');
{
  const d = (sandbox, approval, action, category) => decideApproval({ sandbox, approval, action, category });
  ok('read-only + never denies a write', d('read-only', 'never', 'write') === 'deny');
  ok('read-only + never allows a read', d('read-only', 'never', 'read') === 'auto');
  ok('read-only + on-request prompts for a write', d('read-only', 'on-request', 'write') === 'prompt');
  ok('workspace-write + on-request auto-runs a write', d('workspace-write', 'on-request', 'write') === 'auto');
  ok('workspace-write keeps the network off', d('workspace-write', 'on-request', 'network') === 'prompt');
  ok('network_access opens the network', d({ mode: 'workspace-write', network_access: true }, 'on-request', 'network') === 'auto');
  ok('untrusted allows reads only', d('workspace-write', 'untrusted', 'read') === 'auto' && d('workspace-write', 'untrusted', 'exec') === 'prompt');
  ok('granular off denies instead of prompting', d('read-only', { mode: 'granular', granular: { sandbox_approval: false } }, 'exec') === 'deny');
  ok('granular on prompts', d('read-only', { mode: 'granular', granular: { sandbox_approval: true } }, 'exec') === 'prompt');
  ok('danger-full-access + never is fully automatic',
    ['read', 'write', 'exec', 'network'].every((a) => d('danger-full-access', 'never', a) === 'auto'));
  ok('one-line description', describePolicy({ sandbox: 'read-only', approval: 'never' }) === 'Read-only (network off) · Never ask');
}

console.log('\nconfig.toml round trip');
{
  const source = `
model = "gpt-6-luna"
model_provider = "omniroute"
[model_providers.omniroute]
name = "OmniRoute"
base_url = "http://localhost:20128/v1"
env_key = "OMNIROUTE_API_KEY"
wire_api = "responses"
[mcp_servers.node_repl]
command = 'C:\\tools\\node_repl.exe'
args = []
env_vars = ["WIN_CORE"]
startup_timeout_sec = 120
[mcp_servers.browseros]
url = "http://127.0.0.1:9010/mcp"
[plugins."pdf@openai-primary-runtime"]
enabled = false
[windows]
sandbox = "elevated"
[desktop]
followUpQueueMode = "steer"
[notice.model_migrations]
"gpt-5.5" = "gpt-6-sol"
`;
  const plan = mapCodexConfig(parseToml(source));
  const toml = exportCodexConfig({
    model: plan.model, provider: plan.default_provider, reasoning: plan.reasoning,
    providers: plan.providers, mcp: plan.mcp, plugins: plan.plugins,
    sandbox: plan.sandbox, behaviour: plan.behaviour, migrations: plan.migrations
  });
  const again = mapCodexConfig(parseToml(toml));
  ok('model survives', again.model === 'gpt-6-luna');
  ok('provider survives', again.providers[0].endpoint === 'http://localhost:20128/v1' && again.providers[0].wire_api === 'openai-responses');
  ok('stdio server survives', again.mcp.find((m) => m.id === 'node_repl')?.transport === 'stdio');
  ok('windows path survives as a literal string', toml.includes("'C:\\tools\\node_repl.exe'"));
  ok('http server survives', again.mcp.find((m) => m.id === 'browseros')?.transport === 'http');
  ok('disabled plugin survives', again.plugins.find((p) => p.name === 'pdf')?.enabled === false);
  ok('steering survives', again.behaviour.follow_up_queue_mode === 'steer');
  ok('migration survives', again.migrations[0].from === 'gpt-5.5' && again.migrations[0].to === 'gpt-6-sol');
  ok('no secrets are invented', !/api[_-]?key\s*=\s*"/i.test(toml));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
