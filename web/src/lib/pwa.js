// Progressive-install plumbing.
//
// Three platforms, three completely different stories, and the UI is only allowed
// to promise what the current one can actually do:
//
//   Chrome / Edge / Android — fires `beforeinstallprompt`; the app can show its own
//     "Install" button and call prompt() later. The event must be captured at module
//     load (it fires once, early, and is gone if nothing was listening).
//   Safari on iOS — never fires anything. Installation is Share → Add to Home
//     Screen, so the app can only explain the steps and then notice it worked.
//   Firefox desktop, and any browser in a tab on iOS — cannot install at all. Saying
//     so is the honest answer, not a disabled button with no reason.
//
// Nothing here touches the network, and every failure path returns a value instead
// of throwing: this runs during app boot, where an exception is a blank page.

const DISMISS_KEY = 'acx_install_dismissed_at';
const DISMISS_DAYS = 14;

let deferredPrompt = null;
let installedThisSession = false;
const listeners = new Set();

function emit() {
  const state = platformState();
  for (const fn of listeners) {
    try { fn(state); } catch { /* a listener must not break the boot */ }
  }
}

/** What this browser can do about installation, right now. */
export function platformState() {
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  const standalone = isStandalone();
  // iPadOS 13+ reports a desktop macOS UA; the touch points give it away.
  const iPadOS = /Macintosh/.test(ua) && typeof document !== 'undefined' && (navigator.maxTouchPoints || 0) > 1;
  const ios = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  const android = /Android/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|FxiOS|CriOS/.test(ua);
  const chrome = /Chrome|Chromium|Edg|OPR/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const desktop = !ios && !android;

  let can = 'unsupported';
  if (standalone) can = 'installed';
  else if (deferredPrompt) can = 'prompt';          // Chromium said it would
  else if (ios && safari) can = 'ios-steps';
  else if (ios) can = 'ios-other-browser';
  else if (chrome) can = 'awaiting-prompt';         // Chromium, before/without the event
  else if (firefox) can = 'unsupported';

  return {
    can,
    installed: standalone,
    ios,
    android,
    desktop,
    safari,
    chrome,
    firefox,
    // A user who dismissed the offer is not nagged for two weeks.
    dismissed: isDismissed(),
    // Only a real prompt can be triggered; everything else is instructions.
    promptable: Boolean(deferredPrompt)
  };
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
    if (window.navigator.standalone === true) return true;        // iOS Safari
    if (window.location.search.includes('source=pwa')) return true;
  } catch { /* matchMedia unavailable */ }
  return false;
}

function isDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (!at) return false;
    return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

export function dismissInstall() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
  emit();
}

export function clearDismiss() {
  try { localStorage.removeItem(DISMISS_KEY); } catch { /* private mode */ }
  emit();
}

/** Subscribe to install-state changes. Returns an unsubscribe function. */
export function onInstallState(fn) {
  listeners.add(fn);
  try { fn(platformState()); } catch { /* caller's problem, not ours */ }
  return () => listeners.delete(fn);
}

/** Show the browser's own install sheet. Returns what happened, so a caller can
 *  report it — `{ outcome: 'accepted' | 'dismissed' | 'unavailable', reason }`. */
export async function promptInstall() {
  if (!deferredPrompt) {
    const s = platformState();
    return {
      outcome: 'unavailable',
      reason: s.ios
        ? 'iOS has no install prompt — use Share → Add to Home Screen.'
        : 'This browser has not offered an install prompt (it may already be installed, or it does not support one).'
    };
  }
  const evt = deferredPrompt;
  deferredPrompt = null;                 // a prompt can only be used once
  try {
    evt.prompt();
    const choice = await evt.userChoice;
    const outcome = choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
    if (outcome === 'dismissed') dismissInstall();
    else { installedThisSession = true; emit(); }
    return { outcome };
  } catch (e) {
    return { outcome: 'unavailable', reason: String(e?.message || e) };
  }
}

/** Call once, before React renders. Idempotent — StrictMode double-invocation and a
 *  second call from a page both do nothing. */
let wired = false;
export function watchInstallability() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep the event so our own button can use it; without preventDefault the
    // browser shows its own mini-infobar and the event is consumed.
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedThisSession = true;
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* private mode */ }
    emit();
  });
  // Navigating between display modes (tab → standalone) is a live transition on
  // Android Chrome, and it changes what the app should say.
  try {
    window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', () => emit());
  } catch { /* older Safari */ }
  emit();
}

export const installDebug = () => ({ ...platformState(), deferred: Boolean(deferredPrompt), installedThisSession });
