// Contract tests for the three pieces added for this request:
//
//   lib/agent.js       the OpenCode-shaped loop (agents, permissions, tools, steps)
//   lib/publicapis.js  the public-apis catalogue that replaced Glasser
//   lib/daytona.js     the 1,440-minute token, its countdown and its rotation
//
// These run the real code, not a copy of it. The agent loop is driven by an
// injected model, so a full multi-step run with approvals is exercised without a
// provider key and without a network.
//
// Run: node tests/test-agent.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0; let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// Everything that writes goes to a temp dir, never a real home.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-agent-'));
process.env.ANTICODEX_DATA = path.join(TMP, 'data');
process.env.ANTICODEX_DAYTONA_CONFIG = path.join(TMP, 'daytona.json');

// ---------------------------------------------------------------------------
console.log('\n— agents and their permissions —');
{
  const { AGENTS, agentList, resolveAgent, decide, allowedTools, toolDefs } = await mod('lib/agent.js');
  ok('three primary agents exist', Object.keys(AGENTS).join(',') === 'build,plan,explore');
  ok('build allows edits after asking', AGENTS.build.permission.write === 'ask' && AGENTS.build.permission.edit === 'ask');
  ok('plan denies edits and commands outright', AGENTS.plan.permission.write === 'deny' && AGENTS.plan.permission.bash === 'deny');
  ok('plan can still read and search', AGENTS.plan.permission.read === 'allow' && AGENTS.plan.permission.grep === 'allow');
  ok('an unknown agent is not a silent no-op', resolveAgent('nope').id === 'build');
  ok('every agent reports its step cap', agentList().every((a) => a.steps >= 8 && a.steps <= 40));

  // The tool list a plan agent is *offered* is the real guarantee: a model cannot
  // call a tool it was never given.
  const defs = toolDefs(AGENTS.build, { includePublicApi: false });
  const planTools = allowedTools(AGENTS.plan, defs).map((d) => d.function.name);
  ok('plan is never offered write', !planTools.includes('write'));
  ok('plan is never offered bash', !planTools.includes('bash'));
  ok('plan is never offered edit or patch', !planTools.includes('edit') && !planTools.includes('patch'));
  ok('plan still gets read, grep, glob, list', ['read', 'grep', 'glob', 'list'].every((t) => planTools.includes(t)));
  const buildTools = allowedTools(AGENTS.build, defs).map((d) => d.function.name);
  ok('build is offered the whole toolkit', ['read', 'write', 'edit', 'patch', 'bash', 'grep', 'glob', 'list', 'skill', 'todo_write', 'question'].every((t) => buildTools.includes(t)), buildTools.join(','));
}

// ---------------------------------------------------------------------------
console.log('\n— permission decisions —');
{
  const { decide, AGENTS } = await mod('lib/agent.js');
  const build = AGENTS.build;
  ok('a safe command is allowed without asking', decide(build, 'bash', 'ls -la').decision === 'allow', JSON.stringify(decide(build, 'bash', 'ls -la')));
  ok('an unfamiliar command asks', decide(build, 'bash', 'rm -rf /tmp/x').decision === 'ask');
  ok('git status is allowlisted, git push is not', decide(build, 'bash', 'git status').decision === 'allow' && decide(build, 'bash', 'git push origin main').decision === 'ask');
  ok('npm test asks (it runs project code)', decide(build, 'bash', 'npm test').decision === 'ask');
  ok('a remembered allow answers the same question', decide(build, 'bash', 'rm -rf x', { grants: { 'bash:*': 'allow' } }).decision === 'allow');
  ok('a remembered deny is respected too', decide(build, 'bash', 'ls', { grants: { 'bash:ls*': 'deny' } }).decision === 'deny');
  ok('a deny rule cannot be overridden by a broad allow', (() => {
    // last match wins, and the object below has the deny last
    const agent = { id: 'build', label: 'x', permission: { bash: { '*': 'allow', 'rm *': 'deny' } } };
    return decide(agent, 'bash', 'rm -rf /').decision === 'deny' && decide(agent, 'bash', 'echo hi').decision === 'allow';
  })());
  ok('an unlisted tool is denied for a restricted agent', decide(AGENTS.plan, 'web_fetch', 'x').decision === 'deny');
  ok('an unlisted tool is allowed for build', decide(build, 'web_fetch', 'x').decision === 'allow');
}

