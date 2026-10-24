// Sandbox tests — the part that makes "here is the code" believable.
//
// A code agent that only *describes* output is a storyteller. This suite pins the
// things that make the output real: the process actually runs, the environment is
// stripped of this machine's secrets, the time limit kills a runaway program, and
// nothing outside the run directory can be named.
//
// Run: node tests/test-sandbox.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ANTICODEX_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-sandbox-data-'));

const sb = await import('../lib/sandbox.js');

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);
const have = (bin) => sb.sandboxStatus().languages.find((l) => l.id === bin)?.available;

// This machine is where the code runs; give it a secret to fail to leak.
process.env.ACX_TEST_SECRET = 'do-not-leak-me';

// ---------------------------------------------------------------------------
section('what the sandbox says about itself');
{
  const status = sb.sandboxStatus();
  ok('it reports the three languages', status.languages.length === 3);
  ok('…and whether each one is installed', status.languages.every((l) => typeof l.available === 'string' || l.available === null));
  ok('…and the limits it will enforce', status.limits.max_timeout_ms === 15000 && status.limits.max_output_bytes === 64000);
  ok('the run root is inside the data directory', status.root.startsWith(path.resolve(process.env.ANTICODEX_DATA)));
}

section('a program runs and its output is its own');
if (have('node')) {
  const out = await sb.runSandbox({ language: 'node', code: 'console.log("hello", 6 * 7); console.error("to stderr")' });
  ok('exit 0 and stdout is the process\'s', out.ok === true && out.stdout.trim() === 'hello 42', JSON.stringify(out.stdout));
  ok('stderr is kept separate', /to stderr/.test(out.stderr));
  ok('it reports how long it took', out.duration_ms >= 0);
  ok('the run has an id and a directory', /^[a-f0-9]{16}$/.test(out.run_id));
  ok('the file it ran is listed', out.files.some((f) => f.name === 'main.mjs'));

  const failing = await sb.runSandbox({ language: 'node', code: 'process.exit(4)' });
  ok('a non-zero exit is not "ok"', failing.ok === false && failing.exit_code === 4);

  const threw = await sb.runSandbox({ language: 'node', code: 'throw new Error("boom")' });
  ok('a crash is reported with its stack', threw.ok === false && /boom/.test(threw.stderr), threw.stderr.slice(0, 80));
}

section('the environment is stripped, not inherited');
if (have('node')) {
  const out = await sb.runSandbox({ language: 'node', code: 'console.log(JSON.stringify(Object.keys(process.env).sort()))' });
  const envKeys = JSON.parse(out.stdout);
  ok('no secret from this machine is visible', !envKeys.some((k) => /ACX_TEST_SECRET|API_KEY|TOKEN|SECRET|PASSWORD/i.test(k)), envKeys.join(','));
  ok('HOME points at the run directory', envKeys.includes('HOME'));
  const home = await sb.runSandbox({ language: 'node', code: 'console.log(process.env.HOME)' });
  ok('…which is this run\'s own directory, not the real one',
    home.stdout.trim() !== os.homedir() && home.stdout.trim().endsWith(home.run_id), home.stdout.trim());
}

section('a runaway program is killed, not waited on');
if (have('node')) {
  const started = Date.now();
  const out = await sb.runSandbox({ language: 'node', code: 'setInterval(() => {}, 1000)', timeout_ms: 1200 });
  const took = Date.now() - started;
  ok('the timeout is enforced', out.timed_out === true && out.ok === false, JSON.stringify({ timed_out: out.timed_out }));
  ok('…the child was killed outright', out.signal === 'SIGKILL' || out.exit_code !== 0, String(out.signal));
  ok('…and it did not run much past the limit', took < 6000, `${took}ms`);
  const capped = await sb.runSandbox({ language: 'node', code: 'console.log(1)', timeout_ms: 10 * 60 * 1000 });
  ok('the timeout cannot be raised past the cap', capped.ok === true);
}

