/**
 * FYLO — Service Worker v3
 * Caches exactly the files that exist in the project.
 * Cache-first for app files. Network-first for CDN.
 */

// Bump whenever shipped JS/HTML changes so activate() purges the previous app shell.
// v4 purged the pre-router-fix shell; v5 ships the camera/permission, Manage and debug-overlay-removal changes.
const CACHE_NAME = 'fylo-v5';

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  // Core layer
  './core/constants.js',
  './core/logger.js',
  './core/eventBus.js',
  './core/state.js',
  './core/storage.js',
  './core/router.js',
  './core/ui.js',
  './core/libs.js',
  // Feature entry points
  './features/reader/index.js',
  './features/editor/index.js',
  './features/camera/index.js',
  './features/tools/index.js',
  './features/files/index.js',
  './features/settings/index.js',
  // Feature implementations
  './features/reader/reader.js',
  './features/reader/gestures.js',
  './features/editor/editor.js',
  './features/camera/camera.js',
  './features/tools/tools.js',
  './features/files/files.js',
  './features/settings/settings.js',
  // Assets
  './assets/css/main.css',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache partial failure:', err.message))
  );
});

self.addEventListener('activate', e => {
  let replacedOlderVersion = false;
  e.waitUntil(
    caches.keys()
      .then(keys => {
        const stale = keys.filter(k => k !== CACHE_NAME);
        replacedOlderVersion = stale.length > 0;
        return Promise.all(stale.map(k => caches.delete(k)));
      })
      .then(() => self.clients.claim())
      .then(() => {
        // Tell open pages about an update ONLY if this activation replaced an older version.
        // A first-ever install is not an "update"; announcing it made the app reload itself
        // ~6 s after launch, wiping whatever the user was doing (camera, search, dialogs).
        if (!replacedOlderVersion) return;
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // CDN: network-first, cache fallback
  if (['cdn.jsdelivr.net','unpkg.com','cdnjs.cloudflare.com'].some(h => url.hostname.includes(h))) {
    e.respondWith(
      fetch(e.request)
        .then(r => { if (r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone())); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Same-origin: cache-first
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(r => {
          if (r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
          return r;
        });
      })
    );
  }
});
