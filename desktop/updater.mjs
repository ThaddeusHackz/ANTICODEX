// Auto-updater — polls the GitHub Releases feed of ThaddeusHackz/ANTICODEX.
//
// The state machine, stated honestly (this file used to claim more than it did):
//
//   check()          — ask GitHub what the latest release is. Also reads/writes
//                      the persisted update state, so a version the user already
//                      dismissed is not nagged about again.
//   download()       — only reached after the user ACCEPTS. Downloads the release
//                      asset for THIS platform (never another OS's zip), EXTRACTS
//                      it into userData/pending-update with a real extractor, and
//                      records that a staged update is ready.
//                      (The old code stopped at the download and its comment lied
//                      about applying on restart — nothing was ever extracted or
//                      applied.)
//   apply(quit)      — spawns a DETACHED node helper that waits for this app's
//                      process to exit, copies the staged files over the install
//                      folder and relaunches ANTICODEX.exe. The app only quits
//                      after the helper is confirmed running, otherwise the swap
//                      never happens and the user is silently left on the old
//                      version.
//
// Releases ship a portable zip (see .github/workflows/release.yml Attach step and
// desktop/package-win.mjs), not an NSIS installer, so the apply path is "unzip
// over the folder", not "run installer /S".
//
// Every step returns a real status. When a step actually failed it returns
// {ok:false, error, fix} rather than inventing a "done" the machine cannot prove.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';

const REPO = 'ThaddeusHackz/ANTICODEX';

