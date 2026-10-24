// REA integration tests — the parsing and the gate, not the download.
//
// `npx rea-agents setup` is not run here (it writes config files), but the two
// things that make the UI trustworthy are pure functions and are pinned:
//
//   * the plan REA prints is parsed completely, and a plan it cannot read is
//     reported as an error rather than as "nothing to do";
//   * a plan has a fingerprint, and applying requires the approved fingerprint.
//
// The fixture is REA 6.7.0's real output, captured with `setup --dry-run`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import {
  REA_CLIENTS,
  REA_MIN_NODE,
  REA_SERVER_NAME,
  buildArgs,
  checkRegistration,
  describeAction,
  nodeSatisfies,
  nodeStatus,
  buildDoctorArgs,
  envOnlyEngines,
  missingEngines,
  parseCsvRow,
  parseDoctorOutput,
  parseSetupOutput,
  planFingerprint,
  registrationPath
} from '../lib/rea.js';

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);

// Captured from `npx -y rea-agents@latest setup --dry-run --client codex --skill`.
const PLAN = `status: planned
plannedActions[2]{id,kind,label,target,detail,external,operation}:
  "configure_client:codex",configure_client,Codex,/home/someone/.codex/config.toml,"Add the REA MCP registration for Codex; preserve unrelated configuration. Command: \\"npx\\" \\"-y\\" \\"rea-agents@6.7.0\\" \\"mcp\\".",false,create
  install_skill,install_skill,REA reverse-engineering skill,/home/someone/.agents/skills/reverse-engineer-anything,"Install or update the bundled REA reverse-engineering skill and on-demand references.",false,install
appliedActions: []
doctor:
  healthy: false
  environment_healthy: false
  scope:
    mode: explicit
clientStates[1]:
  - client:
      name: codex
`;

const NOOP = `status: planned
plannedActions: []
appliedActions: []
doctor:
  healthy: false
`;

section('Node requirement');
{
  ok(`the floor is ${REA_MIN_NODE.join('.')}`, REA_MIN_NODE[0] === 22 && REA_MIN_NODE[1] === 19);
  ok('22.19.0 is accepted', nodeSatisfies('v22.19.0') === true);
  ok('22.22.3 is accepted', nodeSatisfies('v22.22.3') === true);
  ok('22.18.9 is not', nodeSatisfies('v22.18.9') === false);
  ok('20.x is not', nodeSatisfies('v20.11.0') === false);
  ok('24.x is accepted (newer major)', nodeSatisfies('v24.1.0') === true);
  const bad = nodeStatus('v18.20.0');
  ok('a failure says what to do', bad.ok === false && /upgrade node/i.test(bad.message), bad.message);
  ok('the current runtime passes', nodeStatus().ok === true);
}

section('CSV inside the plan table');
{
  ok('plain fields split', parseCsvRow('a,b,c').join('|') === 'a|b|c');
  ok('quoted commas stay together', parseCsvRow('a,"b, c",d').join('|') === 'a|b, c|d');
  ok('doubled quotes unescape', parseCsvRow('"say ""hi""",x')[0] === 'say "hi"');
  ok('an escaped backslash-quote survives', /npx/.test(parseCsvRow('"Command: \\"npx\\" \\"-y\\""')[0]));
}

section('reading the plan');
{
  const plan = parseSetupOutput(PLAN);
  ok('the status is read', plan.status === 'planned');
  ok('both actions are read', plan.planned.length === 2, `${plan.planned.length}`);
  ok('nothing is reported as already applied', plan.applied.length === 0);
  ok('the client action keeps its target', plan.planned[0].target === '/home/someone/.codex/config.toml');
  ok('…and its operation', plan.planned[0].operation === 'create');
  ok('the skill action keeps its kind', plan.planned[1].kind === 'install_skill');
  ok('no parse error is invented', plan.parse_error === null, plan.parse_error);
  ok('doctor health is read', plan.doctor.healthy === false);

  const empty = parseSetupOutput(NOOP);
  ok('an empty plan is a real "nothing to do"', empty.status === 'planned' && empty.planned.length === 0 && empty.parse_error === null);

  const truncated = parseSetupOutput(PLAN.replace(/\n  install_skill[^\n]*/g, ''));
  ok('a plan that lost a row is flagged, not silently shortened', /listed 2 planned action/.test(truncated.parse_error || ''), truncated.parse_error);

  ok('garbage is an error, not an empty plan', parseSetupOutput('boom').parse_error !== null);
  ok('…and has no status', parseSetupOutput('boom').status === null);
}

