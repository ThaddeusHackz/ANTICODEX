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
// The release workflow runs `npm run package:mac` and expects
// `release/ANTICODEX-<version>-darwin-<arch>.zip` for arm64 and x64. That is the
// default here; `--arch=arm64` narrows it while developing.
//
// Usage:
//   node desktop/package-mac.mjs                    # arm64 + x64, unsigned, zipped
//   node desktop/package-mac.mjs --arch=arm64       # one architecture
//   node desktop/package-mac.mjs --release          # also DMG on macOS
//   CODESIGN_IDENTITY="Developer ID Application: …" node desktop/package-mac.mjs --sign
//   node desktop/package-mac.mjs --stage-only       # build web + stage, no package
//   node desktop/package-mac.mjs --dry-run          # print the plan, no side effects
//
// The renderer is rebuilt first: a stale web/dist is how a UI fix never reaches
// the shipped app (the same bug package-win.mjs guards against).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const archArg = arg('--arch', '');
const ARCHS = (archArg ? archArg.split(',') : ['arm64', 'x64']).map((s) => s.trim()).filter(Boolean);
const VALID_ARCHS = ['arm64', 'x64', 'universal'];
for (const arch of ARCHS) {
  if (!VALID_ARCHS.includes(arch)) {
    console.error(`✗ unknown arch "${arch}" — use ${VALID_ARCHS.join(', ')}`);
    process.exit(1);
  }
}
const RELEASE = has('--release');
const SKIP_BUILD = has('--skip-build');
const DRY_RUN = has('--dry-run');
const STAGE_ONLY = has('--stage-only');
const SIGN = has('--sign') || Boolean(process.env.CODESIGN_IDENTITY);
const OUT = path.join(HERE, 'release');
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const VERSION = String(PKG.version || '0.0.0');
const ELECTRON = String(PKG.devDependencies?.electron || '31.3.1').replace(/^[^0-9]*/, '');
const ICON = fs.existsSync(path.join(HERE, 'icons', 'icon.icns'))
  ? 'icons/icon.icns'
  : (fs.existsSync(path.join(HERE, 'icons', 'icon.png')) ? 'icons/icon.png' : null);

const log = (...a) => console.log(...a);
const run = (cmd, args, opts = {}) => {
  const secrets = [];
  args.forEach((arg, i) => {
    const flag = /^(?:--password|--token|--secret|-p)(?:=(.*))?$/i.exec(arg);
    const value = flag && (flag[1] === undefined ? args[i + 1] : flag[1]);
    if (value) secrets.push(String(value));
  });
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
  log(redact(`$ ${cmd} ${args.join(' ')}`));
  try {
    const output = execFileSync(cmd, args, {
      stdio: 'inherit', cwd: HERE, ...opts,
      ...(secrets.length ? { stdio: ['ignore', 'pipe', 'pipe'] } : {})
    });
    if (secrets.length && output?.length) log(redact(output));
    return output;
  } catch (error) {
    if (!secrets.length) throw error;
    throw new Error(redact(error.message || error));
  }
};
const capture = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
};

log(`ANTICODEX ${VERSION} — macOS packaging (${ARCHS.join(', ')})`);
log(`  electron ${ELECTRON} · icon ${ICON || '(electron default)'}`);

if (DRY_RUN) {
  log('\n· plan (no side effects)');
  if (!SKIP_BUILD) log('  1. npm run build');
  log('  2. npm install (desktop) if electron-packager is absent');
  for (const arch of ARCHS) {
    log(`  3. electron-packager → release/ANTICODEX-darwin-${arch}/ANTICODEX.app`);
    log(`  4. zip → release/ANTICODEX-${VERSION}-darwin-${arch}.zip`);
  }
  if (SIGN) log('  5. codesign + notarytool (macOS + Apple credentials only)');
  if (RELEASE) log('  6. hdiutil DMG (macOS only)');
  process.exit(0);
}

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

if (STAGE_ONLY) {
  log('\n· stage-only: web bundle is current; nothing was packaged');
  log(`  renderer ${path.relative(ROOT, path.join(ROOT, 'web', 'dist'))}`);
  process.exit(0);
}

// --- 2. desktop deps ---------------------------------------------------------
if (!fs.existsSync(path.join(HERE, 'node_modules', 'electron-packager'))) {
  log('\n· installing desktop dependencies');
  run('npm', ['install', '--no-audit', '--no-fund']);
}

