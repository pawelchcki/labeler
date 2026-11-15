/** Updates are explicit: never navigate a page while a physical print is active. */
export function setupUpdates({ isPrinting, onAvailable }) {
  const current = document.querySelector('meta[name=labeler-build]')?.content;
  const version = document.getElementById('app-version');
  const checkButton = document.getElementById('check-update');
  const loadButton = document.getElementById('load-update');
  const status = document.getElementById('update-status');
  let latest, registration, lastCheck = 0;
  const valid = build => /^[0-9a-f]{16}$/.test(build || '');
  if (!valid(current)) { version.textContent = 'Development build'; checkButton.hidden = true; return; }
  version.textContent = `Build ${current.slice(0, 8)}`;
  function available(build) {
    if (!valid(build) || build === current) return;
    latest = build;
    document.getElementById('app-update').hidden = false;
    status.textContent = 'Update ready';
    onAvailable();
  }
  async function check(manual = false) {
    if (isPrinting() || (!manual && Date.now() - lastCheck < 60000)) return;
    lastCheck = Date.now();
    if (manual) status.textContent = 'Checking…';
    try {
      registration?.update().catch(() => {});
      const response = await fetch(new URL('./version.json', document.baseURI), { cache: 'no-store' });
      if (!response.ok) throw new Error('Version unavailable');
      const data = await response.json();
      if (!valid(data.build)) throw new Error('Invalid version');
      available(data.build);
      if (manual && data.build === current) status.textContent = 'Up to date';
    } catch { if (manual) status.textContent = 'Offline. Try again when connected.'; }
  }
  checkButton.addEventListener('click', () => check(true));
  loadButton.addEventListener('click', () => {
    if (isPrinting() || !latest) return;
    const url = new URL('./', document.baseURI);
    // Also bypass caches belonging to the original cache-first service worker.
    url.searchParams.set('v', latest);
    location.assign(url.href);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ({ data }) => {
      if (data?.type === 'LABELER_VERSION') available(data.build);
    });
    navigator.serviceWorker.register(new URL('./service-worker.js', document.baseURI), { updateViaCache: 'none' })
      .then(result => { registration = result; check(); }).catch(() => check());
  } else check();
  window.addEventListener('focus', () => check());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(() => { if (!document.hidden) check(); }, 60000);
}
