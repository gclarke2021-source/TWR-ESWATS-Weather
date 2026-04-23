// Cache version — bump this (or redeploy) to force all installed PWAs to update
// This timestamp is replaced at deploy time; changing it invalidates the old cache.
const CACHE = 'weather-v20260423-001';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
  // Force this SW to become active immediately, replacing any old version
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Delete ALL old caches so stale installs get fresh assets
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    // Network-first for API; fall back to cached response if offline
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for shell assets
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
