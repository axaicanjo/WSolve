const CACHE = 'wordle-solver-v4';
const ASSETS = ['./', './index.html', './app.js', './words.js', './worker.js',
                './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Anything off-origin (the NYT answer endpoint) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // past.json changes daily — try the network first, fall back to the cached copy.
  if (url.pathname.endsWith('/past.json')) {
    e.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell: cache first.
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(resp => {
    const copy = resp.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    return resp;
  }).catch(() => caches.match('./index.html'))));
});
