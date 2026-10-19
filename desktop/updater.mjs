// Auto-updater — polls the GitHub Releases feed of ThaddeusHackz/ANTICODEX.
// When a newer version exists the UI offers it; only after the user ACCEPTS do
// we download the asset and launch the installer / replace the app payload.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = 'ThaddeusHackz/ANTICODEX';

function cmpVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function createUpdater(currentVersion) {
  let lastInfo = null;

  async function check() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ANTICODEX-Updater', Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return { ok: false, error: `release feed ${res.status}` };
    const rel = await res.json();
    const version = (rel.tag_name || '').replace(/^v/, '');
    lastInfo = {
      ok: true,
      current: currentVersion,
      version,
      available: cmpVer(version, currentVersion) > 0,
      notes: rel.body || '',
      publishedAt: rel.published_at,
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
    };
    return lastInfo;
  }

  async function downloadAndInstall() {
    if (!lastInfo?.available) return { ok: false, error: 'no update available' };
    const exe = lastInfo.assets.find((a) => a.name.endsWith('.exe') || a.name.endsWith('.zip'));
    if (!exe) return { ok: false, error: 'no installable asset in release' };

    const dir = path.join(os.tmpdir(), 'anticodex-update');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, exe.name);

    const res = await fetch(exe.url);
    if (!res.ok) return { ok: false, error: `download failed ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);

    // NSIS installers run silently on user acceptance; zips are extracted next
    // to the running app and applied on restart.
    if (exe.name.endsWith('.exe')) {
      const { spawn } = await import('node:child_process');
      spawn(dest, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, installer: dest, message: 'Installer launched — the update applies when ANTICODEX restarts.' };
    }
    return { ok: true, downloaded: dest, message: 'Update downloaded. Restart ANTICODEX to apply.' };
  }

  return { check, downloadAndInstall };
}