section('other languages, when they are installed');
if (have('python')) {
  const out = await sb.runSandbox({ language: 'python', code: 'import os\nprint("py", 2 + 2)\nprint(bool(os.environ.get("ACX_TEST_SECRET")))' });
  ok('python runs', out.ok === true && /py 4/.test(out.stdout), out.stdout);
  ok('…in isolated mode, with no inherited secret', /False/.test(out.stdout), out.stdout);
}
if (have('bash')) {
  const out = await sb.runSandbox({ language: 'bash', code: 'echo $((6*7)) > answer.txt; cat answer.txt' });
  ok('shell runs and can write a file', out.ok === true && out.stdout.trim() === '42');
  ok('the file it wrote is listed', out.files.some((f) => f.name === 'answer.txt'));
  const read = sb.readSandboxFile(out.run_id, 'answer.txt');
  ok('and can be read back', read.ok === true && read.content.trim() === '42');
}

section('nothing outside the run can be named');
{
  ok('a run id is validated', sb.isRunId('../../etc') === false && sb.isRunId('a'.repeat(64)) === false);
  ok('an unknown run is refused', sb.readSandboxFile('deadbeefdeadbeef', 'x') .ok === false);
  if (have('bash')) {
    const out = await sb.runSandbox({ language: 'bash', code: 'echo hi' });
    ok('a traversal in a file name is refused', sb.readSandboxFile(out.run_id, '../../package.json').ok === false);
    const escaped = await sb.runSandbox({ language: 'bash', code: 'ls -a', files: [{ name: '../escape.txt', content: 'nope' }] });
    const root = path.join(process.env.ANTICODEX_DATA, 'sandbox');
    ok('an extra file cannot be written outside the run',
      !fs.existsSync(path.join(root, 'escape.txt')) && !escaped.files.some((f) => f.name.includes('..')),
      JSON.stringify(escaped.files.map((f) => f.name)));
  }
}

section('its input limits hold');
{
  ok('an unknown language is a sentence, not a crash', (await sb.runSandbox({ language: 'ruby', code: 'puts 1' })).error.includes('Unknown language'));
  ok('empty code is refused', (await sb.runSandbox({ language: 'node', code: '   ' })).error.includes('no code'));
  const huge = 'x'.repeat(200_001);
  ok('an oversized snippet is refused', (await sb.runSandbox({ language: 'node', code: huge })).error.includes('limit'));
}

section('runs are kept, and can be thrown away');
{
  const a = await sb.runSandbox({ language: 'node', code: 'console.log("keep me")' });
  ok('the run appears in the list', sb.listRuns().some((r) => r.id === a.run_id));
  const cleared = sb.clearSandbox(a.run_id);
  ok('clearing one removes it', cleared.ok === true && !sb.listRuns().some((r) => r.id === a.run_id));
  sb.clearSandbox();
  ok('clearing all leaves nothing', sb.listRuns().length === 0);
}

section('the bridge only runs code for the machine that owns it');
{
  const bridge = fs.readFileSync(new URL('../api/bridge.js', import.meta.url), 'utf8');
  ok('there is a sandbox action', /case 'sandbox':/.test(bridge));
  ok('it is gated on loopback, not on being signed in', /function sandboxAllowed\(req\)[\s\S]{0,240}isLoopback\(req\)/.test(bridge));
  ok('a remote caller is told why, and where it does work', /Running generated code happens on the machine that owns it/.test(bridge) && /install ANTICODEX Desktop/i.test(bridge));
  ok('every run is audited', /type: 'sandbox\.run'/.test(bridge));
  ok('the page exists and is routed', /SandboxPage/.test(fs.readFileSync(new URL('../web/src/App.jsx', import.meta.url), 'utf8')));
}

fs.rmSync(process.env.ANTICODEX_DATA, { recursive: true, force: true });
delete process.env.ACX_TEST_SECRET;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
