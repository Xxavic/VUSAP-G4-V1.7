// VUSAP — Service Worker
// Provides offline-first caching so the app behaves like a native installed app.

const CACHE_NAME = 'vusap-v9';
const CORE_ASSETS = [
  './index.html',
  './manifest.json',
  './app.js',
  './qrcode.min.js',
  './jsQR.min.js',
  './chart.min.js',
  './icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// app.js is under active development and must never go stale behind the
// cache — treat it exactly like navigation requests: network-first, cache
// only as an offline fallback. Third-party libs (qrcode/jsQR) essentially
// never change once vendored in, so those stay cache-first for speed.
const NETWORK_FIRST_PATHS = ['./index.html', './app.js'];

function isNetworkFirst(request){
  return request.mode === 'navigate' || NETWORK_FIRST_PATHS.some(p => request.url.endsWith(p.replace('./', '/')));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever manage same-origin app-shell files. Cross-origin requests
  // (Supabase API calls, CDN scripts) must pass straight through untouched —
  // intercepting them is both unnecessary and unsafe: the Cache API only
  // supports caching GET requests, so attempting to cache a Supabase
  // POST/PATCH response throws internally and corrupts the real request,
  // which is what was breaking notification writes (and potentially other
  // live writes) even though nothing was actually wrong with the app or the
  // Supabase side.
  if (new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (isNetworkFirst(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => {
            if (cached) return cached;
            return caches.match('./index.html').then((indexCached) => {
              // Absolute last resort — event.respondWith() requires a real
              // Response no matter what; handing it `undefined` (which
              // happens if nothing is cached yet, e.g. the very first visit
              // to a brand-new deployment before the cache has populated)
              // throws "Failed to convert value to 'Response'" and hard-
              // fails the entire page load, not just this one asset.
              return indexCached || new Response(
                'Offline and no cached version available yet. Please reconnect and reload.',
                { status: 503, headers: { 'Content-Type': 'text/plain' } }
              );
            });
          })
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cached || new Response(
          'Offline and no cached version available yet.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } }
        ));
    })
  );
});
