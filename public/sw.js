/*
 * Minimal service worker: makes Mesa installable and shows an offline page.
 * It never caches API responses, tokens or audio — live media goes straight
 * to LiveKit over WebRTC.
 */
const OFFLINE_HTML = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mesa — offline</title>
<body style="font-family:system-ui;background:#0f0d0b;color:#f4efe8;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><h1 style="font-weight:400">You're offline</h1><p style="color:#bdb3a7">Mesa needs a connection to interpret live. It will reconnect when you're back online.</p></div></body>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // network only for everything else
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })),
  );
});
