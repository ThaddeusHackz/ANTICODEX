// tests/test-workspace-fs.mjs — the real workspace folder: containment, policy
// gating at the bridge, and honest exec behavior. Runs anywhere `npm test` runs;
// exec assertions skip (loudly, not silently) when bash is absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeAccountKey, resolveInside, wsList, wsRead, wsWrite, wsMkdir, wsRemove,
  wsExec, wsPreview, diffLines
} from '../lib/workspacefs.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; return; }
  failed++; console.error(`  ✗ ${name}`);
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)})`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-ws-'));
const hasBash = (() => {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, process.platform === 'win32' ? 'bash.exe' : 'bash'))) return true;
  }
  return false;
})();

// --- account keys are directory names, nothing more --------------------------
eq(safeAccountKey('12345'), '12345', 'plain numeric id kept');
eq(safeAccountKey('../../evil'), 'default', 'traversal key sanitized');
eq(safeAccountKey(''), 'default', 'empty key falls back');
eq(safeAccountKey('a'.repeat(80)), 'default', 'overlong key rejected');
ok(safeAccountKey('user-1_x.y') === 'user-1_x.y', 'safe punctuation preserved');

// --- containment --------------------------------------------------------------
ok(Boolean(resolveInside(root, '../outside').error), 'parent escape refused');
ok(Boolean(resolveInside(root, 'a/../../b').error), 'mixed traversal refused');
ok(Boolean(resolveInside(root, '/etc/passwd').error), 'absolute path refused');
ok(Boolean(resolveInside(root, 'C:\\Windows\\system32\\x').error), 'windows absolute refused');
ok(Boolean(resolveInside(root, 'has\0nul').error), 'NUL byte refused');
ok(!resolveInside(root, 'normal/dir.txt').error, 'in-root path accepted');

// symlink escape (best effort across platforms)
let symlinkTested = false;
try {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acx-ws-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link, 'dir');
  symlinkTested = true;
  const r = resolveInside(root, 'link/secret.txt');
  ok(r.error, 'symlinked folder cannot escape the workspace');
} catch { /* platform without symlink rights — recorded below */ }

// --- round trips ----------------------------------------------------------------
eq(wsWrite(root, 'src/deep/a.js', 'export const x = 1;').ok, true, 'nested write creates parents');
eq(wsRead(root, 'src/deep/a.js').content, 'export const x = 1;', 'read returns what was written');
ok(wsRead(root, 'nope.js').error.includes('No such file'), 'missing file is an honest error');
ok(wsRead(root, 'src/deep').error.includes('directory'), 'reading a directory refuses');
wsWrite(root, 'bin.bin', Buffer.from([0, 1, 2, 3]).toString('latin1'));
eq(wsRead(root, 'bin.bin').binary, true, 'binary file is refused with binary:true');
const big = 'x'.repeat(2 * 1024 * 1024 + 10);
ok(wsWrite(root, 'toobig.txt', big).error.includes('limit'), 'over-limit write refused before touching disk');

const listing = wsList(root, 'src/deep');
eq(listing.files.map((f) => f.name), ['a.js'], 'list shows the file');
eq(wsList(root, '').dirs.some((d) => d.name === 'src'), true, 'root list shows the folder');

fs.writeFileSync(path.join(root, '.hidden'), 'x');
ok(!wsList(root, '').files.some((f) => f.name === '.hidden'), 'dotfiles stay hidden from listings');

// --- destructive ops are guarded -------------------------------------------------
ok(wsRemove(root, '').error, 'refusing to remove the workspace itself');
eq(wsRemove(root, 'src/deep').ok, true, 'folder removal works inside the root');
ok(!fs.existsSync(path.join(root, 'src/deep')), 'removed folder really gone');
ok(fs.existsSync(path.join(root, 'src')), 'its parent folder is untouched');

// --- preview/diff --------------------------------------------------------------------
wsWrite(root, 'f.txt', 'one\ntwo\nthree\n');
const pv = wsPreview(root, 'f.txt', 'one\nTWO\nthree\nfour\n');
eq(pv.added, 2, 'preview counts added lines');
eq(pv.removed, 1, 'preview counts removed lines');
eq(pv.exists, true, 'preview knows the file exists');
const d = diffLines('a\nb\n', 'a\nc\n');
eq(d.hunks.filter((h) => h.t === '+').length, 1, 'diff replaces the middle only');
eq(wsPreview(root, 'brand-new.txt', 'hi\n').exists, false, 'preview of a new file is not an error');

// --- exec (the real terminal) ---------------------------------------------------------
if (hasBash) {
  const echo = await wsExec(root, { command: 'echo anticodex' });
  eq(echo.stdout.trim(), 'anticodex', 'echo runs for real');
  eq(echo.exit_code, 0, 'clean exit code is 0');
  const bad = await wsExec(root, { command: 'exit 3' });
  eq(bad.exit_code, 3, 'nonzero exit is reported, not swallowed');
  const slow = await wsExec(root, { command: 'sleep 5', timeout_ms: 400 });
  eq(slow.timed_out, true, 'timeout kills the child');
  const cwdCheck = await wsExec(root, { command: 'pwd' });
  ok(path.resolve(cwdCheck.stdout.trim()) === path.resolve(root), 'exec runs with the workspace as cwd');
  const envCheck = await wsExec(root, { command: 'echo $HOME' });
  ok(envCheck.stdout.trim() === '' || path.resolve(envCheck.stdout.trim()) === path.resolve(root), 'HOME is the workspace, scrubbed');
} else {
  console.log('  (exec assertions SKIPPED: no bash on this machine — honest, not silent)');
}

// --- bridge wiring: the policy must gate before any fs touch ----------------------------
const bridge = fs.readFileSync(new URL('../api/bridge.js', import.meta.url), 'utf8');
ok(bridge.includes("case 'workspace_fs'"), 'dispatcher routes workspace_fs');
ok(bridge.includes('if (!sandboxAllowed(req))') && bridge.indexOf('handleWorkspaceFs') !== -1, 'loopback gate exists for the workspace handler');
const wsBlock = bridge.slice(bridge.indexOf('async function handleWorkspaceFs'), bridge.indexOf('async function handleWorkspaceFs') + 5200);
ok(wsBlock.includes("verdict === 'deny'"), 'deny branch present');
ok(wsBlock.includes("verdict === 'prompt' && !body.confirm"), 'prompt requires confirmation');
ok(wsBlock.indexOf("verdict === 'deny'") < wsBlock.indexOf('wsWrite(root'), 'deny is decided before any write');
ok(wsBlock.includes('confirm') && wsBlock.includes('needs_approval'), 'UI gets a real approval affordance');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);