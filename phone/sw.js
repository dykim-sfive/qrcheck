// 네트워크 우선(배포 즉시 반영), 실패하거나 느리면(4초) 캐시. 정상 응답(ok)만 캐시한다.
// 배포할 때마다 CACHE 이름을 올리면 새로 미리 받아 둔다.
const CACHE = "qr-receiver-v4";
const NET_TIMEOUT_MS = 4000;
const PRECACHE = [
  "./", "index.html", "record.html", "style.css", "manifest.webmanifest",
  "src/app.js", "src/record-app.js", "src/file-scanner.js", "src/record-model.js", "src/ui-shared.js", "src/scanner.js", "src/worker.js", "src/zxing-read.js", "src/gate.js",
  "src/decoder.js", "src/mt.js", "src/base45.js", "src/crc.js", "src/ui-model.js",
  "vendor/zxing-wasm/reader/index.js", "vendor/zxing-wasm/share.js", "vendor/zxing-wasm/zxing_reader.wasm",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
      if (!cached) return net;
      // 캐시가 있으면 네트워크를 4초만 기다린다 (약한 신호에서 앱이 멈추지 않게)
      const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NET_TIMEOUT_MS));
      return Promise.race([net.catch(() => cached), timeout]).then((r) => (r && r.ok ? r : cached));
    })(),
  );
});
