/*
 * service-worker.js — offline shell cache for the "22" PWA (Toggl edition).
 *
 * The data lives in Toggl Track, reached through an Apps Script Web App proxy
 * (toggl-store.js). This SW only caches the static shell for offline use and
 * lets proxy calls pass straight through to the network (the app cache-busts).
 *
 * Network-first for our own shell so a new deploy takes effect immediately;
 * falls back to cache only when offline.
 */
'use strict';

const CACHE = 'aligners-toggl-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './wear-core.js', './toggl-store.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch the Apps Script proxy calls — always straight to network.
  // (Apps Script /exec lives on script.google.com and redirects its response
  // body to script.googleusercontent.com; let both pass through untouched.)
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});

// Optional future push hook (no backend sends in v1).
self.addEventListener('push', (e) => {
  let data = { title: 'Aligners', body: 'Time to put your aligners back in.' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    tag: 'aligners-reinsert', renotify: true,
  }));
});