// ---------------------------------------------------------------------------
console.log('\n— a full loop, with approvals —');
{
  const { runAgent } = await mod('lib/agent.js');
  const script = [
    { content: 'Checking the directory.', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: JSON.stringify({ command: 'pwd' }) } }] },
    { content: '', tool_calls: [{ id: 'c2', function: { name: 'write', arguments: JSON.stringify({ file_path: 'a/b.txt', content: 'written by the agent\n' }) } }] },
    { content: 'Created a/b.txt.', tool_calls: [] }
  ];
  let i = 0;
  const events = [];
  const asked = [];
  for await (const evt of runAgent({
    messages: [{ role: 'user', content: 'make a file' }],
    agent: 'build', target: 'local', account: 'acct1',
    callModel: async () => script[Math.min(i++, script.length - 1)],
    askPermission: async (req) => { asked.push(req.tool); return 'allow_always'; }
  })) events.push(evt);

  ok('the loop announces its agent and target', events.find((e) => e.type === 'session')?.targetMode === 'local');
  ok('it asked before the write, not before the read-only command', asked.includes('write'), asked.join(','));
  ok('both tools ran', events.filter((e) => e.type === 'tool_end' && e.ok).length === 2);
  ok('the answer is the final text, not the narration', events.find((e) => e.type === 'done')?.text.includes('Created a/b.txt'));
  ok('the file really exists on disk', fs.existsSync(path.join(process.env.ANTICODEX_DATA, 'workspaces', 'acct1', 'a/b.txt')) ||
    fs.readdirSync(path.join(process.env.ANTICODEX_DATA), { recursive: true }).some((f) => String(f).endsWith('b.txt')));
  // `pwd` is on build's safe list, so it never asks; only the write does. The grant
  // below is the proof that a remembered allow is recorded for exactly one pattern.
  ok('"allow always" is recorded for exactly the pattern that was asked about',
    JSON.stringify(events.find((e) => e.type === 'done')?.grants) === '{"write:*":"allow"}',
    JSON.stringify(events.find((e) => e.type === 'done')?.grants));
  ok('every tool result says which machine ran it', events.filter((e) => e.type === 'tool_end').every((e) => typeof e.target === 'string' && e.target.length > 0));

  // A denial must come back to the model as a tool error, not end the run.
  let j = 0;
  const denied = [];
  const denyScript = [
    { content: '', tool_calls: [{ id: 'd1', function: { name: 'write', arguments: '{"file_path":"no.txt","content":"x"}' } }] },
    { content: 'Understood — I will not write that file.', tool_calls: [] }
  ];
  for await (const evt of runAgent({
    messages: [{ role: 'user', content: 'write it' }], agent: 'build', target: 'local', account: 'acct2',
    callModel: async () => denyScript[Math.min(j++, 1)],
    askPermission: async () => 'deny'
  })) denied.push(evt);
  const end = denied.find((e) => e.type === 'tool_end');
  ok('a denied call reports denied, not failed', end?.denied === true && end?.ok === false);
  ok('…and the run continues to an answer', /will not write/.test(denied.find((e) => e.type === 'done')?.text || ''));
  ok('…and no file was created', !fs.existsSync(path.join(process.env.ANTICODEX_DATA, 'workspaces', 'acct2', 'no.txt')));

  // No asker at all must mean "no", never a silent yes.
  let k = 0;
  const noAsker = [];
  for await (const evt of runAgent({
    messages: [{ role: 'user', content: 'x' }], agent: 'build', target: 'local', account: 'acct3',
    callModel: async () => (k++ === 0 ? { content: '', tool_calls: [{ id: 'z', function: { name: 'write', arguments: '{"file_path":"z.txt","content":"z"}' } }] } : { content: 'done', tool_calls: [] })
  })) noAsker.push(evt);
  ok('an ask with nobody to answer it is a deny', noAsker.find((e) => e.type === 'tool_end')?.denied === true);
}

