/*
 * Service worker.
 *
 * Hand-written rather than generated, because the caching rules for this app
 * are two sentences long and a plugin would add a build step to express them.
 *
 * Strategy:
 *  - Navigations: network first, fall back to the cached shell. A gym with no
 *    signal must still open the logger.
 *  - Static assets: cache first. Vite fingerprints filenames, so a cached
 *    asset is immutable and a new build simply asks for different names.
 *
 * Nothing user-generated is cached here. Training data lives in IndexedDB and
 * never travels over the network, because there is no network to travel over.
 */
const CACHE = 'overload-v1';
const SHELL = new URL('./', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([SHELL])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
