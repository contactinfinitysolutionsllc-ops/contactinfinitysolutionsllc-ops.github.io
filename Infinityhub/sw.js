// Infinity Learn — Service Worker
// Cache version: bump this string to force all clients to update
const CACHE_VERSION = 'infinitylearn-v1';

// Resources to cache immediately on install (app shell)
const SHELL = [
  './education.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Instrument+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap'
];

// ── Install: cache app shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // Cache what we can; font CDN may fail in dev — that's ok
      return Promise.allSettled(SHELL.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve cached shell, network for everything else ────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for:
  // • The Cloudflare worker (AI calls)
  // • Supabase (auth + database)
  // • Any POST request
  if (
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('supabase.co') ||
    event.request.method !== 'GET'
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for app shell, network-first with cache fallback for everything else
  const isShell = SHELL.some(s => event.request.url.includes(s.replace('./', '')));

  if (isShell) {
    // Cache-first: serve instantly from cache, update in background
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          }
          return response;
        }).catch(() => null);
        return cached || networkFetch;
      })
    );
  } else {
    // Network-first with cache fallback for fonts and other resources
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
