// TCG Radar service worker — cache dell'app per caricamento istantaneo e offline.
const CACHE = 'tcg-radar-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // I dati (data.json) e le API esterne: sempre dalla rete (freschi).
  if (url.pathname.endsWith('.json') || url.origin !== self.location.origin) return;

  // Asset statici con hash nel nome (bundle, font): cache-first.
  if (/\/(_expo|assets)\//.test(url.pathname) || /\.(js|css|ttf|woff2?|png|ico)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }

  // Navigazione / index: network-first (per prendere subito nuove versioni),
  // con fallback alla cache se offline.
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
