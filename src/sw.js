/* Tikka Bites service worker. The precache list and version are injected at build time (vite.config.ts).
   All paths are relative to this file, so the app works at a site root or in a sub-folder (GitHub Pages). */
const VERSION = '__VERSION__';
const CACHE = `restobill-${VERSION}`;
const PRECACHE = __PRECACHE__;
const BASE = self.registration.scope; // e.g. https://user.github.io/repo/
const INDEX = new URL('index.html', BASE).href;
const ASSETS = new URL('assets/', BASE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((p) => new URL(p, BASE).href))));
  // Do not skipWaiting automatically: the page asks the user before updating.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('restobill-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !req.url.startsWith(BASE)) return;

  // Pages: network first (fresh deploys), cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put(INDEX, copy));
          return res;
        })
        .catch(() => caches.match(INDEX)),
    );
    return;
  }

  // Hashed assets, icons, photos: cache first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && req.url.startsWith(ASSETS)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
