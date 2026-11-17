// Install ANTICODEX — the install-anywhere surface. iOS gets the PWA
// (Add to Home Screen), Android/desktop Chrome get beforeinstallprompt,
// macOS/Windows get the real desktop builds from GitHub Releases.
//
// Honesty rules (AGENTS.md): the version and download links come ONLY from the
// bridge's update_check action (api/bridge.js handleUpdateCheck → GitHub
// releases/latest). If the feed is unreachable or an asset is missing, the page
// says so — it never invents a version or a download URL. The releases URL
// below is the same repo desktop/updater.mjs polls (REPO constant).

import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import '../install.css';

const RELEASES_URL = 'https://github.com/ThaddeusHackz/ANTICODEX/releases/latest';

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  if (ios) return 'ios';
  if (android) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return 'other';
}

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true;
}

// The iOS Share glyph (square with an up-arrow) — the button step 2 refers to.
function ShareIcon() {
  return (
    <svg className="install-share-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="M8 7l4-4 4 4" />
      <path d="M8 10H6.5A2.5 2.5 0 0 0 4 12.5v6A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17.5 10H16" />
    </svg>
  );
}

const PLATFORM_CARDS = [
  { id: 'ios', title: 'iPhone / iPad', kind: 'Web app (PWA)', blurb: 'Add to Home Screen from Safari — full-screen, offline shell, no App Store needed.' },
  { id: 'android', title: 'Android', kind: 'Web app (PWA)', blurb: 'One-tap install from Chrome, or Add to Home Screen from the browser menu.' },
  { id: 'macos', title: 'macOS', kind: 'Native .app', blurb: 'Electron app with the local bridge, keychain and anticodex:// pairing. Unsigned build.' },
  { id: 'windows', title: 'Windows', kind: 'Portable .exe', blurb: 'Extract the release zip and run ANTICODEX.exe — auto-update included.' }
];

