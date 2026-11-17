#!/usr/bin/env node
// Packages ANTICODEX for macOS as ANTICODEX.app folders (arm64 + x64 by
// default, or one universal app), then zips each — mirroring package-win.mjs's
// contract: rebuild web/dist by default (--skip-build to reuse deliberately),
// ship api/ + lib/ + web/dist as extra resources so the packaged app runs the
// SAME in-process bridge as the .exe, and take the version from
// desktop/package.json only.
//
// HONEST LIMITS (do not remove these notes):
//  * UNSIGNED and NOT NOTARIZED. No signing identity is configured anywhere in
//    this repo; the output is a plain unsigned .app. Gatekeeper will warn on
//    first launch — right-click → Open, or `xattr -dr com.apple.quarantine
//    ANTICODEX.app`. Nothing here fakes a signature.
//  * The actual electron-packager step must run ON macOS (this script exits
//    with this message on other platforms). The web build + resource staging
//    DO run anywhere, so CI on Linux can verify everything up to packaging:
//      node package-mac.mjs --dry-run     print the full plan, no side effects
//      node package-mac.mjs --stage-only  build web + stage resources, exit 0
//  * Auto-update: desktop/updater.mjs polls the same GitHub Releases feed on
//    every platform, but its download/apply path targets the Windows portable
//    zip (findStagedRoot looks for ANTICODEX.exe; release.yml attaches only the
//    win32 zip today). macOS self-update is NOT implemented — mac users
//    reinstall from a newer release. This script does not pretend otherwise.
//  * Deep links: --protocol=anticodex writes CFBundleURLTypes into Info.plist;
//    desktop/main.mjs already handles the rest on darwin (app.on('open-url')
//    and app.setAsDefaultProtocolClient('anticodex'), incl. cold-start argv).
//
// Usage: node package-mac.mjs [--skip-build] [--dry-run] [--stage-only]
//                             [--arch=arm64,x64|arm64|x64|universal]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcns } from './make-icns.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'release');
const stageDir = path.join(out, 'mac-resources');

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const dryRun = argv.includes('--dry-run');
const stageOnly = argv.includes('--stage-only');
const archArg = (argv.find((a) => a.startsWith('--arch=')) || '--arch=arm64,x64').slice(7);
// electron-packager 17.1.2 (desktop/package.json devDeps) supports darwin
// x64/arm64/universal — see its src/targets.js. Default to the two native
// builds; universal merges both into one fat app when asked.
const archs = archArg.split(',').map((s) => s.trim()).filter(Boolean);
const VALID_ARCHS = ['arm64', 'x64', 'universal'];
for (const a of archs) {
  if (!VALID_ARCHS.includes(a)) {
    console.error(`✗ unknown arch "${a}" — use ${VALID_ARCHS.join(', ')}`);
    process.exit(1);
  }
}

// Same single source of truth the app and the updater use: a stale hardcoded
// --app-version is how a packaged app ends up "newer" than the release that
// carries the actual fix.
const appVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// What ships inside Contents/Resources — identical basenames to the Windows
// build, which is exactly what desktop/main.mjs resolves via process.resourcesPath
// (RES_ROOT/dist, RES_ROOT/api/bridge.js, RES_ROOT/lib).
const RESOURCES = [
  { name: 'dist', from: path.join(root, 'web', 'dist') },
  { name: 'api', from: path.join(root, 'api') },
  { name: 'lib', from: path.join(root, 'lib') }
];

function packagerArgs(arch) {
  return [
    path.join(__dirname, 'node_modules', 'electron-packager', 'bin', 'electron-packager.js'),
    __dirname,
    'ANTICODEX',
    '--platform=darwin',
    `--arch=${arch}`,
    `--out=${out}`,
    '--overwrite',
    '--asar',
    `--app-version=${appVersion}`,
    '--app-bundle-id=com.anticodex.desktop',
    '--ignore=node_modules/electron($|/)',
    '--ignore=node_modules/electron-packager($|/)',
    // Self-contained runtime: the local API bridge + provider catalog ship
    // with the .app, staged (and verified) below.
    ...RESOURCES.map((r) => '--extra-resource=' + path.join(stageDir, r.name)),
    // Real .icns generated from the existing logo — packager ignores a .png.
    '--icon=' + path.join(__dirname, 'icons', 'icon.icns'),
    // anticodex:// deep links (pairing) — CFBundleURLTypes in Info.plist.
    '--protocol=anticodex',
    '--protocol-name=ANTICODEX'
  ];
}

