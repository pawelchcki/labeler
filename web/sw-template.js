const CACHE = 'labeler-__BUILD_HASH__';
const BUILD = '__BUILD_HASH__';
const FILES = ['./', './index.html', './styles.css', './app.mjs', './updates.mjs', './engine.mjs', './engine-worker.mjs', './bluetooth.mjs', './jobs.mjs', './icon.svg', './pkg/labeler.wasm', './pkg/NotoSans-Regular.ttf', './pkg/OFL.txt', './pkg/Noto-fonts-LICENSE.txt'];
self.addEventListener('install', event => {
  // Activate a fully cached update so the next navigation gets the new app.
  // Existing pages keep their already-loaded JS and WASM; never reload mid-print.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'LABELER_VERSION', build: BUILD });
    for (const key of await caches.keys()) if (key.startsWith('labeler-') && key !== CACHE) await caches.delete(key);
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(new Request(event.request, { cache: 'no-store' }));
        if (response.ok) return response;
        throw new Error('Navigation unavailable');
      } catch {
        return (await caches.open(CACHE)).match(new URL('./index.html', self.registration.scope));
      }
    })());
  } else if (new URL(event.request.url).pathname.endsWith('/version.json')) {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
  } else {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
  }
});
