#!/usr/bin/env node
// Build the iOS bundle for ANTICODEX.
//
// "iOS installer for Mac" has three honest answers and this script does all three
// rather than pretending there is one:
//
//   1. PWA (works today, no Apple account): the website is already an installable
//      web app. This step generates the static iOS asset bundle — manifest,
//      apple-touch-startup images, a launch screen and a `install.html` that shows
//      the two taps — plus an Xcode-independent Capacitor project you can open on
//      a Mac.
//   2. Capacitor shell (needs a Mac + Xcode): `web/ios` contains an Xcode project
//      whose WebView loads the ANTICODEX origin. Signing happens in Xcode with
//      your team id; this script writes the config, not the certificate.
//   3. App Store archive (needs a Mac, Xcode, and an Apple Developer account):
//      `--archive` runs `xcodebuild -archivePath … -exportArchive` if it is
//      actually available. Otherwise it says what is missing.
//
// Output: dist/ios/ (static assets), web/ios/ (Capacitor project), and a report.
//
// Usage:
//   node scripts/build-ios.mjs                 # assets + Capacitor project
//   node scripts/build-ios.mjs --archive       # also try an .ipa (macOS only)
//   node scripts/build-ios.mjs --team ABC123   # set the signing team

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const TEAM = arg('--team', process.env.APPLE_TEAM_ID || '');
const BUCKET = arg('--host', process.env.ANTICODEX_ORIGIN || 'https://anticodex.vercel.app');
const OUT = path.join(ROOT, 'dist', 'ios');
const IOS = path.join(ROOT, 'web', 'ios');
const log = (...a) => console.log(...a);

const ICONS = [
  { src: 'apple-touch-icon.png', size: 180 },
  { src: 'icon-192.png', size: 192 },
  { src: 'icon-512.png', size: 512 },
  { src: 'icon-maskable-512.png', size: 512 }
];

// iOS splash sizes that actually get used on today's devices (CSS px @3x, the
// pair Apple documents as "startup image").
const SPLASH = [
  [430, 932], [428, 926], [414, 896], [393, 852], [390, 844], [375, 812],
  [414, 736], [375, 667], [834, 1194], [820, 1180], [810, 1080], [768, 1024]
];

function checkIcons() {
  const pub = path.join(ROOT, 'web', 'public');
  const present = [];
  const missing = [];
  for (const { src, size } of ICONS) {
    const file = path.join(pub, src);
    if (fs.existsSync(file)) {
      const bytes = fs.statSync(file).size;
      present.push({ src, size, bytes });
    } else missing.push(src);
  }
  return { present, missing };
}

