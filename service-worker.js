/*
 * service-worker.js — 離線快取（製作人Rui / Maker Rui）
 *
 * 策略：殼層檔案（HTML/CSS/JS/圖示/Chart.js）採 cache-first，
 *       讓 app 秒開、沒網路也能開啟。
 * 更新：改版時把下面的 CACHE_VERSION 加一，舊 cache 會在 activate 時清掉。
 *       頁面偵測到新版 waiting 會顯示「有新版本，點此更新」，
 *       使用者點下後送 SKIP_WAITING，新版接管並自動重新整理。
 *
 * 注意：API 資料「不」由這裡快取（改由 app 存 localStorage），
 *       避免把即時資料鎖在舊快取裡。
 */

const CACHE_VERSION = 'jz-app-v3';

// 要預先快取的殼層檔案（相對路徑，配合 GitHub Pages 子目錄部署）
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/api.js',
  './js/app.js',
  './js/charts.js',
  './lib/chart.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png'
];

// 安裝：把殼層檔案全部抓進快取
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    }).catch(function () {
      // 某個檔案抓不到也不擋安裝，避免整個 SW 掛掉
    })
  );
});

// 啟用：清掉不是這個版本的舊快取
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_VERSION) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 攔截請求：
//  - 只處理同源的 GET；跨網域（Apps Script API）一律放行走網路，不快取。
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 等外部請求不介入

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      // 快取沒有就走網路，順手存起來（例如新加的檔案）
      return fetch(req).then(function (resp) {
        // 只快取正常回應
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, clone); });
        }
        return resp;
      }).catch(function () {
        // 離線又沒快取：導覽請求就回首頁殼層
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});

// 收到頁面要求「馬上更新」時，跳過等待、立即接管
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
