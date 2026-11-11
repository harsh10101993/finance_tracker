// Finance Tracker v0.1.0 — service worker (offline app shell).
// NOTE: register from app.js. Works on GitHub Pages / any static host.
const CACHE = "fintrack-v0.2.1";
const CORE = ["./", "./index.html", "./styles.css", "./app.js", "./db.js", "./pdf_import.js", "./supabase_client.js", "./manifest.webmanifest", "./icon.svg", "./VERSION", "./CHANGELOG.md"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !url.protocol.startsWith("http")) return;
  if (url.origin !== self.location.origin) return; // cache same-origin only; CDN stays network
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {}); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
