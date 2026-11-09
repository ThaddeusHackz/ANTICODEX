// ANTICODEX service worker — installs the app shell so an added-to-homescreen
// device opens offline, and keeps same-origin static assets fresh in the
// background. The /api/* bridge is live server traffic (provider calls, keys,
// sessions) and must NEVER be proxied, cached or replayed by this worker.

const CACHE = 'anticodex-shell-v1';

// Everything needed to paint the app without a network.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // allSettled: one missing optional asset must not abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only; cross-origin requests pass straight through untouched.
  if (url.origin !== self.location.origin) return;
  // The bridge is never cached, proxied, or stored under any circumstance.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/index.html')) || Response.error())
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const revalidate = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) return cached; // background refresh already scheduled
      const fresh = await revalidate;
      return fresh || Response.error();
    })
  );
});
