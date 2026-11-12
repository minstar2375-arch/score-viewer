// 앱 화면을 저장해 인터넷 없이도 열리게 합니다. 파일을 고치면 VERSION을 올리세요.
importScripts('vendor/pdfjs/assets.js');

const VERSION = 'v27';
const CACHE = `score-viewer-${VERSION}`;
// 피아노 녹음: A0, C1 ~ A7(3반음 간격), C8
const PIANO_SAMPLES = ['A0', 'C8'];
for (let octave = 1; octave <= 7; octave += 1) {
  for (const note of ['C', 'Ds', 'Fs', 'A']) PIANO_SAMPLES.push(`${note}${octave}`);
}

const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/backup.js',
  'js/platform.js',
  'js/db.js',
  'js/pdf.js',
  'js/piano.js',
  'js/pitch.js',
  'js/listen.js',
  'js/measure.js',
  'js/practice.js',
  'js/mp3-worker.js',
  'vendor/lamejs/lame.min.js',
  'js/recorder.js',
  'js/ui.js',
  'js/viewer.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdfjs/assets.js',
  // 글꼴을 포함하지 않은 PDF도 인터넷 없이 열리도록 글꼴 자료까지 저장합니다.
  ...self.PDFJS_ASSETS,
  ...PIANO_SAMPLES.map((name) => `audio/piano/${name}.mp3`),
];

self.addEventListener('install', (event) => {
  // 브라우저 캐시의 예전 파일이 새 버전에 섞이지 않도록 서버에서 직접 받습니다.
  const fresh = SHELL.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
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
