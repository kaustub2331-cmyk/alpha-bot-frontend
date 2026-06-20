// ============================================================
// Alpha Bot — Service Worker (sw.js)
// Place in /public/sw.js so Vite serves it at root.
//
// Features:
//  • Cache-first strategy for static assets
//  • Network-first for API calls
//  • Background push notification handling
//  • notificationclick → focus/open the app tab
// ============================================================

const CACHE_NAME = "alpha-bot-v34";

// Assets to pre-cache on install
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ── Install ───────────────────────────────────────────────
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

// ── Activate ──────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-first for API calls and WebSocket upgrades
  if (
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("binance.com") ||
    url.hostname.includes("delta.exchange") ||
    url.pathname.startsWith("/api/")
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // Offline fallback: return cached index.html for navigation requests
        if (event.request.mode === "navigate") return caches.match("/index.html");
      });
    })
  );
});

// ── Push notifications ─────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "Alpha Bot";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    vibrate: data.vibrate || [100, 50, 100],
    data: data.data || {},
    tag: data.tag || "alpha-bot",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click → focus/open app ───────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tab = event.notification.data?.tab || "dashboard";
  const targetUrl = `${self.location.origin}?tab=${tab}`;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.focus();
          client.postMessage({ type: "NAVIGATE", tab });
          return;
        }
      }
      // Open new tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ── Message from app (skip waiting) ───────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