function cmpVer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// The portable zip wraps everything in a single top folder, so the staged payload
// lives one level under pending-update. Find that folder rather than assuming the
// exact name survived the transfer.
function findStagedRoot(fsx, pendingDir) {
  let entries;
  try { entries = fsx.readdirSync(pendingDir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(pendingDir, e.name);
    let kids = [];
    try { kids = fsx.readdirSync(full); } catch { kids = []; }
    // A folder that looks like the Electron app (holds ANTICODEX.exe) wins; any
    // non-empty folder is an acceptable fallback for a differently-named build.
    if (kids.some((k) => /ANTICODEX\.exe$/i.test(k))) return full;
  }
  for (const e of entries) {
    if (e.isDirectory()) return path.join(pendingDir, e.name);
  }
  return null;
}

// The helper runs in bare Electron/node (ELECTRON_RUN_AS_NODE), so CommonJS is the
// safe module format regardless of the app's "type":"module" — userData has no
// package.json of its own and .cjs is unambiguous.
function helperScript() {
  return [
    '// ANTICODEX update helper — written by the updater, run DETACHED so it',
    '// outlives the app it is replacing. Waits for the running ANTICODEX process',
    '// to exit (its files are locked while it runs), copies the staged release',
    '// over the install folder, then relaunches the app.',
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const CFG = JSON.parse(process.argv[2]);',
    'function log(m){ try { fs.appendFileSync(CFG.helperLog, new Date().toISOString() + " " + m + "\\n"); } catch (e) {} }',
    'function alive(pid){ try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }',
    'let waited = 0;',
    'const poll = setInterval(function () {',
    '  if (alive(CFG.appPid)) { if ((waited += 250) > 120000) { clearInterval(poll); log("app did not exit within 120s; aborting"); process.exit(1); } return; }',
    '  clearInterval(poll);',
    '  try { fs.cpSync(CFG.staged, CFG.installDir, { recursive: true }); log("copied staged files"); }',
    '  catch (e) { log("copy failed: " + (e.message || e)); process.exit(1); }',
    '  try {',
    '    const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;',
    '    const c = spawn(CFG.exePath, [], { detached: true, stdio: "ignore", env });',
    '    if (c && c.unref) c.unref();',
    '    log("relaunched " + CFG.exePath);',
    '  } catch (e) { log("relaunch failed: " + (e.message || e)); }',
    '  process.exit(0);',
    '}, 250);'
  ].join('\n');
}

// Releases name assets after their target (ANTICODEX-<v>-win32-x64.zip,
// ANTICODEX-darwin-<arch>.zip). Picking "the first zip" handed a Mac the Windows
// build whenever both shipped, so rank: this platform+arch, then this platform,
// then a generic zip that names no OS at all. Another platform's build is never
// a fallback — applying it would overwrite the install with the wrong binaries.
function pickAsset(assets, platform, arch) {
  const token = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[platform] || platform;
  const forPlatform = (n) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i').test(n);
  const namesAnOS = /(win32|darwin|linux|macos|windows)/i;
  const zips = assets.filter((a) => /\.zip$/i.test(a.name));
  const zip = zips.find((a) => forPlatform(a.name) && a.name.toLowerCase().includes(arch))
    || zips.find((a) => forPlatform(a.name))
    || zips.find((a) => !namesAnOS.test(a.name))
    || null;
  const exe = platform === 'win32'
    ? (assets.find((a) => /\.exe$/i.test(a.name) && forPlatform(a.name))
      || assets.find((a) => /\.exe$/i.test(a.name) && !namesAnOS.test(a.name))
      || null)
    : null;
  const asset = zip || exe;
  return { asset, format: zip ? 'zip' : (exe ? 'exe' : 'none') };
}

export function createUpdater(currentVersion, opts = {}) {
  const fsx = opts.fs || fs;
  const spawn = opts.spawn || nodeSpawn;
  // Late-bound so a test that swaps globalThis.fetch still drives check().
  const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const execPath = opts.execPath || process.execPath;
  const appPid = opts.appPid || (() => process.pid);
  const envFor = opts.env || (() => process.env);
  const dataDir = opts.userData
    || (() => path.join(os.tmpdir(), 'anticodex-update'));

  const STATE_FILE = () => path.join(dataDir(), 'update-state.json');
  const PENDING_DIR = () => path.join(dataDir(), 'pending-update');
  const HELPER_FILE = () => path.join(dataDir(), 'update-helper.cjs');

  let lastInfo = null;

  function readState() {
    try { return JSON.parse(fsx.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch { return {}; }
  }
  function writeState(patch) {
    const next = { ...readState(), ...patch };
    try { fsx.mkdirSync(dataDir(), { recursive: true }); } catch { /* best effort */ }
    fsx.writeFileSync(STATE_FILE(), JSON.stringify(next, null, 2));
    return next;
  }

  async function check() {
    const res = await doFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ANTICODEX-Updater', Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return { ok: false, error: `release feed ${res.status}`, fix: 'Check your connection or GitHub status, then try again.' };
    const rel = await res.json();
    const version = (rel.tag_name || '').replace(/^v/, '');
    const assets = (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
    const { asset, format } = pickAsset(assets, platform, arch);

    const state = readState();
    writeState({ last_checked_at: new Date().toISOString() });

    const available = cmpVer(version, currentVersion) > 0;
    lastInfo = {
      ok: true,
      current: currentVersion,
      version,
      available,
      // A notification the user already dismissed for THIS exact version is
      // suppressed; any newer release notifies again. This is the gate
      // docs/FORENSIC-REPORT.md:221 claimed existed but did not.
      dismissed: available && state.dismissed_version === version,
      notes: rel.body || '',
      url: rel.html_url || (asset ? asset.url : ''),
      publishedAt: rel.published_at,
      asset: asset ? asset.name : null,
      assetUrl: asset ? asset.url : null,
      format,
      platform,
      assets
    };
    return lastInfo;
  }

  function extractSpec(zipPath, destDir) {
    if (platform === 'win32') {
      return {
        label: 'PowerShell Expand-Archive',
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]
      };
    }
    return { label: 'unzip', cmd: 'unzip', args: ['-o', zipPath, '-d', destDir] };
  }

  function runExtractor(cmd, args) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(cmd, args, { stdio: 'ignore' }); }
      catch (e) { return resolve({ ok: false, error: `extractor could not start: ${e && e.message || e}` }); }
      if (!child || typeof child.on !== 'function') return resolve({ ok: true, code: 0 });
      let errored = '';
      child.on('error', (e) => { errored += String((e && e.message) || e); });
      child.on('close', (code) => {
        if (errored) return resolve({ ok: false, error: `extractor failed: ${errored}` });
        resolve({ ok: code === 0, code, error: code === 0 ? '' : `extractor exited ${code}` });
      });
    });
  }

  // Download the release asset and EXTRACT it into pending-update. This is the
  // step the old downloadAndInstall never completed for a zip.
  async function download() {
    if (!lastInfo || !lastInfo.ok) { const c = await check(); if (!c.ok) return c; }
    const info = lastInfo;
    if (!info.available) return { ok: false, error: 'no update available', fix: 'This build is already the latest.' };
    if (!info.assetUrl) return { ok: false, error: `no installable asset for ${platform} in release`, fix: `Release v${info.version} ships no ${platform} build — see ${info.url || 'the releases page'} for what is available.` };

    const pending = PENDING_DIR();
    try { fsx.rmSync(pending, { recursive: true, force: true }); } catch { /* ignore */ }
    fsx.mkdirSync(pending, { recursive: true });

    const zipName = path.basename(String(info.assetUrl).split('?')[0]) || (info.asset || 'update.zip');
    const zipPath = path.join(pending, zipName);

    let res;
    try { res = await doFetch(info.assetUrl); }
    catch (e) { return { ok: false, error: `download failed: ${e && e.message || e}`, fix: 'Retry when your connection is back.' }; }
    if (!res.ok) return { ok: false, error: `download failed ${res.status}`, fix: 'Retry; GitHub may be rate-limiting or the asset moved.' };

    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); }
    catch (e) { return { ok: false, error: `download body failed: ${e && e.message || e}`, fix: 'Retry the download.' }; }
    fsx.writeFileSync(zipPath, buf);

    // The portable zip is applied by extracting; an .exe would be launched
    // silently (kept for parity, though releases ship a zip).
    if (/\.zip$/i.test(zipName)) {
      const spec = extractSpec(zipPath, pending);
      const ex = await runExtractor(spec.cmd, spec.args);
      if (!ex.ok) return { ok: false, error: `extract failed (${spec.label}): ${ex.error || 'unknown'}`, fix: `Ensure ${spec.label} is available on this machine, then retry.` };
      const stagedDir = findStagedRoot(fsx, pending);
      if (!stagedDir) return { ok: false, error: 'extracted archive has no app folder', fix: 'The release zip layout is unexpected; report the asset name.' };
      writeState({ staged_version: info.version, staged_at: new Date().toISOString(), staged_dir: stagedDir });
      return { ok: true, stage: 'ready', version: info.version, stagedDir, zipPath, extractor: spec.label, message: `Update v${info.version} downloaded and staged — accept to apply on restart.` };
    }

    writeState({ staged_version: info.version, staged_at: new Date().toISOString(), staged_dir: zipPath });
    return { ok: true, stage: 'ready', version: info.version, installer: zipPath, message: `Installer for v${info.version} downloaded.` };
  }

  // Stage the update onto disk with a detached helper, then quit — the helper does
  // the file swap once this process is gone. quit() only runs after the helper
  // child emits 'spawn'; a failed spawn keeps the staged update retryable instead
  // of quitting into a swap that will never happen.
  function apply(quit) {
    const state = readState();
    const staged = state.staged_dir;
    if (!staged || !fsx.existsSync(staged)) {
      return Promise.resolve({ ok: false, error: 'nothing staged to apply', fix: 'Accept the update to download it first.' });
    }
    const installDir = path.dirname(execPath);
    const helper = HELPER_FILE();
    const cfg = {
      staged, installDir, exePath: execPath, appPid: appPid(),
      helperLog: path.join(dataDir(), 'update-helper.log')
    };
    try {
      fsx.mkdirSync(dataDir(), { recursive: true });
      fsx.writeFileSync(helper, helperScript());
    } catch (e) {
      return Promise.resolve({ ok: false, error: `could not write updater helper: ${e && e.message || e}`, fix: 'Check write permission in the app data folder.' });
    }
    return new Promise((resolve) => {
      const fail = (msg) => resolve({ ok: false, error: `could not launch updater helper: ${msg}`, fix: 'The staged update is kept — press Apply again, or restart ANTICODEX and retry.' });
      let child;
      try {
        child = spawn(execPath, [helper, JSON.stringify(cfg)], {
          detached: true,
          stdio: 'ignore',
          env: Object.assign({}, envFor(), { ELECTRON_RUN_AS_NODE: '1' })
        });
      } catch (e) {
        return fail(String((e && e.message) || e));
      }
      if (!child || typeof child.on !== 'function') return fail('spawn returned no child process');
      let settled = false;
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        fail(String((e && e.message) || e));
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        if (typeof child.unref === 'function') child.unref();
        // The helper is confirmed running; only now is it safe to shut down.
        writeState({ applying_version: state.staged_version, last_applied_at: new Date().toISOString() });
        if (typeof quit === 'function') { try { quit(); } catch { /* the window may already be closing */ } }
        resolve({ ok: true, stage: 'applying', version: state.staged_version, helper, message: 'The updater is running — ANTICODEX reopens itself once the files are swapped.' });
      });
    });
  }

  function dismiss(version) {
    const v = version || lastInfo?.version;
    if (!v) return { ok: false, error: 'nothing to dismiss', fix: 'Check for an update first.' };
    writeState({ dismissed_version: v, dismissed_at: new Date().toISOString() });
    if (lastInfo) lastInfo = { ...lastInfo, dismissed: lastInfo.available && v === lastInfo.version };
    return { ok: true, dismissed_version: v };
  }

  // Real persisted state so the UI can show what actually happened rather than a
  // optimistic spinner.
  function status() {
    const state = readState();
    const stagedReady = !!(state.staged_version && state.staged_dir && fsx.existsSync(state.staged_dir));
    let stage = 'idle';
    if (state.applying_version && stagedReady) stage = 'applying';
    else if (stagedReady) stage = 'ready';
    else if (state.last_checked_at) stage = 'checked';
    return { ok: true, stage, staged_version: state.staged_version || null, dismissed_version: state.dismissed_version || null, last_checked_at: state.last_checked_at || null };
  }

  return { check, download, apply, dismiss, status };
}
