import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { parseUpdateDigest, updateUrlAllowed } from './security.mjs';

const REPO = 'ThaddeusHackz/ANTICODEX';

function cmpVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

async function fetchAsset(url, fetchImpl, maxBytes) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!updateUrlAllowed(current)) throw new Error('update asset host is not allowed');
    const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('update redirect has no location');
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`download failed ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > maxBytes) throw new Error('update asset is larger than expected');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('update asset is larger than expected');
    return bytes;
  }
  throw new Error('too many update redirects');
}

function powershellEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function verifyWindowsSignature(file, expectedPublisher = '') {
  return new Promise((resolve) => {
    const escaped = String(file).replace(/'/g, "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; @{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', powershellEncoded(script)], { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, error: 'Authenticode verification failed' });
      try {
        const result = JSON.parse(String(stdout || '{}'));
        const valid = result.status === 'Valid' && (!expectedPublisher || String(result.subject || '').includes(expectedPublisher));
        resolve({ ok: valid, status: result.status, publisher: result.subject || null, error: valid ? null : 'installer signature or publisher is not trusted' });
      } catch { resolve({ ok: false, error: 'could not read Authenticode result' }); }
    });
  });
}

export function createUpdater(currentVersion, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const platform = options.platform || process.platform;
  const expectedPublisher = options.publisher ?? process.env.ANTICODEX_UPDATE_PUBLISHER ?? '';
  const signatureVerifier = options.verifyAuthenticode || verifyWindowsSignature;
  const confirmInstall = options.confirmInstall || (async () => false);
  let lastInfo = null;

  async function check() {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ANTICODEX-Updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000)
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
      assets: (rel.assets || []).map((asset) => ({
        name: asset.name,
        size: asset.size,
        url: asset.browser_download_url,
        digest: asset.digest || null
      }))
    };
    return lastInfo;
  }

  async function downloadAndInstall() {
    if (!lastInfo?.available) return { ok: false, error: 'no update available' };
    const asset = lastInfo.assets.find((item) => /\.(?:exe|zip)$/i.test(item.name));
    if (!asset || path.basename(asset.name) !== asset.name) return { ok: false, error: 'no safe installable asset in release' };
    if (!updateUrlAllowed(asset.url)) return { ok: false, error: 'update asset host is not allowed' };

    let sumsText = '';
    let expectedDigest = parseUpdateDigest(asset.digest, asset.name);
    if (!expectedDigest) {
      const sums = lastInfo.assets.find((item) => /^SHA256SUMS(?:\.txt)?$/i.test(item.name));
      if (!sums || !updateUrlAllowed(sums.url)) return { ok: false, error: 'release has no trusted SHA-256 digest' };
      try { sumsText = (await fetchAsset(sums.url, fetchImpl, 1024 * 1024)).toString('utf8'); }
      catch (error) { return { ok: false, error: String(error.message || error) }; }
      expectedDigest = parseUpdateDigest(null, asset.name, sumsText);
    }
    if (!expectedDigest) return { ok: false, error: 'release checksum does not name this asset' };

    let bytes;
    try { bytes = await fetchAsset(asset.url, fetchImpl, Math.max(Number(asset.size) || 0, 1)); }
    catch (error) { return { ok: false, error: String(error.message || error) }; }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || bytes.length !== asset.size) {
      return { ok: false, error: 'downloaded update size does not match the release metadata' };
    }
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    const expected = Buffer.from(expectedDigest, 'hex');
    const actual = Buffer.from(actualDigest, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return { ok: false, error: 'downloaded update failed SHA-256 verification' };
    }

    const dir = path.join(os.tmpdir(), 'anticodex-update');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, asset.name);
    fs.writeFileSync(dest, bytes, { mode: 0o600 });

    if (/\.exe$/i.test(asset.name)) {
      if (platform !== 'win32') return { ok: false, error: 'Windows installer cannot run on this platform', downloaded: dest };
      const signature = await signatureVerifier(dest, expectedPublisher);
      if (!signature?.ok) {
        fs.rmSync(dest, { force: true });
        return { ok: false, error: signature?.error || 'installer signature is not valid' };
      }
      const allowed = await confirmInstall({ version: lastInfo.version, publisher: signature.publisher || 'verified publisher', file: dest });
      if (!allowed) return { ok: false, canceled: true, downloaded: dest };
      spawn(dest, [], { detached: true, stdio: 'ignore', shell: false }).unref();
      return { ok: true, installer: dest, version: lastInfo.version, publisher: signature.publisher };
    }
    return { ok: true, downloaded: dest, version: lastInfo.version, message: 'Verified update downloaded. Restart ANTICODEX to apply it.' };
  }

  return { check, downloadAndInstall };
}