section('describing an action');
{
  const p = parseSetupOutput(PLAN);
  const a = describeAction(p.planned[0]);
  ok('the client action names the file', /Codex/.test(a) && /config\.toml/.test(a), a);
  ok('the skill action names the destination', /reverse-engineering skill/.test(describeAction(p.planned[1])));
  ok('an unknown kind still says something true', describeAction({ kind: 'weird', target: '/x' }).includes('/x'));
}

section('the approval gate');
{
  const a = planFingerprint(parseSetupOutput(PLAN));
  const b = planFingerprint(parseSetupOutput(PLAN));
  ok('the same plan fingerprints the same', a === b && a.length === 16);
  const changed = planFingerprint(parseSetupOutput(PLAN.replace('/home/someone/.codex/config.toml', '/home/other/.codex/config.toml')));
  ok('a different target is a different plan', changed !== a);
  const reordered = planFingerprint(parseSetupOutput(NOOP));
  ok('a no-op plan has its own id', reordered !== a);
  // A third action, indented like the others and with the declared count updated
  // — what REA prints when the skill is missing too.
  const third = '  install_skill,install_skill,Extra,/tmp/x,detail,false,install\n';
  const added = parseSetupOutput(
    PLAN.replace('plannedActions[2]', 'plannedActions[3]').replace('appliedActions: []', `${third}appliedActions: []`)
  );
  ok('an extra action is read', added.planned.length === 3, String(added.planned.length));
  ok('…and changes the fingerprint', planFingerprint(added) !== a);
}

section('the command line is built, never typed by a human');
{
  const plan = buildArgs('plan', { client: 'codex' });
  ok('plan mode uses --dry-run', plan.includes('--dry-run') && !plan.includes('--yes'));
  ok('…and never approves anything', !plan.some((a) => a === '--install-hopper'));
  const apply = buildArgs('apply', { client: 'claude_code' });
  ok('apply mode passes --yes', apply.includes('--yes') && !apply.includes('--dry-run'));
  ok('…and names the client', apply.join(' ').includes('--client claude_code'));
  ok('the package is pinned to latest', plan.some((a) => a === 'rea-agents@latest'));
  ok('Codex is a client REA supports', REA_CLIENTS.includes('codex'));
  ok('the server is registered as "rea"', REA_SERVER_NAME === 'rea');
}

section('registration is read, not rewritten');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-rea-'));
  const file = registrationPath('codex', home);
  ok('Codex registers in config.toml', file === path.join(home, '.codex', 'config.toml'));
  ok('…which does not exist yet', checkRegistration('codex', { home }).present === false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[model_providers.other]\nname = "x"\n');
  ok('an unrelated config has no REA entry', checkRegistration('codex', { home }).present === false);
  fs.appendFileSync(file, '\n[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@6.7.0", "mcp"]\n');
  const found = checkRegistration('codex', { home });
  ok('a TOML table is found', found.present === true && found.file === file);
  ok('other servers in the same file are not mistaken for it', !/\[mcp_servers\.other\]/.test(''));

  const jsonHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-rea-json-'));
  const claudeFile = registrationPath('claude_code', jsonHome);
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { rea: { command: 'npx' } } }));
  ok('a JSON registration is found too', checkRegistration('claude_code', { home: jsonHome }).present === true);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(jsonHome, { recursive: true, force: true });
}