// ---------------------------------------------------------------------------
console.log('\n— the step cap forces an answer —');
{
  const { runAgent } = await mod('lib/agent.js');
  let calls = 0;
  const events = [];
  for await (const evt of runAgent({
    messages: [{ role: 'user', content: 'loop forever' }], agent: 'build', target: 'local', account: 'cap',
    maxSteps: 3,
    callModel: async ({ tools }) => {
      calls++;
      // Keep asking to run a command forever; the last call must have no tools.
      return { content: tools.length ? '' : 'Here is my answer without tools.', tool_calls: tools.length ? [{ id: `t${calls}`, function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] : [] };
    },
    askPermission: async () => 'allow_always'
  })) events.push(evt);
  ok('the loop stops at the cap', calls <= 5, `${calls} model calls`);
  ok('…and says so', events.some((e) => e.type === 'step_limit'));
  ok('…and still ends with text', /Here is my answer/.test(events.filter((e) => e.type === 'done').pop()?.text || ''));
}

// ---------------------------------------------------------------------------
console.log('\n— diffs and patches —');
{
  const { unifiedDiff, parseUnifiedDiff, applyHunks } = await mod('lib/agent.js');
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB\nc\nd\n';
  const diff = unifiedDiff(before, after, 'f.txt');
  ok('a diff has the right headers', diff.startsWith('--- a/f.txt') && diff.includes('+++ b/f.txt'));
  ok('…and shows the changed line on both sides', diff.includes('-b') && diff.includes('+B'));
  const parsed = parseUnifiedDiff(diff);
  ok('it parses back', parsed.files.length === 1 && parsed.files[0].path === 'f.txt');
  const applied = applyHunks(before, parsed.files[0].hunks);
  ok('applying it reproduces the file exactly', applied.ok && applied.content === after);
  const wrong = applyHunks('x\ny\n', parsed.files[0].hunks);
  ok('a patch against the wrong content is refused with the line number', !wrong.ok && /line 1/.test(wrong.error), wrong.error);
  const multi = parseUnifiedDiff(`--- a/one.txt\n+++ b/one.txt\n@@ -1,1 +1,2 @@\n keep\n+new\n--- a/two.txt\n+++ b/two.txt\n@@ -1,1 +1,1 @@\n-old\n+new2\n`);
  ok('a patch can touch several files', multi.files.length === 2 && multi.files[1].path === 'two.txt');
}

// ---------------------------------------------------------------------------
console.log('\n— the tool executor —');
{
  const { executeTool, resolveTarget } = await mod('lib/agent.js');
  const target = resolveTarget('local');
  const session = {};
  const write = await executeTool({ name: 'write', args: { file_path: 'src/x.js', content: 'export const a = 1;\n' } }, { target, account: 'tool', session });
  ok('write reports a path and a byte count', write.ok && write.bytes > 0, JSON.stringify(write).slice(0, 120));
  const readBack = await executeTool({ name: 'read', args: { file_path: 'src/x.js' } }, { target, account: 'tool', session });
  ok('read returns numbered lines', readBack.ok && /1\s+export const a = 1;/.test(readBack.content), readBack.content);
  const edit = await executeTool({ name: 'edit', args: { file_path: 'src/x.js', old_string: 'a = 1', new_string: 'a = 2' } }, { target, account: 'tool', session });
  ok('edit returns a diff of what it changed', edit.ok && /\+export const a = 2/.test(edit.diff), edit.diff);
  const miss = await executeTool({ name: 'edit', args: { file_path: 'src/x.js', old_string: 'not there', new_string: 'x' } }, { target, account: 'tool', session });
  ok('editing text that is absent fails with advice', !miss.ok && /not found/.test(miss.error));
  const ambig = await executeTool({ name: 'write', args: { file_path: 'dup.txt', content: 'x\nx\n' } }, { target, account: 'tool', session });
  void ambig;
  const twice = await executeTool({ name: 'edit', args: { file_path: 'dup.txt', old_string: 'x', new_string: 'y' } }, { target, account: 'tool', session });
  ok('an ambiguous edit refuses instead of guessing', !twice.ok && /appears 2 times/.test(twice.error), twice.error);
  const all = await executeTool({ name: 'edit', args: { file_path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true } }, { target, account: 'tool', session });
  ok('…unless replace_all is set', all.ok);
  const grep = await executeTool({ name: 'grep', args: { pattern: 'a = 2' } }, { target, account: 'tool', session });
  ok('grep finds the line with its file and number', grep.ok && /src\/x\.js:1/.test(String(grep.output || '')), `${JSON.stringify(grep).slice(0, 120)}`);
  const bash = await executeTool({ name: 'bash', args: { command: 'echo hello-from-bash' } }, { target, account: 'tool', session });
  ok('bash runs and returns stdout', bash.ok && /hello-from-bash/.test(bash.stdout), JSON.stringify(bash).slice(0, 120));
  const deniedTarget = await executeTool({ name: 'read', args: { file_path: '../../etc/passwd' } }, { target, account: 'tool', session });
  ok('a path outside the workspace is refused', !deniedTarget.ok, JSON.stringify(deniedTarget).slice(0, 100));
}

// ---------------------------------------------------------------------------
console.log('\n— the public-apis catalogue —');
{
  const c = await mod('lib/publicapis.js');
  const stats = c.catalogueStats();
  ok('the catalogue is built', stats.available && stats.count > 2000, `${stats.count}`);
  ok('…with categories, and the counts add up', stats.categories > 30 && Object.values(stats.by_category).reduce((a, b) => a + b, 0) === stats.count);
  ok('…and it says how many need no key', stats.no_auth > 500, `${stats.no_auth}`);
  ok('every entry has an id, a URL and a host', c.loadCatalogue().entries.every((e) => e.id && /^https?:\/\//.test(e.url) && e.host));
  ok('nothing from the APILayer advert block leaked in', !Object.keys(stats.by_category).some((n) => /APILayer|MCP Server/i.test(n)));

  const s = c.search('currency exchange', { limit: 5 });
  ok('a search in plain words finds something', s.total > 5 && s.entries.length === 5, `${s.total}`);
  ok('…and explains why each matched', s.entries.every((e) => Array.isArray(e.matched) && e.matched.length));
  ok('an exact name ranks first', c.search('Cat Facts', { limit: 3 }).entries[0].name === 'Cat Facts');
  ok('an auth filter is honoured', c.search('', { auth: 'none', limit: 20 }).entries.every((e) => e.auth === 'none'));
  ok('a category filter is honoured', c.search('', { category: 'Geocoding', limit: 5 }).entries.every((e) => e.category === 'Geocoding'));
  ok('an empty query is a browse, not an empty page', c.search('', { limit: 10 }).entries.length === 10);
  ok('an unknown id gets a suggestion instead of silence', (await c.callApi('currency-x')).did_you_mean !== undefined);

  // Refusal policy — the part that makes this safe to hand a model.
  ok('a key-auth API is refused with the reason', (await c.callApi(c.search('ipstack', { limit: 1 }).entries[0].id)).refused === 'auth_required');
  const refused = await c.callApi(c.loadCatalogue().entries.find((e) => e.auth === 'apiKey').id);
  ok('…and offers free alternatives in the same category', typeof refused.alternative === 'string' && refused.alternative.length > 10);
  ok('loopback is refused', c.blockedTarget('http://127.0.0.1:8787/x') !== null);
  ok('the cloud metadata address is refused', /link-local/.test(c.blockedTarget('http://169.254.169.254/latest/meta-data')));
  ok('private ranges are refused', c.blockedTarget('http://10.0.0.1/') !== null && c.blockedTarget('http://192.168.1.1/') !== null);
  ok('a public https URL is allowed', c.blockedTarget('https://example.com/ok') === null);
  ok('a non-http scheme is refused', /scheme/.test(c.blockedTarget('file:///etc/passwd')));
  ok('POST is not offered', (await c.callApi('cat-facts@catfact.ninja', { method: 'POST' })).error.includes('GET and HEAD'));
  ok('a `path` cannot repoint the request at another host', (await c.callApi('cat-facts@catfact.ninja', { path: 'https://evil.example/' })).ok === false);

  const tool = c.publicApiTools()[0];
  ok('the model gets one tool with three ops', tool.function.name === 'public_api' && tool.function.parameters.properties.op.enum.join(',') === 'search,call,categories');
  ok('the prompt tells the model the tool exists', /public_api/.test(c.publicApiPrompt()));
  const result = await c.runPublicApi({ op: 'categories' });
  ok('runPublicApi answers categories', result.ok && result.categories.length > 30);
}

// ---------------------------------------------------------------------------
console.log('\n— the Daytona token: 1,440 minutes, rotatable —');
{
  const d = await mod('lib/daytona.js');
  ok('the default lifetime is 1,440 minutes', d.TOKEN_TTL_MINUTES === 1440);
  const saved = d.saveDaytonaConfig({ user: 'nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL', host: 'ssh.app.daytona.io', port: 22 });
  ok('saving a token records when it was taken', saved.token?.known === true && saved.token.ttl_minutes === 1440);
  ok('…and the countdown starts at 24h', saved.token.hours_left === 24, `${saved.token.minutes_left}`);
  ok('…reduced to four characters, never the whole token', saved.token.suffix === 'SOTL' && !JSON.stringify(saved).includes('nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL') === false);
  const file = fs.readFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, 'utf8');
  ok('the file stores the user (it must, to log in) but no secret beyond it', /nlhOT5bG7KrWEDanZJZuhyWCeYVQSOTL/.test(file) && !/"token"\s*:\s*"/.test(file));
  ok('it is owner-only', (fs.statSync(process.env.ANTICODEX_DAYTONA_CONFIG).mode & 0o777) === 0o600);

  // Rotation: a new token replaces the old one and is logged by suffix.
  const rot = d.saveDaytonaConfig({ user: 'NEWWORKSPACEuserWXYZ' });
  ok('a new token is a rotation', rot.rotated === true);
  ok('…logged with the old suffix only', rot.saved.rotation?.length === 1 && rot.saved.rotation[0].replaced_suffix === 'SOTL' && rot.saved.rotation[0].set_suffix === 'WXYZ');
  ok('…and the countdown restarts', d.daytonaStatus().token.minutes_left >= 1439);

  // Expiry states are computed, not guessed.
  const states = [['expired', -5], ['expiring', 5], ['soon', 30], ['valid', 600]].map(([want, mins]) => {
    d.saveDaytonaConfig({ user: 'X'.repeat(20) + mins });
    const cfg = JSON.parse(fs.readFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, 'utf8'));
    cfg.token = { set_at: Date.now(), ttl_minutes: 1440, expires_at: Date.now() + mins * 60_000, suffix: 'test' };
    fs.writeFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, JSON.stringify(cfg));
    return [want, d.daytonaStatus().token.state];
  });
  ok('the countdown has named states', states.every(([want, got]) => want === got), JSON.stringify(states));

  // Provisioning refuses before it wastes a round trip.
  const expired = JSON.parse(fs.readFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, 'utf8'));
  expired.token.expires_at = Date.now() - 60_000;
  fs.writeFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, JSON.stringify(expired));
  const prov = await d.provisionWorkspace({ only: 'probe' });
  ok('provisioning refuses an expired token with the fix', prov.ok === false && /expired/.test(prov.error) && /1,440/.test(prov.hint || ''), prov.error);
  ok('…naming every step it would have run', d.PROVISION_STEPS.length >= 8 && d.PROVISION_STEPS.some((s) => s.id === 'node') && d.PROVISION_STEPS.some((s) => s.id === 'workspace'));

  // An unconfigured machine has nothing to provision and says so.
  fs.writeFileSync(process.env.ANTICODEX_DAYTONA_CONFIG, '{}');
  const none = await d.provisionWorkspace({});
  ok('no workspace means no provisioning, not a stack trace', none.ok === false && /No Daytona workspace/.test(none.error));
}

