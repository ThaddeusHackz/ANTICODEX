import React, { useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { CopyField, Facts, StatusPill } from '../ui.jsx';
import { onInstallState, promptInstall, dismissInstall, clearDismiss } from '../lib/pwa.js';

// Install — one page that answers "how do I actually get this on my Mac / iPhone"
// without pretending a web server can compile or sign anything.
//
// Three facts drive every row:
//   * the website is already an installable PWA (manifest + service worker), so iOS
//     works today with two taps and no Apple account;
//   * a macOS .app is a build artifact — unsigned here, signed when built on macOS
//     with a Developer ID — and the GitHub release is where the artifact lives;
//   * an .ipa needs a Mac, Xcode and your team id. Nothing on this page can conjure
//     a certificate, and it says so instead of offering a dead button.

export default function InstallPage() {
  const [release, setRelease] = useState(null);
  const [releaseErr, setReleaseErr] = useState(null);
  const [pwa, setPwa] = useState(null);
  const [detect, setDetect] = useState({ ios: false, mac: false, standalone: false, touch: false });
  // Live install state from lib/pwa.js: whether *this* browser can show a prompt,
  // whether we are already installed, and whether the offer was dismissed.
  const [installState, setInstallState] = useState(null);
  const [promptMsg, setPromptMsg] = useState(null);

  useEffect(() => {
    api.raw('update_check', {}).then(setRelease).catch((e) => setReleaseErr(e.message));
    // What this device already has, so the page can lead with the right answer.
    const ua = navigator.userAgent || '';
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
    setDetect({
      ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
      mac: /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua),
      standalone: Boolean(standalone),
      touch: navigator.maxTouchPoints > 0
    });
    const un = onInstallState(setInstallState);
    setPwa({
      manifest: Boolean(document.querySelector('link[rel=manifest]')),
      serviceWorker: 'serviceWorker' in navigator,
      appleIcon: Boolean(document.querySelector('link[rel=apple-touch-icon]')),
      registered: false
    });
    return un;
  }, []);

  async function doInstall() {
    const r = await promptInstall();
    setPromptMsg(r.outcome === 'accepted'
      ? 'Installing — the app will open in its own window.'
      : r.outcome === 'dismissed'
        ? 'Dismissed. Nothing was installed; you can offer it again from this page.'
        : (r.reason || 'This browser did not offer an install prompt.'));
  }

  const assets = release?.assets || [];
  const macArm = assets.find((a) => /arm64|aarch64/i.test(a.name));
  const macX64 = assets.find((a) => /(x64|amd64|intel)/i.test(a.name));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Install</h1>
          <p className="sub">
            ANTICODEX runs in the browser, as a desktop app, and on your phone. This page is the honest status of each: the PWA works
            right now, the macOS app is a build you can produce in one command (signed only if you sign it), and the iPhone app ships
            as a home-screen web app or a native shell you build in Xcode.
          </p>
        </div>
      </div>

      <Facts items={[
        { k: 'This device', v: detect.mac ? 'Mac' : detect.ios ? 'iPhone / iPad' : detect.touch ? 'Touch device' : 'Desktop', d: detect.standalone ? 'running installed' : 'in a browser' },
        { k: 'PWA manifest', v: pwa?.manifest ? 'linked' : 'missing', d: 'Add to Home Screen' },
        { k: 'Service worker', v: pwa?.serviceWorker ? 'supported' : 'unavailable', d: 'offline shell' },
        { k: 'Latest release', v: release?.ok ? release.version : '—', d: release?.ok ? new Date(release.published_at).toLocaleDateString() : (releaseErr || 'GitHub releases') }
      ]} />

      {/* One card that says what THIS browser can do, rather than a button that
          silently fails. Chromium gets a real prompt; Safari on iOS gets the two
          taps; a browser that cannot install says so and stays quiet. */}
      {installState && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-head">
            <h3>Install on this browser</h3>
            <div className="right">
              <StatusPill status={installState.can === 'installed' ? 'live' : installState.can === 'unsupported' ? 'missing' : 'partial'} />
              <span className="pill">{installState.can}</span>
            </div>
          </div>
          {installState.can === 'installed' && (
            <div className="tiny">
              Already installed — you are reading this in the installed app, not a tab. Nothing to do.
            </div>
          )}
          {installState.can === 'prompt' && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn small primary" onClick={doInstall}>Install ANTICODEX</button>
              <span className="tiny">Chrome/Edge will show its own install sheet. Nothing is downloaded until you accept.</span>
            </div>
          )}
          {installState.can === 'awaiting-prompt' && (
            <div className="tiny">
              This browser supports installation but has not offered its prompt yet — it usually appears after the page has been
              visited once, or use the install icon in the address bar. If the app is already installed, this stays quiet on purpose.
            </div>
          )}
          {installState.can === 'ios-steps' && (
            <ol style={{ paddingLeft: 20, fontSize: 13.5, lineHeight: 1.8, margin: '4px 0 6px' }}>
              <li>Tap the <b>Share</b> button (the square with an arrow) in Safari's toolbar.</li>
              <li>Scroll and tap <b>Add to Home Screen</b>.</li>
              <li>Tap <b>Add</b> — the app opens full-screen from the home screen, with no Safari chrome.</li>
            </ol>
          )}
          {installState.can === 'ios-other-browser' && (
            <div className="tiny">
              On iOS only Safari can add an app to the home screen. Open this page in Safari to install it — Chrome and Firefox on
              iPhone are Safari underneath but do not expose the Share → Add to Home Screen flow.
            </div>
          )}
          {installState.can === 'unsupported' && (
            <div className="tiny">
              This browser cannot install a web app (Firefox desktop is the common case). The macOS app and the PWA on a phone are
              the two paths that work; this page has both below.
            </div>
          )}
          {promptMsg && <div className="tiny" style={{ marginTop: 6 }}>{promptMsg}</div>}
          {installState.dismissed && (
            <div className="tiny" style={{ marginTop: 6 }}>
              You dismissed the offer, so the app will not ask for 14 days.{' '}
              <button className="btn tiny ghost" onClick={clearDismiss}>Ask me again</button>
            </div>
          )}
          {!installState.dismissed && installState.can !== 'installed' && installState.can !== 'unsupported' && (
            <button className="btn tiny ghost" style={{ marginTop: 6 }} onClick={dismissInstall}>Not now</button>
          )}
        </div>
      )}

      {/* ---------------- iOS ---------------- */}
      <div className="section">
        <h2>iPhone &amp; iPad</h2>
        <div className="grid two">
          <div className="card">
            <div className="card-head">
              <h3>Home-screen app</h3>
              <div className="right"><StatusPill status="live" /><span className="pill">no App Store</span></div>
            </div>
            <ol style={{ paddingLeft: 20, fontSize: 13.5, lineHeight: 1.8, margin: '4px 0 10px' }}>
              <li>Open this site in <b>Safari</b> (Apple only allows Safari to install web apps).</li>
              <li>Tap <b>Share</b> <span className="kbd">□↑</span>.</li>
              <li>Tap <b>Add to Home Screen</b>, name it <b>ANTICODEX</b>, tap <b>Add</b>.</li>
            </ol>
            <div className="row wrap" style={{ gap: 6 }}>
              <a className="btn small primary" href="/install">Open the one-page guide</a>
              <a className="btn small" href="/manifest.webmanifest" target="_blank" rel="noreferrer">Inspect the manifest</a>
            </div>
            <div className="tiny" style={{ marginTop: 8 }}>
              Installed this way it opens full-screen, keeps your session, and survives a dropped connection for everything already on the device.
              {detect.ios ? ' You are on iOS — this is the fastest path.' : ''}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Native <code className="code-inline">.ipa</code></h3>
              <div className="right"><StatusPill status="needs-cli" /></div>
            </div>
            <p className="tiny" style={{ marginTop: 0 }}>
              A Capacitor shell that loads the deployed origin in a <code className="code-inline">WKWebView</code>. It adds an app icon,
              a launch screen and safe-area handling — not a second implementation of the UI, because a second UI is a second product to
              keep in sync.
            </p>
            <CopyField label="1 · scaffold the project (any OS)" value="node scripts/build-ios.mjs --team YOURTEAMID" />
            <CopyField label="2 · on a Mac, open it in Xcode" value="cd web/ios && npm install && npx cap add ios && npx cap open ios" />
            <CopyField label="3 · archive a signed build (Mac + Apple Developer)" value="node scripts/build-ios.mjs --team YOURTEAMID --archive" />
            <div className="tiny" style={{ marginTop: 8 }}>
              Signing is done by Xcode with your team, in the Signing &amp; Capabilities pane. No script can invent a certificate — that is
              why step 3 says “Mac + Apple Developer” rather than pretending otherwise.
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- macOS ---------------- */}
      <div className="section">
        <h2>macOS</h2>
        <div className="grid two">
          <div className="card">
            <div className="card-head">
              <h3>Build the app</h3>
              <div className="right"><StatusPill status="live" /><span className="pill">Electron</span></div>
            </div>
            <CopyField label="Apple silicon or Intel — pick the arch" value="node desktop/package-mac.mjs --arch arm64 --release" />
            <CopyField label="Signed + notarised (run on macOS)" value={'CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \\\n  APPLE_ID=you@example.com APPLE_TEAM_ID=TEAMID APPLE_APP_PASSWORD=xxxx \\\n  node desktop/package-mac.mjs --arch arm64 --release --sign'} />
            <div className="tiny" style={{ marginTop: 8 }}>
              Produces <code className="code-inline">desktop/release/ANTICODEX-darwin-arm64/ANTICODEX.app</code>, a
              <code className="code-inline"> .zip</code> and (on macOS) a <code className="code-inline">.dmg</code>. Without a Developer ID
              the bundle is unsigned — Gatekeeper will ask once, and right-click → Open works. The script prints exactly which of the two
              it produced, so a build never claims to be signed when it is not.
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Download a build</h3>
              <div className="right">
                {release?.ok ? <StatusPill status="live" /> : <StatusPill status="partial" />}
              </div>
            </div>
            {release?.ok ? (
              <>
                <div className="tiny" style={{ marginBottom: 8 }}>Release {release.version} · {new Date(release.published_at).toLocaleString()}</div>
                <table className="tbl">
                  <caption className="sr-only">macOS downloads in this release</caption>
                  <thead><tr><th scope="col">File</th><th scope="col">Size</th><th scope="col">Download</th></tr></thead>
                  <tbody>
                    {macArm && <tr><td className="mono tiny">{macArm.name}</td><td className="num">{(macArm.size / 1024 / 1024).toFixed(1)} MB</td><td><a className="btn small" href={macArm.url}>Download</a></td></tr>}
                    {macX64 && <tr><td className="mono tiny">{macX64.name}</td><td className="num">{(macX64.size / 1024 / 1024).toFixed(1)} MB</td><td><a className="btn small" href={macX64.url}>Download</a></td></tr>}
                    {!macArm && !macX64 && <tr><td colSpan={3} className="tiny">This release has no macOS asset yet — build it with the command on the left, or open the release page.</td></tr>}
                  </tbody>
                </table>
                <div className="row" style={{ gap: 6, marginTop: 10 }}>
                  <a className="btn small" href={`https://github.com/ThaddeusHackz/ANTICODEX/releases/tag/v${release.version}`} target="_blank" rel="noreferrer">Release page</a>
                  <a className="btn small ghost" href="https://github.com/ThaddeusHackz/ANTICODEX/releases" target="_blank" rel="noreferrer">All releases</a>
                </div>
              </>
            ) : (
              <div className="tiny">
                No published release could be read ({releaseErr || 'not checked yet'}). The app still builds locally with one command, and the
                release workflow publishes macOS, Windows and Linux artifacts when a tag is pushed.
              </div>
            )}
            <div className="tiny" style={{ marginTop: 10 }}>
              The Windows build is <code className="code-inline">npm run package:win</code>; Linux uses electron-packager with
              <code className="code-inline"> --platform=linux</code>.
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- what installation buys ---------------- */}
      <div className="section">
        <h2>What the install adds</h2>
        <table className="tbl">
          <thead><tr><th>Capability</th><th>Browser</th><th>Home-screen (iOS)</th><th>Desktop app</th></tr></thead>
          <tbody>
            {[
              ['Chat, skills, library, connectors', 'yes', 'yes', 'yes'],
              ['Offline shell (app paints without network)', 'yes (service worker)', 'yes', 'yes'],
              ['Local sandbox execution', 'only via a local server', 'no — runs on your server', 'yes'],
              ['Daytona SSH execution', 'no — the browser cannot open port 22', 'no', 'yes'],
              ['Computer Use (screen + input)', 'no', 'no', 'yes'],
              ['Provider keys in the OS keychain', 'no', 'no', 'yes (safeStorage)'],
              ['Reading ~/.qoder/skills', 'no', 'no', 'yes']
            ].map(([cap, b, i, d]) => (
              <tr key={cap}><td>{cap}</td><td className="tiny">{b}</td><td className="tiny">{i}</td><td className="tiny">{d}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="tiny" style={{ marginTop: 8 }}>
          The browser cannot open an SSH socket or read your filesystem — that is the platform, not a missing feature. The desktop app is
          where those live; the phone is a remote control for work happening on your machine or your server.
        </div>
      </div>
    </div>
  );
}
