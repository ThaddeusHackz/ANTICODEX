#!/usr/bin/env node
// Package ANTICODEX for macOS.
//
// What this script can and cannot do, stated up front because "macOS build" is
// where Electron projects usually lie:
//
//   * electron-packager can produce a `darwin-x64` / `darwin-arm64` .app bundle
//     from any platform. That bundle is **unsigned**.
//   * A distributable app (double-clickable without Gatekeeper warnings, and
//     updatable) needs `codesign` + `notarytool`, both of which only exist on
//     macOS with a Developer ID certificate. This script refuses to pretend: run
//     it on macOS with CODESIGN_IDENTITY set for a signed build, otherwise you get
//     the unsigned bundle and a line telling you exactly what is missing.
//   * A DMG is produced when `hdiutil` exists (macOS). Elsewhere you get a `.zip`.
//
// Usage:
//   node desktop/package-mac.mjs                 # current arch, unsigned
//   node desktop/package-mac.mjs --arch arm64
//   node desktop/package-mac.mjs --release       # also zip + (macOS) dmg
//   CODESIGN_IDENTITY="Developer ID Application: …" node desktop/package-mac.mjs --sign
//
// The renderer is rebuilt first: a stale web/dist is how a UI fix never reaches
// the shipped app (the same bug package-win.mjs guards against).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ARCH = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
const RELEASE = has('--release');
const SKIP_BUILD = has('--skip-build');
const SIGN = has('--sign') || Boolean(process.env.CODESIGN_IDENTITY);
const OUT = path.join(HERE, 'release');
const NAME = `ANTICODEX-darwin-${ARCH}`;

const log = (...a) => console.log(...a);
const run = (cmd, args, opts = {}) => {
  log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: HERE, ...opts });
};
const capture = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
};

log(`ANTICODEX — macOS packaging (arch ${ARCH})`);

// --- 1. the renderer ---------------------------------------------------------
if (!SKIP_BUILD) {
  log('\n· building the web bundle (a stale dist ships a stale UI)');
  run('npm', ['run', 'build'], { cwd: ROOT });
} else {
  log('\n· skipping the web build (--skip-build) — web/dist must already be current');
}
if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.error('✗ web/dist/index.html is missing — run without --skip-build');
  process.exit(1);
}

// --- 2. desktop deps ---------------------------------------------------------
if (!fs.existsSync(path.join(HERE, 'node_modules', 'electron-packager'))) {
  log('\n· installing desktop dependencies');
  run('npm', ['install', '--no-audit', '--no-fund']);
}

// --- 3. pack -----------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
log(`\n· packing ${NAME}`);
run('npx', [
  'electron-packager', '.', 'ANTICODEX',
  '--platform=darwin',
  `--arch=${ARCH}`,
  '--electron-version=' + (JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).devDependencies.electron || '31.3.1').replace(/^[^0-9]*/, ''),
  '--out=release',
  '--overwrite',
  '--app-bundle-id=app.anticodex.desktop',
  '--app-version=' + JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version,
  '--icon=icons/icon.png',
  '--prune=true',
  '--ignore="^/release($|/)"',
  // web/dist is the renderer and ships whole (including skills-atlas, which the
  // Skills page browses offline); data/ is build input, never shipped.
  '--ignore="^/data($|/)"',
  '--ignore="^/vendor($|/)"',
  '--ignore="^/\\.git($|/)"',
  `--app-category-type=public.app-category.developer-tools`
]);

const appPath = path.join(OUT, NAME, 'ANTICODEX.app');
if (!fs.existsSync(appPath)) {
  console.error(`✗ expected ${appPath} — packager produced something else`);
  process.exit(1);
}
log(`  ✓ ${path.relative(ROOT, appPath)}`);

// --- 4. sign (macOS only, honest about it) -----------------------------------
const onMac = process.platform === 'darwin';
const identity = process.env.CODESIGN_IDENTITY || capture('security', ['find-identity', '-v', '-p', 'codesigning'])?.match(/"([^"]+)"/)?.[1];

if (SIGN) {
  if (!onMac) {
    log('\n! --sign asked for, but codesign only exists on macOS.');
    log('  The bundle is UNSIGNED. Build on macOS (or CI with a macOS runner) for a signed app.');
  } else if (!identity) {
    log('\n! --sign asked for, but no Developer ID Application certificate is installed.');
    log('  security find-identity -v -p codesigning   → nothing usable');
    log('  The bundle is UNSIGNED. Gatekeeper will warn on first open (right-click → Open).');
  } else {
    log(`\n· signing with ${identity}`);
    run('codesign', ['--deep', '--force', '--options', 'runtime', '--timestamp', '--sign', identity, appPath]);
    const zipForNotary = path.join(OUT, `${NAME}.zip`);
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipForNotary]);
    log('· notarising (needs APPLE_ID + APPLE_TEAM_ID + an app-specific password in APPLE_APP_PASSWORD)');
    if (process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD) {
      run('xcrun', ['notarytool', 'submit', zipForNotary, '--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_PASSWORD, '--wait']);
      run('xcrun', ['stapler', 'staple', appPath]);
      log('  ✓ notarised and stapled');
    } else {
      log('  ! APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD not set — signed but NOT notarised');
    }
  }
} else {
  log('\n· unsigned build (pass --sign with a Developer ID to sign; notarisation needs macOS + Apple credentials)');
}

// --- 5. release artifacts ----------------------------------------------------
if (RELEASE) {
  log('\n· writing release artifacts');
  const zipPath = path.join(OUT, `${NAME}.zip`);
  if (onMac) {
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  } else {
    log('  ! ditto is macOS-only; leaving the .app directory as the artifact');
  }
  if (onMac && capture('which', ['hdiutil'])) {
    const dmg = path.join(OUT, `${NAME}.dmg`);
    run('hdiutil', ['create', '-volname', 'ANTICODEX', '-srcfolder', path.join(OUT, NAME), '-ov', '-format', 'UDZO', dmg]);
    log(`  ✓ ${path.relative(ROOT, dmg)}`);
  } else {
    log('  ! hdiutil is macOS-only; no .dmg from this host');
  }
}

log('\nDone.');
log(`  app      ${path.relative(ROOT, appPath)}`);
log(`  host     ${process.platform} ${os.arch()}${onMac ? '' : '  (unsigned .app built cross-platform)'}`);
log('  install  drag ANTICODEX.app to /Applications. First launch: right-click → Open (unsigned).');