if (dryRun) {
  console.log('ANTICODEX macOS packaging plan (--dry-run — nothing built, staged or packaged)');
  console.log(`  version:        ${appVersion} (from desktop/package.json)`);
  console.log(`  platform:       darwin, arch: ${archs.join(', ')}`);
  console.log(`  web bundle:     ${skipBuild ? 'reuse web/dist (--skip-build)' : 'npm run build in web/ (fresh)'}`);
  console.log(`  stage to:       ${stageDir}/{${RESOURCES.map((r) => r.name).join(',')}}`);
  console.log(`  icon:           desktop/icons/icon.icns (generated from desktop/icons/icon.png)`);
  for (const arch of archs) {
    console.log(`  output:         ${path.join(out, `ANTICODEX-darwin-${arch}`)}`);
    console.log(`  zip:            ${path.join(out, `ANTICODEX-${appVersion}-darwin-${arch}.zip`)}`);
    console.log(`  packager args:  ${packagerArgs(arch).slice(1).join(' ')}`);
  }
  console.log('  signing:        UNSIGNED / NOT NOTARIZED — Gatekeeper will warn on first launch');
  console.log(`  packaging host: ${process.platform === 'darwin' ? 'this Mac (ready)' : `requires macOS — this ${process.platform} host can only build + stage`}`);
  process.exit(0);
}

fs.mkdirSync(out, { recursive: true });

// Always rebuild the web bundle: the desktop app serves web/dist verbatim, so a
// stale dist directory in the repo would ship old UI. Pass --skip-build to
// reuse it deliberately.
if (!skipBuild) {
  console.log('→ building web bundle…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: path.join(root, 'web'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status);
} else if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.error('✗ --skip-build but web/dist is missing — run `npm run build --prefix web` first.');
  process.exit(1);
}

// Stage the extra resources where packaging will pick them up. This step is
// real work (copy + verify), runs on any OS, and is what --stage-only stops
// after — so Linux CI can prove the payload without a Mac.
console.log('→ staging resources…');
for (const r of RESOURCES) {
  if (!fs.existsSync(r.from)) {
    console.error(`✗ missing resource ${r.from} — cannot package an incomplete app.`);
    process.exit(1);
  }
  const dest = path.join(stageDir, r.name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(r.from, dest, { recursive: true });
  console.log(`  staged ${r.name} → ${dest}`);
}
if (!fs.existsSync(path.join(stageDir, 'api', 'bridge.js'))) {
  console.error('✗ staged api/ has no bridge.js — the packaged app would have no backend.');
  process.exit(1);
}

if (stageOnly) {
  console.log(`✓ web bundle + resources staged (--stage-only). Packaging itself requires macOS.`);
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error(`✗ the packaging step requires macOS — this host is ${process.platform}.`);
  console.error('  The web bundle and resources ARE staged (release/mac-resources); nothing was packaged.');
  console.error('  Run `npm run package:mac` on a Mac (Apple Silicon or Intel) to produce the .app.');
  process.exit(1);
}

// Real .icns from the existing logo (no new deps, no new artwork).
const icns = makeIcns(path.join(__dirname, 'icons', 'icon.png'), path.join(__dirname, 'icons', 'icon.icns'));
console.log(`→ icon: desktop/icons/icon.icns (${icns.bytes} bytes)`);

if (!fs.existsSync(path.join(__dirname, 'node_modules', 'electron-packager'))) {
  console.log('→ installing desktop packaging deps…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status);
}

for (const arch of archs) {
  console.log(`→ packaging ANTICODEX darwin-${arch}…`);
  const res = spawnSync(process.execPath, packagerArgs(arch), { stdio: 'inherit', cwd: __dirname });
  if (res.status !== 0) {
    console.error('packaging failed');
    process.exit(res.status || 1);
  }
  const appDir = path.join(out, `ANTICODEX-darwin-${arch}`);
  console.log(`\n✓ macOS app: ${path.join(appDir, 'ANTICODEX.app')}`);

  // Zip it as the release asset (bsdtar on macOS writes a real .zip from -a).
  const zipPath = path.join(out, `ANTICODEX-${appVersion}-darwin-${arch}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const zip = spawnSync('tar', ['-a', '-c', '-f', zipPath, `ANTICODEX-darwin-${arch}`], { cwd: out, stdio: 'inherit' });
  if (zip.status === 0) console.log(`✓ zip: ${zipPath}`);
  else console.log('(zip step skipped — the .app folder is ready to use)');
}

console.log('\n⚠ UNSIGNED and NOT NOTARIZED: no signing identity is configured in this repo.');
console.log('  First launch: right-click ANTICODEX.app → Open, or');
console.log('  xattr -dr com.apple.quarantine ANTICODEX.app');
console.log('  Auto-update on macOS is not implemented (updater.mjs applies the Windows');
console.log('  portable zip); reinstall from a newer GitHub Release to update.');