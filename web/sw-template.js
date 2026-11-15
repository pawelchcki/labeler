const CACHE = 'labeler-__BUILD_HASH__';
const FILES = ['./', './index.html', './styles.css', './app.mjs', './engine.mjs', './engine-worker.mjs', './bluetooth.mjs', './jobs.mjs', './icon.svg', './pkg/labeler.wasm', './pkg/NotoSans-Regular.ttf', './pkg/OFL.txt', './pkg/Noto-fonts-LICENSE.txt'];
self.addEventListener('install', event => {
  // Activate a fully cached update so the next navigation gets the new app.
  // Existing pages keep their already-loaded JS and WASM; never reload mid-print.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('labeler-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
