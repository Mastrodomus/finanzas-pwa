const CACHE = "finanzas-v1.0";
const ASSETS = [
  "/finanzas-pwa/",
  "/finanzas-pwa/index.html",
  "/finanzas-pwa/app.js",
  "/finanzas-pwa/manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
