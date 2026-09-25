/*
 * service-worker.js — 離線快取（製作人Rui / Maker Rui）
 *
 * 這支檔案的角色是「倉庫管理員」：決定哪些檔案要存下來離線用、什麼時候清掉。
 *
 * 策略：殼層檔案（HTML/CSS/JS/圖示/Chart.js）採 cache-first，
 *       讓 app 秒開、沒網路也能開啟。
 *
 * ============================================================
 * ★★ 改版檢查清單：每次改前端，上線前一定要檢查這 4 件事 ★★
 *   1. js/app.js 的 APP_VERSION 有沒有跳號
 *   2. index.html 裡顯示的版本號有沒有跟著跳
 *   3. 這支檔案下面的 CACHE_VERSION 有沒有 +1   ← 漏掉這個，手機不會更新！
 *   4. 有沒有新增 js/css 檔案要加進 SHELL_FILES ← 漏掉這個，離線會打不開！
 *
 * 白話比喻：CACHE_VERSION 像「倉庫的批號」。批號一變，管理員才會去把整批貨換新。
 *          批號沒變，程式改到天荒地老，手機都還是拿舊貨。
 * ============================================================
 *
 * 更新流程：頁面偵測到新版 waiting 會顯示「有新版本，點此更新」，
 *          使用者點下後送 SKIP_WAITING，新版接管並自動重新整理。
 *
 * 注意：API 資料「不」由這裡快取（改由 app 存 localStorage），
 *       避免把即時資料鎖在舊快取裡。
 */

const CACHE_VERSION = 'jz-app-v15';   // 每次改版都要 +1
const OCR_CACHE = 'jz-ocr-v1';       // 只放截圖辨識引擎，刻意「不」隨改版清除

// 這兩個倉庫要留著，其他一律清掉
const KEEP_CACHES = [CACHE_VERSION, OCR_CACHE];

// 要預先快取的殼層檔案（相對路徑，配合 GitHub Pages 子目錄部署）
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/pure.js',
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
      // 用 {cache:'reload'} 強制略過瀏覽器自己的 HTTP 快取，直接跟伺服器要最新檔案，
      // 不然改版後 SW 換了新版本號，抓進來的殼層檔案卻可能還是瀏覽器快取住的舊內容
      return Promise.all(SHELL_FILES.map(function (url) {
        return fetch(url, { cache: 'reload' }).then(function (resp) {
          return cache.put(url, resp);
        });
      }));
    }).catch(function () {
      // 某個檔案抓不到也不擋安裝，避免整個 SW 掛掉
    })
  );
});

// 啟用：清掉不在保留名單裡的舊快取
// （用白名單陣列而不是一連串 if，比較不會寫錯而誤刪）
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (KEEP_CACHES.indexOf(key) < 0) return caches.delete(key);
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

  /*
   * 截圖辨識引擎那幾個檔案（合計約 11 MB）改存到「永不隨改版清除」的倉庫，
   * 這樣以後每次改版都不用重新下載一次。
   *
   * ⚠️ 這是整支程式最需要小心的一行 ⚠️
   * 這個判斷一定要寫得夠嚴格。萬一把一般程式檔（app.js、style.css）也塞進來，
   * 那些檔案就會永遠卡在舊版清不掉，手機從此更新不了。
   * 前面那個斜線不要拿掉，才不會誤中名字類似的路徑。
   */
  const isOcrFile = url.pathname.indexOf('/lib/tesseract/') >= 0;
  const targetCache = isOcrFile ? OCR_CACHE : CACHE_VERSION;

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      // 快取沒有就走網路，順手存起來（例如新加的檔案）
      return fetch(req).then(function (resp) {
        // 只快取正常回應
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(targetCache).then(function (cache) { cache.put(req, clone); });
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
