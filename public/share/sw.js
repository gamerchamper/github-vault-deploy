const CACHE = 'vault-share-v12';
const LEGACY_CACHES = ['vault-share-v11', 'vault-share-v10', 'vault-share-v9', 'vault-share-v8', 'vault-share-v7', 'vault-share-v6', 'vault-share-v5', 'vault-share-v4', 'vault-share-v3', 'vault-share-v2'];

const STATIC_ASSETS = [
  '/css/explorer.css',
  '/js/adaptive-concurrency.js',
  '/js/share-crypto.js',
  '/js/share-media-cache.js',
  '/js/share-client-stream.js',
  '/js/share-download.js',
  '/js/media-player.js',
  '/js/chunk-blocks.js',
  '/js/download-manager.js',
  '/js/share-viewer.js',
  '/js/share-presence.js',
  '/css/plyr.css',
  '/js/plyr.polyfilled.min.js',
  '/js/hls.min.js',
];

const CACHEABLE_PATHS = new Set(
  STATIC_ASSETS.filter((asset) => asset.startsWith('/'))
);

const CDN_ASSETS = STATIC_ASSETS.filter((asset) => asset.startsWith('http'));

function isSharePage(url) {
  return url.pathname.startsWith('/share/');
}

function isCacheableAsset(url) {
  return CACHEABLE_PATHS.has(url.pathname);
}

function isCacheableCdn(url) {
  return CDN_ASSETS.some((asset) => url.href === asset || url.href.startsWith(asset));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        (await caches.keys())
          .filter((k) => k !== CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isCacheableRequest(request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' || url.protocol === 'https:';
}

self.addEventListener('fetch', (event) => {
  if (!isCacheableRequest(event.request)) return;
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) return;

  if (isCacheableAsset(url)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isCacheableCdn(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  if (isSharePage(url)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
