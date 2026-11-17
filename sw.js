// 這個 service worker 只有兩個目的：
// 1. 讓瀏覽器把這個網站判定成「可安裝的應用程式（PWA）」，才能被設成 Windows 的預設 PDF 開啟程式。
// 2. 順便快取自己的檔案（HTML／JS／CSS／圖示），離線或網路不穩時也能照常打開使用。
// CDN 上的 pdf.js、pdf-lib 不快取在這裡，交給瀏覽器自己的 HTTP 快取機制處理就好。
const CACHE_NAME = "pdf-editor-v2";
const CORE_ASSETS = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 網路優先：有網路時一律拿最新版本（同時更新快取），只有離線或網路失敗時才退回快取版本，
// 這樣每次部署更新後，使用者只要重新整理就能看到最新內容，不會被舊快取卡住。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // CDN 資源交給瀏覽器自己處理
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
