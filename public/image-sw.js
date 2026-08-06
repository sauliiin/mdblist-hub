/**
 * Service worker que persiste as imagens (posters, backdrops, avatares, logos
 * de addons) no Cache Storage. É cache-first: uma imagem já vista carrega do
 * disco sem tocar a rede — na segunda abertura do app, a home inteira pinta
 * sem baixar um byte de artwork.
 *
 * Só requisições com destination === 'image' e de outra origem passam por
 * aqui; os assets do próprio app já são locais e todo o resto (APIs, streams,
 * legendas) segue direto pra rede.
 */

const CACHE = 'images-v1';
/** Teto de entradas; acima disso as mais antigas são descartadas (FIFO). */
const MAX_ENTRIES = 1500;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches de versões anteriores deste SW.
      for (const key of await caches.keys()) {
        if (key !== CACHE && key.startsWith('images-')) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.destination !== 'image') return;
  if (new URL(request.url).origin === self.location.origin) return;
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

  const response = await fetch(request);
  // <img> cross-origin chega como resposta "opaque" (status 0) — cacheável
  // do mesmo jeito; só não dá pra inspecionar. Erros de rede lançam antes.
  if (response.ok || response.type === 'opaque') {
    persist(cache, request, response.clone());
  }
  return response;
}

/** Grava e apara o cache sem atrasar a resposta da imagem. */
function persist(cache, request, response) {
  cache
    .put(request, response)
    .then(async () => {
      const keys = await cache.keys();
      const excess = keys.length - MAX_ENTRIES;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    })
    .catch(() => {});
}
