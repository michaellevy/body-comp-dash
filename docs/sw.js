// The app moved to app/ with its own service worker. This one stays at the
// old path only so phones that registered it pick up a version that removes
// itself; a 404 here would also do it, but not on every browser promptly.
// It deletes no caches, because caches are shared across the origin and the
// new worker's live in them too.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.registration.unregister());