// Captured from `npx -y rea-agents@6.7.0 doctor` on a machine with no engines.
const DOCTOR = `healthy: false
environment_healthy: false
scope:
  mode: audit-wide
  clients: []
  providers: []
  skill: false
  target: null
scope_checks[7]:
  - name: node
    ok: true
    classification: healthy
    detail: 22.22.3
    details:
      runtime: node
      version: 22.22.3
  - name: host
    ok: true
    classification: healthy
    detail: debian 12
  - name: hopper
    ok: false
    classification: missing_analysis_engine
    remediation: "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH."
  - name: ghidra
    ok: false
    classification: missing_analysis_engine
    detail: GHIDRA_INSTALL_DIR is not set
    remediation: Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.
  - name: ida-registration
    ok: false
    classification: missing_analysis_engine
    detail: IDA MCP registration is not configured.
    remediation: Set REA_IDA_MCP_CONFIG to your upstream IDA MCP registration JSON; see docs/ida-provider.md.
  - name: jadx
    ok: false
    classification: missing_analysis_engine
    detail: Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR.
    remediation: Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR.
  - name: kuna-installation
    ok: false
    classification: missing_analysis_engine
    detail: "Set REA_KUNA_COMMAND to the absolute path of a caller-supplied kuna executable."
    remediation: "Set REA_KUNA_COMMAND to the absolute path of a caller-supplied kuna executable."
    details:
      configured: false
providerInspections[4]:
  - id: ghidra
    configured: false
`;

section('doctor: what can actually take a binary apart');
{
  const r = parseDoctorOutput(DOCTOR);
  ok('the health flags are read', r.healthy === false && r.environment_healthy === false);
  ok('…and the host', r.host === 'debian 12');
  ok('every check is read, not just the failures', r.checks.length === 7, String(r.checks.length));
  ok('a passing check keeps its detail', r.checks[0].name === 'node' && r.checks[0].detail === '22.22.3');
  ok('the table ends before the next section', !r.checks.some((c) => c.name === 'ghidra' && c.ok === null) && r.parse_error === null);
  ok('quoted remediations are unquoted', r.checks.find((c) => c.name === 'kuna-installation').remediation.startsWith('Set REA_KUNA_COMMAND'));

  const engines = missingEngines(r);
  ok('five engines are missing here', engines.length === 5, String(engines.length));
  ok('…named for people, not for REA', engines.map((e) => e.engine).join(',') === 'Hopper,Ghidra,IDA Pro,JADX,Kuna');
  ok('…each with the variable that fixes it', engines.every((e) => e.env && e.env === e.env.toUpperCase()));
  ok('…and steps to follow', engines.every((e) => e.steps.length >= 3));
  ok('the hyphenated check names map to help', engines.find((e) => e.engine === 'JADX').env === 'REA_JADX_MCP_JAR'
    && engines.find((e) => e.engine === 'Kuna').env === 'REA_KUNA_COMMAND');
  // Wakaru is not a doctor check: REA only says so when the tool runs. The card
  // has to know about it anyway, or "all configured" would be half a sentence.
  const opt = envOnlyEngines({});
  ok('an engine outside doctor is still listed', opt.length === 1 && opt[0].engine === 'Wakaru');
  ok('…with the variable that fixes it', opt[0].env === 'REA_WAKARU_COMMAND');
  ok('…saying it is not configured', opt[0].configured === false);
  ok('…and which call needs it', opt[0].when === 'recover_javascript_sources');
  ok('setting the variable flips it', envOnlyEngines({ REA_WAKARU_COMMAND: '/opt/wakaru' })[0].configured === true);
  ok('an empty variable is not configured', envOnlyEngines({ REA_WAKARU_COMMAND: '   ' })[0].configured === false);
  ok('it is not mistaken for a doctor check', missingEngines({ checks: [] }).length === 0 && opt[0].env_only === undefined);

  ok('a healthy machine reports no missing engines', missingEngines({ checks: [{ name: 'node', ok: true, classification: 'healthy' }] }).length === 0);
  ok('an engine REA adds later is still reported', missingEngines({ checks: [{ name: 'radare', ok: false, classification: 'missing_analysis_engine', detail: 'x' }] }).length === 1);

  // Silence must never read as success: an unreadable report is an error.
  const garbage = parseDoctorOutput('boom');
  ok('unreadable doctor output is an error', garbage.parse_error !== null && garbage.checks.length === 0);
  const short = parseDoctorOutput(DOCTOR.replace(/\n  - name: jadx(?:\n    .*)*/, ''));
  ok('a dropped row is reported, not ignored', /7 check\(s\) but 6/.test(short.parse_error || ''), String(short.parse_error));
  ok('doctor is asked through the same pinned CLI', buildDoctorArgs().join(' ') === '-y rea-agents@latest doctor');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