export default function InstallPage() {
  const [platform] = useState(detectPlatform);
  const [standalone] = useState(isStandalone);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installResult, setInstallResult] = useState(null); // 'accepted' | 'dismissed'
  const [release, setRelease] = useState(null); // null = still checking

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  useEffect(() => {
    let alive = true;
    api('update_check')
      .then((r) => { if (alive) setRelease(r && typeof r === 'object' ? r : { ok: false, error: 'unexpected bridge response' }); })
      .catch((e) => { if (alive) setRelease({ ok: false, error: String((e && e.message) || e) }); });
    return () => { alive = false; };
  }, []);

  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      setInstallResult(choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed');
    } catch {
      setInstallResult('dismissed');
    }
    setDeferredPrompt(null);
  }

  const assets = release && release.ok && Array.isArray(release.assets) ? release.assets : [];
  const winAsset = assets.find((a) => /win32/i.test(a.name) && /\.zip$/i.test(a.name))
    || assets.find((a) => /\.exe$/i.test(a.name)) || null;
  const macAsset = assets.find((a) => /darwin/i.test(a.name) && /\.zip$/i.test(a.name)) || null;

  const ua = navigator.userAgent || '';
  const iosSafari = platform === 'ios' && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);

  return (
    <div className="install-page">
      <header className="install-hero">
        <img className="install-logo" src="/icon-192.png" alt="ANTICODEX logo" width="88" height="88" />
        <h1>Install ANTICODEX</h1>
        <p className="install-tagline">One workspace, every model — on your home screen, your dock, your desktop.</p>
        {release === null && <span className="install-version-pill install-muted">Checking the release feed…</span>}
        {release && release.ok && (
          <span className="install-version-pill">Latest release: v{release.version}</span>
        )}
        {release && !release.ok && (
          <span className="install-version-pill install-warn">Release feed unreachable: {release.error}</span>
        )}
      </header>

      {standalone && (
        <div className="install-banner install-banner-ok">
          ANTICODEX is already running as an installed app on this device.
        </div>
      )}

      <section className="install-current" aria-label="Install on this device">
        <h2>This device</h2>

        {platform === 'ios' && (
          <div className="install-card install-card-active">
            <h3>Install on iPhone / iPad</h3>
            {!iosSafari && (
              <p className="install-warn">Open this page in <strong>Safari</strong> — on iOS, only Safari can add apps to the Home Screen.</p>
            )}
            <ol className="install-steps">
              <li>Open <strong>{window.location.host || 'this site'}</strong> in Safari.</li>
              <li>Tap the <strong>Share</strong> button <ShareIcon /> in the toolbar.</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong>. ANTICODEX opens full-screen from your Home Screen, like a native app.</li>
            </ol>
            <p className="install-muted">The app shell is cached for offline launch; your chats and keys stay on the server bridge.</p>
          </div>
        )}

        {platform === 'android' && (
          <div className="install-card install-card-active">
            <h3>Install on Android</h3>
            {deferredPrompt ? (
              <>
                <button className="install-btn" onClick={promptInstall}>Install ANTICODEX</button>
                {installResult === 'accepted' && <p className="install-ok-text">Installed — look for ANTICODEX on your home screen.</p>}
                {installResult === 'dismissed' && <p className="install-muted">Install dismissed. You can retry any time.</p>}
              </>
            ) : (
              <ol className="install-steps">
                <li>Open the Chrome menu <strong>⋮</strong>.</li>
                <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
                <li>Confirm — ANTICODEX opens full-screen like a native app.</li>
              </ol>
            )}
            {installResult === 'accepted' && deferredPrompt === null && standalone === false && (
              <p className="install-muted">If the icon does not appear, check your app drawer.</p>
            )}
          </div>
        )}

        {platform === 'windows' && (
          <div className="install-card install-card-active">
            <h3>Download for Windows</h3>
            {winAsset ? (
              <>
                <a className="install-btn" href={winAsset.url}>Download {winAsset.name}</a>
                <p className="install-muted">Portable zip — extract it and run <strong>ANTICODEX.exe</strong>. No installer; the app updates itself from GitHub Releases.</p>
              </>
            ) : (
              <>
                <p className="install-warn">
                  {release && release.ok
                    ? `Release v${release.version} has no Windows asset attached.`
                    : 'Could not read the release feed, so no download link can be shown.'}
                </p>
                <a className="install-btn install-btn-secondary" href={RELEASES_URL} target="_blank" rel="noreferrer">Browse GitHub Releases</a>
              </>
            )}
          </div>
        )}

        {platform === 'macos' && (
          <div className="install-card install-card-active">
            <h3>Download for macOS</h3>
            {macAsset ? (
              <>
                <a className="install-btn" href={macAsset.url}>Download {macAsset.name}</a>
                <p className="install-muted">Unsigned, not notarized: right-click ANTICODEX.app → Open on first launch.</p>
              </>
            ) : (
              <>
                <p className="install-warn">
                  {release && release.ok
                    ? `Release v${release.version} has no macOS build attached yet.`
                    : 'Could not read the release feed, so no download link can be shown.'}
                </p>
                <p>Build it on a Mac (Apple Silicon or Intel):</p>
                <pre className="install-code">cd desktop{'\n'}npm install{'\n'}npm run package:mac</pre>
                <p className="install-muted">Produces an unsigned ANTICODEX.app in release/. Until then, use the web app below.</p>
                <a className="install-btn install-btn-secondary" href={RELEASES_URL} target="_blank" rel="noreferrer">Browse GitHub Releases</a>
              </>
            )}
          </div>
        )}

        {platform === 'other' && (
          <div className="install-card install-card-active">
            <h3>Install from your browser</h3>
            {deferredPrompt ? (
              <button className="install-btn" onClick={promptInstall}>Install ANTICODEX</button>
            ) : (
              <p>Use your browser&apos;s <strong>Install</strong> / <strong>Apps</strong> menu to install this site, or grab a desktop build below.</p>
            )}
          </div>
        )}
      </section>

      <section className="install-platforms" aria-label="All platforms">
        <h2>Every platform</h2>
        <div className="install-grid">
          {PLATFORM_CARDS.map((c) => (
            <div key={c.id} className={`install-card${platform === c.id ? ' install-card-active' : ''}`}>
              <div className="install-card-head">
                <h3>{c.title}</h3>
                {platform === c.id && <span className="install-badge">This device</span>}
              </div>
              <span className="install-kind">{c.kind}</span>
              <p>{c.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="install-footer">
        {release && release.ok && release.published_at && (
          <span className="install-muted">Latest release published {String(release.published_at).slice(0, 10)}.</span>
        )}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">All releases on GitHub</a>
      </footer>
    </div>
  );
}