# macOS and iOS

Two platforms, two completely different amounts of what a build script can do for
you. This document is the honest split.

## macOS — `node desktop/package-mac.mjs`

| Step | Runs anywhere? | Produces |
| --- | --- | --- |
| Rebuild `web/dist` | yes | a current renderer (a stale bundle is how a UI fix never ships) |
| `electron-packager --platform=darwin` | yes | `desktop/release/ANTICODEX-darwin-<arch>/ANTICODEX.app` — **unsigned** |
| `codesign --options runtime` | macOS only | a signed bundle |
| `xcrun notarytool submit` + `stapler` | macOS only | a notarised bundle (no Gatekeeper warning) |
| `ditto -c -k` | macOS only | `ANTICODEX-darwin-<arch>.zip` |
| `hdiutil create` | macOS only | `ANTICODEX-darwin-<arch>.dmg` |

```bash
# unsigned, either arch, from any machine
node desktop/package-mac.mjs --arch arm64 --release

# signed + notarised, on a Mac with a Developer ID Application certificate
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com" APPLE_TEAM_ID="TEAMID" APPLE_APP_PASSWORD="app-specific-password"
node desktop/package-mac.mjs --arch arm64 --release --sign
```

The script prints which of the two it produced. It never writes "signed" over an
unsigned bundle — an unsigned app that claims to be signed is how people learn to
click through Gatekeeper, which is worse than the warning.

**First launch of an unsigned build:** right-click → Open, once. After that macOS
remembers it.

**Universal binary:** run it twice (`--arch x64`, `--arch arm64`) and `lipo` the two
executables, or add `--arch=universal` to a fork of the packager call. Two artifacts
is the simpler release story, so that is the default here.

## iOS — `node scripts/build-ios.mjs`

There is no "installer" for iOS in the desktop sense. Three levels, pick by what you
have:

### 1. Home-screen web app — nothing needed, works today

The site is already a PWA: `manifest.webmanifest`, a service worker, `apple-touch-icon`,
`apple-mobile-web-app-capable` and a black-translucent status bar. On an iPhone:

1. open the site in **Safari** (Apple only allows Safari to install web apps — Chrome
   on iOS is a WebKit wrapper and cannot add to the home screen);
2. Share → **Add to Home Screen**;
3. name it, Add.

`scripts/build-ios.mjs` writes the same instructions to `dist/ios/install.html`,
generates 12 launch screens (SVG, one per current device size) and reports which
icons exist.

What you get: full-screen, no browser chrome, session persisted, offline shell.
What you do not get: filesystem access, an SSH socket, or a background process. The
phone is a remote control for work happening on your machine or your server — that
is the platform, not a missing feature (`/install` has the same table).

### 2. Capacitor shell — Mac + Xcode

```
node scripts/build-ios.mjs --team YOURTEAMID
cd web/ios && npm install && npx cap add ios && npx cap open ios
```

`web/ios` is a project whose `WKWebView` loads the deployed origin (`server.url` in
`capacitor.config.json`). It is deliberately *not* a second copy of the UI: the
workspace, skills and sandbox live server-side, and a second implementation would be
a second product to keep in sync.

Signing happens in Xcode → target **App** → *Signing & Capabilities* → your team.
`DEVELOPMENT_TEAM` in `config.xml` is a hint for tooling; Xcode's pane is what signs.

### 3. Archive for TestFlight / the App Store — Mac + Xcode + Apple Developer

```
node scripts/build-ios.mjs --team YOURTEAMID --archive
```

This runs `xcodebuild -archivePath dist/ios/ANTICODEX.xcarchive archive`. It refuses
with an explanation when `xcodebuild` is absent or no team is given, instead of
failing halfway through with a linker error.

Exporting the `.ipa` from the archive is an Organizer step (or `xcodebuild
-exportArchive` with an `ExportOptions.plist` naming your provisioning profile).
The profile is a credential; it belongs to your Apple account, not to this repo.

## What each target can do

| Capability | Browser | Home-screen (iOS) | macOS app |
| --- | --- | --- | --- |
| Chat, skills, library, connectors | yes | yes | yes |
| Offline shell | yes | yes | yes |
| Local sandbox execution | only via a local server | via your server | yes |
| Daytona SSH execution | no (no socket) | no | yes |
| Computer Use | no | no | yes |
| Keys in the OS keychain | no | no | yes (`safeStorage`) |
| Read `~/.qoder/skills` | no | no | yes |

## CI

`.github/workflows/release.yml` builds the Windows artifact on `windows-latest`. A
macOS job needs a `macos-14` runner and five secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`) to sign; without them the job still
publishes an unsigned `.app`/`.zip` and says so in the release notes.