fs.mkdirSync(OUT, { recursive: true });

const onMac = process.platform === 'darwin';
const identity = process.env.CODESIGN_IDENTITY || capture('security', ['find-identity', '-v', '-p', 'codesigning'])?.match(/"([^"]+)"/)?.[1];

// A signed build must be signed *before* it is zipped, so packaging, signing and
// zipping happen per architecture rather than in one pass at the end.
for (const arch of ARCHS) {
  const NAME = `ANTICODEX-darwin-${arch}`;

  // --- 3. pack ---------------------------------------------------------------
  log(`\n· packing ${NAME}`);
  const args = [
    'electron-packager', '.', 'ANTICODEX',
    '--platform=darwin',
    `--arch=${arch}`,
    `--electron-version=${ELECTRON}`,
    '--out=release',
    '--overwrite',
    '--app-bundle-id=app.anticodex.desktop',
    `--app-version=${VERSION}`,
    '--prune=true',
    '--extra-resource=' + path.join(ROOT, 'web', 'dist'),
    '--extra-resource=' + path.join(ROOT, 'api'),
    '--extra-resource=' + path.join(ROOT, 'lib'),
    '--ignore=^/release($|/)',
    // web/dist is the renderer and ships whole (including skills-atlas, which the
    // Skills page browses offline); data/ is build input, never shipped.
    '--ignore=^/data($|/)',
    '--ignore=^/vendor($|/)',
    '--ignore=^/\\.git($|/)',
    '--app-category-type=public.app-category.developer-tools'
  ];
  if (ICON) args.push(`--icon=${ICON}`);
  run('npx', args);

  const appPath = path.join(OUT, NAME, 'ANTICODEX.app');
  if (!fs.existsSync(appPath)) {
    console.error(`✗ expected ${appPath} — packager produced something else`);
    process.exit(1);
  }
  log(`  ✓ ${path.relative(ROOT, appPath)}`);

  // --- 4. sign (macOS only, honest about it) --------------------------------
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
      const zipForNotary = path.join(OUT, `${NAME}-notary.zip`);
      run('ditto', ['-c', '-k', '--keepParent', appPath, zipForNotary]);
      log('· notarising (needs APPLE_ID + APPLE_TEAM_ID + an app-specific password in APPLE_APP_PASSWORD)');
      if (process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD) {
        run('xcrun', ['notarytool', 'submit', zipForNotary, '--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_PASSWORD, '--wait']);
        run('xcrun', ['stapler', 'staple', appPath]);
        log('  ✓ notarised and stapled');
      } else {
        log('  ! APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD not set — signed but NOT notarised');
      }
      try { fs.rmSync(zipForNotary, { force: true }); } catch { /* notary temp */ }
    }
  } else {
    log('\n· unsigned build (pass --sign with a Developer ID to sign; notarisation needs macOS + Apple credentials)');
  }

  // --- 5. release artifact (named exactly as the workflow checks) ------------
  const zipPath = path.join(OUT, `ANTICODEX-${VERSION}-darwin-${arch}.zip`);
  try { fs.rmSync(zipPath, { force: true }); } catch { /* stale zip */ }
  if (onMac) {
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    log(`  ✓ zip: ${path.relative(ROOT, zipPath)}`);
  } else {
    // electron-packager can build the .app on Linux, but the release asset is
    // produced on macOS (ditto preserves symlinks and resource forks correctly).
    try { fs.rmSync(zipPath, { force: true }); } catch { /* none */ }
    log('  ! ditto is macOS-only; leaving the .app directory as the artifact');
  }

  if (RELEASE && onMac && capture('which', ['hdiutil'])) {
    const dmg = path.join(OUT, `ANTICODEX-${VERSION}-darwin-${arch}.dmg`);
    run('hdiutil', ['create', '-volname', 'ANTICODEX', '-srcfolder', path.join(OUT, NAME), '-ov', '-format', 'UDZO', dmg]);
    log(`  ✓ ${path.relative(ROOT, dmg)}`);
  } else if (RELEASE) {
    log('  ! hdiutil is macOS-only; no .dmg from this host');
  }
}

log('\nDone.');
log(`  version  ${VERSION}`);
log(`  host     ${process.platform} ${os.arch()}${onMac ? '' : '  (unsigned .app built cross-platform)'}`);
log('  install  drag ANTICODEX.app to /Applications. First launch: right-click → Open (unsigned).');
