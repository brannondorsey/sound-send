// Offline support (network first, cache fallback) and the Android share
// target, which stashes whatever was shared for the page to pick up.
const CACHE = 'ss-v4';
const ASSETS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/audio.js', 'js/capture-worklet.js', 'js/crc.js', 'js/dsp-worker.js',
  'js/fft.js', 'js/link.js', 'js/message.js', 'js/modem.js', 'js/rs.js', 'js/viz.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'ss-share').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(stashShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

async function stashShare(req) {
  const form = await req.formData();
  const files = form.getAll('file').filter((f) => typeof f === 'object' && f.size);
  const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter(Boolean).join('\n');
  const cache = await caches.open('ss-share');
  if (files[0]) await cache.put('file-0', new Response(files[0]));
  await cache.put('meta', new Response(JSON.stringify({ text, files: files.slice(0, 1).map((f) => ({ name: f.name, type: f.type })) })));
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}
