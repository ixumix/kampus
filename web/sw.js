// Service worker «Кампуса»: приложение открывается без сети, а открытые данные видны с пометкой времени.
// Стратегия везде «сначала сеть»: онлайн всегда свежие данные и код; кэш — только запасной вариант.
// Изменяющие запросы не кэшируются и без сети честно падают. Скачивания (.ics, .csv, справки) — только сеть.
const VERSION = "kampus-v3";
const SHELL = "kampus-shell-" + VERSION;
const API = "kampus-api"; // стирается при входе и выходе (данные одного аккаунта)

// Какие ответы API можно показать офлайн: только чтение, только экраны кабинета.
const API_ALLOW = [/^\/api\/session$/, /^\/api\/today$/, /^\/api\/schedule$/, /^\/api\/lessons\/\d+$/,
  /^\/api\/summary(\/week)?$/, /^\/api\/grades$/, /^\/api\/subjects\/\d+$/, /^\/api\/requests(\/\d+)?$/,
  /^\/api\/notifications$/, /^\/api\/calendar$/];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const res = await fetch("/asset-manifest.json", { cache: "no-store" });
    const { files } = await res.json();
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("kampus-shell-") && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheName, { stampSaved } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) {
      if (stampSaved) {
        // Запоминаем, когда ответ сохранён, чтобы офлайн честно показать «данные от …».
        const body = await res.clone().arrayBuffer();
        const headers = new Headers(res.headers);
        headers.set("X-Kampus-Saved-At", new Date().toISOString());
        await cache.put(request, new Response(body, { status: res.status, statusText: res.statusText, headers }));
      } else {
        await cache.put(request, res.clone());
      }
    }
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (!hit) throw err;
    if (!stampSaved) return hit;
    const headers = new Headers(hit.headers);
    headers.set("X-Kampus-Saved", hit.headers.get("X-Kampus-Saved-At") || "");
    return new Response(await hit.arrayBuffer(), { status: hit.status, headers });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/cal/") || url.pathname === "/sw.js" || url.pathname === "/asset-manifest.json") return;
  if (/\.(ics|csv)$/.test(url.pathname) || /\/document$/.test(url.pathname) || url.pathname.startsWith("/api/dev")) return;

  if (url.pathname.startsWith("/api/")) {
    if (API_ALLOW.some((re) => re.test(url.pathname))) event.respondWith(networkFirst(req, API, { stampSaved: true }));
    return; // остальные запросы API — только сеть
  }
  if (req.mode === "navigate") {
    // Любой адрес приложения — это index.html; без сети отдаём сохранённую оболочку.
    event.respondWith(fetch(req).catch(async () => (await caches.open(SHELL)).match("/index.html")));
    return;
  }
  event.respondWith(networkFirst(req, SHELL));
});