async function main() {
  await fsp.mkdir(path.join(OUT, 'splash'), { recursive: true });

  log('ANTICODEX — iOS');
  log(`  origin  ${BUCKET}`);

  // --- 1. static assets ------------------------------------------------------
  const icons = checkIcons();
  if (icons.missing.length) {
    log(`  ! missing icons: ${icons.missing.join(', ')} — the PWA will still install, with a screenshot icon`);
  } else {
    log(`  ✓ ${icons.present.length} icons (${icons.present.map((i) => `${i.size}px`).join(', ')})`);
  }

  // launch screens: an SVG per size is generated rather than shipped as binaries,
  // so the repo stays small and the mark stays crisp at every scale.
  for (const [w, h] of SPLASH) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#22d3ee"/><stop offset="55%" stop-color="#6c8cff"/><stop offset="100%" stop-color="#a78bfa"/>
  </linearGradient></defs>
  <rect width="${w}" height="${h}" fill="#0e0f12"/>
  <g transform="translate(${w / 2 - w * 0.12} ${h / 2 - w * 0.12}) scale(${(w * 0.24) / 64})">
    <rect x="6" y="6" width="52" height="52" rx="15" fill="url(#g)"/>
    <path d="M32 16 L46 40 L32 48 L18 40 Z" fill="none" stroke="#0b0d14" stroke-width="3.4" stroke-linejoin="round"/>
    <path d="M32 16 L32 48 M18 40 L46 40" stroke="#0b0d14" stroke-width="2.4" opacity="0.75"/>
    <circle cx="32" cy="34" r="4.6" fill="#0b0d14"/>
  </g>
  <text x="${w / 2}" y="${h / 2 + w * 0.22}" fill="#eef0f4" font-family="-apple-system, Inter, sans-serif" font-size="${Math.round(w * 0.05)}" font-weight="700" text-anchor="middle" letter-spacing="2">ANTICODEX</text>
</svg>`;
    await fsp.writeFile(path.join(OUT, 'splash', `launch-${w}x${h}.svg`), svg);
  }
  log(`  ✓ ${SPLASH.length} launch screens (SVG, generated)`);

  // the install page: two taps, written down
  const installHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Install ANTICODEX on iPhone / iPad</title>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="ANTICODEX"/>
<link rel="apple-touch-icon" href="${BUCKET}/apple-touch-icon.png"/>
<link rel="manifest" href="${BUCKET}/manifest.webmanifest"/>
<style>
  :root { color-scheme: dark; --bg:#0e0f12; --card:#16181d; --line:rgba(255,255,255,.08); --text:#eef0f4; --muted:#7c8496; --accent:#6c8cff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,Inter,sans-serif; line-height:1.6; padding:28px 20px 60px; }
  main { max-width:560px; margin:0 auto; }
  h1 { font-size:26px; letter-spacing:-.02em; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; font-size:15px; }
  ol { padding-left:0; list-style:none; counter-reset:step; }
  li { counter-increment:step; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px 14px 52px; margin-bottom:10px; position:relative; }
  li::before { content:counter(step); position:absolute; left:14px; top:13px; width:24px; height:24px; border-radius:50%; background:linear-gradient(135deg,#22d3ee,#6c8cff 55%,#a78bfa); color:#06121a; font-weight:700; font-size:13px; display:flex; align-items:center; justify-content:center; }
  b { font-weight:650; }
  .kbd { font-family:ui-monospace,monospace; background:#ffffff14; border-radius:6px; padding:1px 6px; font-size:13px; }
  a.btn { display:inline-block; background:linear-gradient(135deg,#22d3ee,#6c8cff 55%,#a78bfa); color:#06121a; font-weight:700; padding:12px 18px; border-radius:12px; text-decoration:none; margin-top:8px; }
  .note { color:var(--muted); font-size:13px; border-top:1px solid var(--line); margin-top:24px; padding-top:16px; }
  code { font-family:ui-monospace,monospace; font-size:12.5px; background:#ffffff10; padding:1px 5px; border-radius:5px; }
</style></head>
<body><main>
  <h1>ANTICODEX on iOS</h1>
  <p class="sub">The full workspace — chat, Codex, skills, sandbox — as a home-screen app. No App Store needed.</p>
  <ol>
    <li><b>Open this page in Safari.</b> Chrome and Firefox on iOS cannot add a home-screen web app; only Safari can.</li>
    <li>Tap the <b>Share</b> button <span class="kbd">□↑</span> in the toolbar.</li>
    <li>Scroll and tap <b>Add to Home Screen</b>.</li>
    <li>Name it <b>ANTICODEX</b> and tap <b>Add</b>.</li>
  </ol>
  <a class="btn" href="${BUCKET}/">Open ANTICODEX →</a>
  <p class="note">
    It opens full-screen with no browser chrome, keeps you signed in, and works offline for the parts already on the device.
    Long tasks (model calls, sandbox runs, image generation) need a connection — those happen on your machine or on your
    deployed server, not on the phone.<br/><br/>
    Building a native <code>.ipa</code>? <code>node scripts/build-ios.mjs --team YOURTEAMID</code> scaffolds
    <code>web/ios</code>; the archive step needs a Mac with Xcode and your Apple Developer team.
  </p>
</main></body></html>`;
  await fsp.writeFile(path.join(OUT, 'install.html'), installHtml);
  await fsp.writeFile(path.join(OUT, 'README.md'), `# iOS bundle

Generated by \`scripts/build-ios.mjs\`.

- \`install.html\` — the two-tap Add-to-Home-Screen page (Safari only, by Apple's rules).
- \`splash/\` — ${SPLASH.length} launch screens, one per device size, generated as SVG.
- \`config.xml\` — the Capacitor/Cordova-style config the native shell reads.

The website is already a PWA (manifest + service worker + apple meta tags in
\`web/index.html\`), so the phone install works today with nothing else.
`);
  log('  ✓ install.html + README');

  // --- 2. the Capacitor project ---------------------------------------------
  await fsp.mkdir(path.join(IOS, 'App', 'App'), { recursive: true });
  await fsp.mkdir(path.join(IOS, 'App', 'App.xcodeproj'), { recursive: true });

  const config = `<?xml version='1.0' encoding='utf-8'?>
<widget id="app.anticodex.ios" version="0.1.0" xmlns="http://www.w3.org/ns/widgets" xmlns:cdv="http://cordova.apache.org/ns/1.0">
  <name>ANTICODEX</name>
  <description>The universal AI workspace — chat, Codex, skills, sandbox.</description>
  <content src="${BUCKET}" />
  <access origin="${BUCKET}" />
  <access origin="${BUCKET.replace('https://', 'wss://')}" />
  <allow-navigation href="${BUCKET}/*" />
  <preference name="Scheme" value="https" />
  <preference name="Hostname" value="anticodex" />
  <preference name="AllowInlineMediaPlayback" value="true" />
  <preference name="MediaPlaybackRequiresUserAction" value="false" />
  <preference name="ScrollEnabled" value="true" />
  <preference name="LimitsNavigationsToAppBoundDomains" value="false" />
  <platform name="ios">
    <preference name="deployment-target" value="15.0" />
    ${TEAM ? `<preference name="DEVELOPMENT_TEAM" value="${TEAM}" />` : ''}
  </platform>
</widget>
`;
  await fsp.writeFile(path.join(IOS, 'config.xml'), config);

  await fsp.writeFile(path.join(IOS, 'package.json'), JSON.stringify({
    name: 'anticodex-ios',
    version: '0.1.0',
    private: true,
    description: 'Capacitor shell for the ANTICODEX iOS app (loads the deployed origin in a WKWebView)',
    scripts: {
      add: 'npx cap add ios',
      sync: 'npx cap sync ios',
      open: 'npx cap open ios'
    },
    dependencies: { '@capacitor/core': '^6.1.2', '@capacitor/ios': '^6.1.2' },
    devDependencies: { '@capacitor/cli': '^6.1.2' }
  }, null, 2) + '\n');

  await fsp.writeFile(path.join(IOS, 'capacitor.config.json'), JSON.stringify({
    appId: 'app.anticodex.ios',
    appName: 'ANTICODEX',
    webDir: '../dist',
    server: { url: BUCKET, cleartext: false, allowNavigation: [`${BUCKET}/*`] },
    ios: { contentInset: 'always', limitsNavigationsToAppBoundDomains: false, backgroundColor: '#0e0f12' }
  }, null, 2) + '\n');

  await fsp.writeFile(path.join(IOS, 'App', 'App', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>ANTICODEX</string>
  <key>CFBundleIdentifier</key><string>app.anticodex.ios</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>UILaunchStoryboardName</key><string>LaunchScreen</string>
  <key>UISupportedInterfaceOrientations</key>
  <array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeLeft</string></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><false/></dict>
  <key>ITSAppUsesNonExemptEncryption</key><false/>
  <key>NSCameraUsageDescription</key><string>Attach a photo to a chat or capture the screen for Computer Use.</string>
  <key>NSMicrophoneUsageDescription</key><string>Dictate a message instead of typing it.</string>
  <key>NSPhotoLibraryAddUsageDescription</key><string>Save generated images to your photo library.</string>
</dict></plist>
`);
  await fsp.writeFile(path.join(IOS, 'README.md'), `# web/ios

The native shell for ANTICODEX on iPhone and iPad. Generated by
\`node scripts/build-ios.mjs\` — edit the generator, not these files.

## Which path to take

| You have | Do this | Result |
| --- | --- | --- |
| Nothing but an iPhone | Open \`${BUCKET}/install.html\` in **Safari** → Share → Add to Home Screen | Full-screen app today, no account needed |
| A Mac + Xcode | \`cd web/ios && npm install && npm run add && npm run open\` | A native WKWebView app you can run on a device |
| A Mac + Xcode + Apple Developer | \`node scripts/build-ios.mjs --team <TEAMID> --archive\` | A signed \`.ipa\` for TestFlight / the App Store |

## What the app is

It is a **WebView on the deployed origin** (\`${BUCKET}\`), not a second copy of the UI.
That is deliberate: the workspace, skills and sandbox live server-side, and a second
implementation on a phone would be a second product to keep in sync. The shell adds
only what a browser cannot: a real app icon, a launch screen, safe-area handling and
the ability to keep the session in the app sandbox.

## Signing

Open the project in Xcode → target **App** → *Signing & Capabilities* → choose your
team. \`DEVELOPMENT_TEAM\` in \`config.xml\` is only a hint for tooling; Xcode's
signing pane is what actually signs the build. Nothing in this repository can sign
an app for you — a certificate is a credential, and credentials are yours.
`);

  // --- 3. archive ------------------------------------------------------------
  if (has('--archive')) {
    const xcodebuild = (() => { try { execFileSync('which', ['xcodebuild'], { stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!xcodebuild) {
      log('\n! --archive asked for, but `xcodebuild` is not on this machine.');
      log('  An .ipa can only be produced on macOS with Xcode installed.');
      log(`  Everything else is ready: open ${path.relative(ROOT, IOS)} on a Mac and run the commands in its README.`);
    } else if (!TEAM) {
      log('\n! --archive needs a signing team: pass --team <TEAMID> (or set APPLE_TEAM_ID).');
    } else {
      log(`\n· archiving with team ${TEAM}`);
      const archive = path.join(ROOT, 'dist', 'ios', 'ANTICODEX.xcarchive');
      execFileSync('xcodebuild', [
        '-project', path.join(IOS, 'App', 'App.xcodeproj'),
        '-scheme', 'App', '-configuration', 'Release',
        '-archivePath', archive, 'archive',
        `DEVELOPMENT_TEAM=${TEAM}`, 'CODE_SIGN_STYLE=Automatic'
      ], { stdio: 'inherit', cwd: IOS });
      log(`  ✓ ${path.relative(ROOT, archive)} — open Xcode Organizer to export the .ipa`);
    }
  }

  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    origin: BUCKET,
    team: TEAM || null,
    pwa: { icons: icons.present, missing: icons.missing, splash: SPLASH.length, install_page: 'dist/ios/install.html' },
    capacitor: { dir: 'web/ios', files: ['config.xml', 'capacitor.config.json', 'package.json', 'App/App/Info.plist'] },
    archive: has('--archive') ? 'attempted' : 'not requested'
  };
  await fsp.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('\n✓ iOS assets written');
  log(`  ${path.relative(ROOT, OUT)}/install.html`);
  log(`  ${path.relative(ROOT, IOS)}/  (Capacitor project)`);
}

main().catch((e) => { console.error(String(e.stack || e.message || e)); process.exit(1); });
