const CACHE = 'bodycomp-v30';
const ASSETS = [
    './',
    './index.html',
    './css/style.css',
    './js/db.js',
    './js/tape.js',
    './js/calibration.js',
    './js/charts.js',
    './js/app.js',
    './icon-192.png',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    // Always go to network for the GitHub API. Static assets are network-first
    // too, falling back to the cache only offline: cache-first served the old
    // code on every load after a deploy, and the new worker's cache never got
    // a page to hand its files to.
    if (e.request.url.includes('api.github.com') || e.request.url.includes('gist.githubusercontent.com')) {
        e.respondWith(fetch(e.request));
    } else {
        e.respondWith(
            fetch(e.request, { cache: 'no-cache' })
                .then(r => {
                    if (r.ok && e.request.method === 'GET') {
                        const copy = r.clone();
                        caches.open(CACHE).then(c => c.put(e.request, copy));
                    }
                    return r;
                })
                .catch(() => caches.match(e.request))
        );
    }
});
