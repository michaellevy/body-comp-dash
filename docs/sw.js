const CACHE = 'bodycomp-v13';
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
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
    // Always go to network for the GitHub API; cache-first for static assets.
    if (e.request.url.includes('api.github.com') || e.request.url.includes('gist.githubusercontent.com')) {
        e.respondWith(fetch(e.request));
    } else {
        e.respondWith(
            caches.match(e.request).then(r => r || fetch(e.request))
        );
    }
});
