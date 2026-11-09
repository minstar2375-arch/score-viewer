// 앱 화면을 저장해 인터넷 없이도 열리게 합니다. 파일을 고치면 VERSION을 올리세요.
importScripts('vendor/pdfjs/assets.js');

const VERSION = 'v2';
const CACHE = `score-viewer-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/pdf.js',
  'js/ui.js',
  'js/viewer.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdfjs/assets.js',
  // 글꼴을 포함하지 않은 PDF도 인터넷 없이 열리도록 글꼴 자료까지 저장합니다.
  ...self.PDFJS_ASSETS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 저장된 파일을 먼저 보여 주고, 뒤에서 새 버전으로 갱신합니다.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const refresh = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        refresh.catch(() => {});
        return cached;
      }
      return refresh;
    }),
  );
});
