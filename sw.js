// Service worker: tiene app e contenuti sul dispositivo, così l'app si apre senza rete.
// Strategia: si risponde subito dalla copia locale e, se c'è rete, la si aggiorna in background.
const CACHE = 'rajasthan-v3';
const FOTO = 'rajasthan-foto';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'data/tappe.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'font/rozha.woff2',
  'font/mukta-400.woff2',
  'font/mukta-600.woff2',
  'font/mukta-700.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FOTO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Foto delle tappe (Wikimedia Commons): prima la copia sul dispositivo, poi la rete.
  if (/(^|\.)wikimedia\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(FOTO);
      const cached = await cache.match(req.url);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req.url, res.clone());
      return res;
    })());
    return;
  }

  // Meteo e sincronizzazione con GitHub non passano mai dalla cache.
  if (url.origin !== self.location.origin) return;

  // Controllo della versione e richieste "fresche": sempre dalla rete.
  if (url.pathname.endsWith('/versione.json') || url.searchParams.has('fresco')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

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
