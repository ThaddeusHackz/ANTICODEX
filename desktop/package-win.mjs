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

// Ensure the web bundle exists (the desktop app loads it offline).
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.log('→ building web bundle first…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: path.join(root, 'web'), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status);
}

if (!fs.existsSync(path.join(__dirname, 'node_modules', 'electron-packager'))) {
  console.log('→ installing desktop packaging deps…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit' });
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
  '--app-version=0.1.0',
  '--ignore=node_modules/electron($|/)',
  '--ignore=node_modules/electron-packager($|/)',
  '--extra-resource=' + path.join(root, 'web', 'dist')
];

const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: __dirname });
if (res.status !== 0) {
  console.error('packaging failed');
  process.exit(res.status || 1);
}

const appDir = path.join(out, 'ANTICODEX-win32-x64');
console.log(`\n✓ Windows app: ${appDir}`);
console.log(`  Run with:    ${path.join(appDir, 'ANTICODEX.exe')}`);

// Zip it as the portable release asset.
const zipPath = path.join(out, 'ANTICODEX-0.1.0-win32-x64.zip');
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
const zip = spawnSync('zip', ['-qr', zipPath, 'ANTICODEX-win32-x64'], { cwd: out, stdio: 'inherit' });
if (zip.status === 0) console.log(`✓ Portable zip: ${zipPath}`);
else console.log('(zip utility not available — the unzipped folder is ready to use)');
