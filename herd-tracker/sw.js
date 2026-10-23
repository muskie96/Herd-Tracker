/* Herd Tracker service worker: lets the app open with no signal.
   App files: try the network first (so updates show up), fall back to the saved copy.
   Bump VERSION when you change the list of files below. */
var VERSION = 'herd-v1';
var FONTS = 'herd-fonts';
var SHELL = [
  './', './index.html', './app.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== FONTS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return new Promise(function (resolve) {
    var done = false;
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        return r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined);
      });
    }
    // Weak signal: if the network takes more than 4s, use the saved copy.
    var timer = setTimeout(function () {
      fromCache().then(function (r) { if (r && !done) { done = true; resolve(r); } });
    }, 4000);
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (r) {
        if (!done) { done = true; resolve(r || new Response('Offline', { status: 503 })); }
      });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(FONTS).then(function (c) { c.put(req, copy); });
        return res;
      });
    }));
  }
});