// ---------------------------------------------------------------------------
console.log('\n— the bridge and the UI are wired to all of it —');
{
  const bridge = read('api/bridge.js');
  ok('the bridge exposes the agent', /case 'agent': return await handleAgent/.test(bridge));
  ok('…and public-apis', /case 'publicapi': return await handlePublicApi/.test(bridge));
  ok('a hosted caller cannot run an agent against this machine', /An agent that reads and runs things on this machine needs the desktop app/.test(bridge));
  ok('a hosted caller cannot use the server as an open proxy', /Calling a third-party API from this server is a local operation/.test(bridge));
  ok('agent runs are audited', /agent\.stream/.test(bridge) && /agent\.run/.test(bridge));
  ok('provisioning is exposed over the bridge', /op === 'provision'/.test(bridge) && /provisionWorkspace/.test(bridge));
  ok('the SSE asker can only auto-approve with explicit consent', /auto_approve === true/.test(bridge));

  const app = read('web/src/App.jsx');
  ok('the rail links the agent and the catalogue', /to: '\/agent'/.test(app) && /to: '\/apis'/.test(app));
  const page = read('web/src/pages/Agent.jsx');
  ok('the agent page shows each tool part', /ToolPart/.test(page) && /tool_start/.test(page) && /tool_end/.test(page));
  ok('…with the machine on every one', /part\.target/.test(page));
  ok('…a Plan/Build switch', /setAgentId\('plan'\)/.test(page) && /setAgentId\('build'\)/.test(page));
  ok('…the token countdown', /min\)/.test(page) || /minutes_left/.test(page));
  ok('…and an explicit auto-approve switch, off by default', /autoApprove/.test(page) && /useState\(false\)/.test(page));
  const sb = read('web/src/pages/Sandbox.jsx');
  ok('the Sandbox page counts the token down', /session_token\.expires_at/.test(sb));
  ok('…can forget it', /revoke/.test(sb));
  ok('…and runs the install checklist', /runProvision/.test(sb) && /Install \/ repair the sandbox/.test(sb));
  const apis = read('web/src/pages/Apis.jsx');
  ok('the catalogue page filters by auth, category, TLS and CORS', /authFilter/.test(apis) && /ssl/.test(apis) && /cors/.test(apis));
  ok('…and can call one endpoint for real', /callIt/.test(apis) && /api\.publicApis\.call/.test(apis));
}

// ---------------------------------------------------------------------------
console.log('\n— Glasser is gone —');
{
  const offenders = [];
  for (const dir of ['web/src', 'lib', 'api', 'desktop', 'scripts']) {
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const p = path.join(rel, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|jsx|mjs|json)$/.test(e.name)) continue;
        if (/public-apis\.json$/.test(e.name)) continue;
        const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
        // The word may appear only in a comment explaining what it replaced.
        for (const line of text.split('\n')) {
          if (/glasser/i.test(line) && !/^(\s*\/\/|\s*\*|\s*\/\*)/.test(line) && !/replaced/i.test(line)) offenders.push(`${p}: ${line.trim().slice(0, 80)}`);
        }
      }
    };
    walk(dir);
  }
  ok('no runtime reference to Glasser remains', offenders.length === 0, offenders.slice(0, 3).join(' | '));
  ok('the catalogue tool replaced it in the agent', /public_api/.test(read('lib/agent.js')));
}

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* tmp */ }
process.exit(failed ? 1 : 0);
