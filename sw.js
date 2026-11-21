// Finance Tracker — service worker (offline-first PWA).
// APP SHELL (CORE, versioned with the app): cache-first + background refresh.
// Same-origin runtime files: same strategy. Cross-origin CDN libraries
// (PGlite, Supabase — only needed online anyway): stale-while-revalidate in a
// capped RUNTIME cache, so repeat visits keep working offline once loaded.
// Navigations fall back to the cached app shell when the network is gone.
const CACHE = "fintrack-v0.2.17";
const RUNTIME = "fintrack-runtime-v1";
const CORE = [
  "./", "./index.html", "./styles.css", "./app.js", "./db.js",
  "./pdf_import.js", "./sms_import.js", "./supabase_client.js",
  "./manifest.webmanifest", "./icon.svg",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
  "./VERSION", "./CHANGELOG.md",
  "./vendor/vue.esm-browser.js", "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs",
];
const RUNTIME_MAX = 60;

async function trimRuntime() {
  try {
    const c = await caches.open(RUNTIME);
    const keys = await c.keys();
    if (keys.length > RUNTIME_MAX) {
      for (const k of keys.slice(0, keys.length - RUNTIME_MAX)) await c.delete(k);
    }
  } catch {}
}

self.addEventListener("install", (e) => {
  // Cache each file independently: one 404 must not poison the whole shell.
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await Promise.all(CORE.map((u) => c.add(u).catch(() => null)));
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !url.protocol.startsWith("http")) return;
  // App navigation: network first, cached shell when offline.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", cp)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }
  // Same-origin app files: cache first, refresh in background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request).then((res) => {
          if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {}); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }
  // Cross-origin libraries: serve stale, refresh in background for next time.
  e.respondWith(
    caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((res) => {
        if (res && (res.ok || res.type === "opaque")) { c.put(e.request, res.clone()).catch(() => {}); trimRuntime(); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
