#!/usr/bin/env node
// Packages ANTICODEX for Windows as a runnable folder with ANTICODEX.exe.
// Uses electron-packager (downloads the official Electron win32 x64 build from
// GitHub Releases — no wine required). The GitHub Actions workflow produces the
// full NSIS installer with proper icons on a Windows runner.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'release');

fs.mkdirSync(out, { recursive: true });

// Always rebuild the web bundle: the desktop app serves web/dist verbatim, so a
// stale dist directory in the repo would ship old UI (that is how a CSS fix can
// silently never reach the .exe). Pass --skip-build to reuse it deliberately.
const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild) {
  console.log('→ building web bundle…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: path.join(root, 'web'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status);
} else if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.error('✗ --skip-build but web/dist is missing — run `npm run build --prefix web` first.');
  process.exit(1);
}

if (!fs.existsSync(path.join(__dirname, 'node_modules', 'electron-packager'))) {
  console.log('→ installing desktop packaging deps…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status);
}

console.log('→ packaging ANTICODEX win32-x64…');
const args = [
  path.join(__dirname, 'node_modules', 'electron-packager', 'bin', 'electron-packager.js'),
  __dirname,
  'ANTICODEX',
  '--platform=win32',
  '--arch=x64',
  `--out=${out}`,
  '--overwrite',
  '--asar',
  '--app-version=0.1.7',
  '--ignore=node_modules/electron($|/)',
  '--ignore=node_modules/electron-packager($|/)',
  '--extra-resource=' + path.join(root, 'web', 'dist'),
  // Self-contained runtime: the local API bridge + provider catalog ship with the .exe
  '--extra-resource=' + path.join(root, 'api'),
  '--extra-resource=' + path.join(root, 'lib')
];

const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: __dirname });
if (res.status !== 0) {
  console.error('packaging failed');
  process.exit(res.status || 1);
}

const appDir = path.join(out, 'ANTICODEX-win32-x64');
console.log(`\n✓ Windows app: ${appDir}`);
console.log(`  Run with:    ${path.join(appDir, 'ANTICODEX.exe')}`);

// Zip it as the portable release asset (tar: available and long-path-safe on win/mac/linux).
const zipPath = path.join(out, 'ANTICODEX-0.1.7-win32-x64.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const zip = spawnSync('tar', ['-a', '-c', '-f', zipPath, 'ANTICODEX-win32-x64'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
if (zip.status === 0) console.log(`✓ Portable zip: ${zipPath}`);
else console.log('(zip step skipped — the unzipped folder is ready to use)');
