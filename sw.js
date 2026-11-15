// Service worker: tiene app e contenuti sul dispositivo, così l'app si apre senza rete.
// Strategia: si risponde subito dalla copia locale e, se c'è rete, la si aggiorna in background.
const CACHE = 'rajasthan-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'data/tappe.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Le chiamate a GitHub per la sincronizzazione non passano mai dalla cache.
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      e.waitUntil(network);
      return cached;
    }
    const res = await network;
    return res || new Response('Non disponibile offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
