// Service worker : l'application fonctionne hors ligne (les chapitres sont dans IndexedDB).
const VERSION = 'relecteur-v3';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/db.js',
  './js/fetcher.js',
  './js/extractor.js',
  './js/settings.js',
  './js/tts.js',
  './js/reader.js',
  './js/intro.js',
  './js/mood.js',
  './js/music.js',
  './js/neural.js',
  './js/sync.js',
  './vendor/Readability.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'relecteur-fonts').map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices Google : cache d'abord (elles ne changent pas)
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(caches.open('relecteur-fonts').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Fichiers de l'application : réseau d'abord (mises à jour immédiates), cache si hors ligne
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
    );
  }
  // Tout le reste (sites de romans, proxys, YouTube, API de voix) : pas d'interception.
});
