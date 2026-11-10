import React, { useEffect, useState } from 'react';
import * as api from '../lib/api.js';
import { CopyField, Facts, StatusPill } from '../ui.jsx';

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
    setPwa({
      manifest: Boolean(document.querySelector('link[rel=manifest]')),
      serviceWorker: 'serviceWorker' in navigator,
      appleIcon: Boolean(document.querySelector('link[rel=apple-touch-icon]')),
      registered: false
    });
  }, []);

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
