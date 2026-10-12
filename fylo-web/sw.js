/**
 * FYLO — Service Worker v7
 *
 * Two completely different jobs, chosen by origin:
 *
 *  1. ANDROID APP (origin appassets.androidplatform.net): NO caching at all.
 *     The web assets ship inside the APK and are served by WebViewAssetLoader, so they are always
 *     exactly as new as the installed APK and are available offline by definition. A cache-first
 *     service worker on top of that can only do harm: it outlives the APK update (WebView site data
 *     is preserved across upgrades) and keeps serving the previous version's JS/CSS/HTML.
 *     Devices that still hold the old cache-first worker pick this file up as an *update to sw.js*, so
 *     in this mode the worker simply deletes every cache, unregisters itself and reloads open pages once.
 *     The page itself no longer registers a worker inside the app (see app.js).
 *
 *  2. BROWSER / PWA: network-first for the app shell (so a new deployment is picked up on the very next
 *     load while online), falling back to the cache when offline. No hand-maintained version number is
 *     needed for correctness any more; CACHE_NAME only exists to purge caches of older worker versions.
 */

const IS_ANDROID_APP = self.location.hostname === 'appassets.androidplatform.net';
const CACHE_NAME = 'fylo-v7';

if (IS_ANDROID_APP) {
  // ── Retire mode ────────────────────────────────────────────────────────────
  self.addEventListener('install', () => self.skipWaiting());

  self.addEventListener('activate', event => {
    event.waitUntil((async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch (_) { /* nothing cached / cache API unavailable */ }
      try { await self.registration.unregister(); } catch (_) {}
      try {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // One-time reload so pages that were served from the old cache are replaced by the APK's files.
        clients.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
      } catch (_) {}
    })());
  });
  // Deliberately no 'fetch' listener: every request goes straight to WebViewAssetLoader.

} else {
  // ── Browser / PWA mode ─────────────────────────────────────────────────────
  const STATIC_ASSETS = [
    './', './index.html', './app.js', './manifest.json',
    './core/constants.js', './core/logger.js', './core/eventBus.js', './core/state.js',
    './core/storage.js', './core/router.js', './core/ui.js', './core/libs.js',
    './features/reader/index.js', './features/editor/index.js', './features/camera/index.js',
    './features/tools/index.js', './features/files/index.js', './features/settings/index.js',
    './features/reader/reader.js', './features/reader/gestures.js', './features/editor/editor.js',
    './features/camera/camera.js', './features/tools/tools.js', './features/files/files.js',
    './features/settings/settings.js',
    './assets/css/main.css', './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  ];

  self.addEventListener('install', e => {
    e.waitUntil(
      caches.open(CACHE_NAME)
        .then(cache => cache.addAll(STATIC_ASSETS))
        .catch(err => console.warn('[SW] Pre-cache partial failure:', err && err.message))
        .then(() => self.skipWaiting())
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
          if (!replacedOlderVersion) return;
          return self.clients.matchAll({ type: 'window' }).then(clients => {
            clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
          });
        })
    );
  });

  self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);

    // CDN libraries: network-first, cache fallback
    if (['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'].some(h => url.hostname.includes(h))) {
      e.respondWith(
        fetch(e.request)
          .then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE_NAME).then(ch => ch.put(e.request, c)); } return r; })
          .catch(() => caches.match(e.request))
      );
      return;
    }

    // Same-origin app files: network-first (always the newest deployment), cache when offline
    if (url.origin === location.origin) {
      e.respondWith(
        fetch(e.request)
          .then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE_NAME).then(ch => ch.put(e.request, c)); } return r; })
          .catch(() => caches.match(e.request).then(hit => hit || Promise.reject(new Error('offline'))))
      );
    }
  });
}
