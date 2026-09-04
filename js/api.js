/*
 * api.js — 資料存取層（製作人Rui / Maker Rui）
 * 全 app 只有這支檔案會發網路請求。其他檔案要資料一律呼叫這裡的函式。
 *
 * 設計原則：
 *  - 網址與密語「絕不寫死」，一律從 localStorage 讀（使用者在設定頁輸入）。
 *  - 讀到的資料整包存進 localStorage 當離線快取，抓不到時退回舊資料。
 *  - 對外只回傳單純的資料物件與清楚的錯誤，畫面邏輯不用碰 fetch 細節。
 */

const JZ = (function () {
  'use strict';

  // localStorage 的鍵名，統一集中管理
  const KEY = {
    readUrl: 'jz_read_url',      // 查詢 API 網址
    readToken: 'jz_read_token',  // 唯讀密語
    writeUrl: 'jz_write_url',    // 記帳 API 網址
    writeToken: 'jz_write_token', // 寫入密語
    cache: 'jz_data_cache',      // 上次成功抓回的整包資料
    lastFetch: 'jz_last_fetch',  // 上次成功抓取的毫秒時間戳（給 60 秒節流用）
    theme: 'jz_theme',           // 深淺色偏好：auto（跟隨手機）／light／dark
    recentItems: 'jz_recent_items' // 這支手機上最近按過送出的項目（常用項目的備援）
  };

  // ---------- 最近用過的項目 ----------
  // 「常用項目」按鈕的主要來源是流水帳統計（因為大部分的帳是用 iPhone 捷徑記的，
  // 不會經過這個 App）。這裡記的只是備援，資料還沒抓回來時先頂著用。

  function getRecentItems() {
    try {
      const raw = localStorage.getItem(KEY.recentItems);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function pushRecentItem(name) {
    const item = String(name || '').trim();
    if (!item) return;
    try {
      let arr = getRecentItems().filter(function (x) { return x !== item; });
      arr.unshift(item);
      if (arr.length > 10) arr = arr.slice(0, 10);
      localStorage.setItem(KEY.recentItems, JSON.stringify(arr));
    } catch (e) {
      // 存不進去不影響記帳，安靜略過
    }
  }

  // ---------- 深淺色主題 ----------
  // 注意：index.html 開頭那段小程式也會讀 'jz_theme'，
  // 因為開頁的瞬間就要決定顏色，等不到這支檔案載入。兩邊的鍵名要一致。

  function getTheme() {
    try {
      return localStorage.getItem(KEY.theme) || 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  function saveTheme(pref) {
    try {
      localStorage.setItem(KEY.theme, pref);
    } catch (e) {
      // 無痕模式之類存不進去也沒關係，這次還是會生效，只是下次打開會回到跟隨手機
    }
  }

  // 依照偏好與手機當下的設定，算出「現在到底該用暗色嗎」
  function shouldUseDark(pref) {
    const p = pref || getTheme();
    if (p === 'dark') return true;
    if (p === 'light') return false;
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  // ---------- 設定的讀寫 ----------

  function getSettings() {
    return {
      readUrl: (localStorage.getItem(KEY.readUrl) || '').trim(),
      readToken: (localStorage.getItem(KEY.readToken) || '').trim(),
      writeUrl: (localStorage.getItem(KEY.writeUrl) || '').trim(),
      writeToken: (localStorage.getItem(KEY.writeToken) || '').trim()
    };
  }

  function saveSettings(s) {
    localStorage.setItem(KEY.readUrl, (s.readUrl || '').trim());
    localStorage.setItem(KEY.readToken, (s.readToken || '').trim());
    localStorage.setItem(KEY.writeUrl, (s.writeUrl || '').trim());
    localStorage.setItem(KEY.writeToken, (s.writeToken || '').trim());
  }

  // 有沒有填「查詢」需要的兩個欄位
  function hasReadConfig() {
    const s = getSettings();
    return !!(s.readUrl && s.readToken);
  }

  // 有沒有填「記帳」需要的兩個欄位
  function hasWriteConfig() {
    const s = getSettings();
    return !!(s.writeUrl && s.writeToken);
  }

  // ---------- 離線快取 ----------

  function getCachedData() {
    try {
      const raw = localStorage.getItem(KEY.cache);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveCachedData(data) {
    try {
      localStorage.setItem(KEY.cache, JSON.stringify(data));
    } catch (e) {
      // 空間不足等狀況就算了，不影響畫面
    }
  }

  function getLastFetchMs() {
    const v = parseInt(localStorage.getItem(KEY.lastFetch) || '0', 10);
    return isNaN(v) ? 0 : v;
  }

  // 距離上次成功抓取還要等幾秒（0 代表現在可以抓）
  function secondsUntilCanRefresh(minGapSec) {
    const gap = (minGapSec || 60) * 1000;
    const remain = getLastFetchMs() + gap - Date.now();
    return remain > 0 ? Math.ceil(remain / 1000) : 0;
  }

  // ---------- 連線逾時 ----------

  const READ_TIMEOUT_MS = 15000;   // 讀資料最多等 15 秒
  const WRITE_TIMEOUT_MS = 25000;  // 送記帳最多等 25 秒
  // 為什麼寫入要等比較久？因為 Apps Script 很久沒用時第一次呼叫要「暖機」好幾秒，
  // 設太短會把「其實成功了、只是慢」誤判成失敗，那很容易害人重複記帳。

  /*
   * 包一層逾時的 fetch：訊號不好時不要無限期轉圈，要給使用者一個交代。
   * ⚠️ 這裡用 AbortController（Safari 12.1 以上都支援）。
   *    不要改用 AbortSignal.timeout()，那個要 Safari 16 以上，舊 iPhone 會直接出錯。
   */
  function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ms);
    const opts = Object.assign({}, options, { signal: ctrl.signal });
    return fetch(url, opts).then(function (resp) {
      clearTimeout(timer);
      return resp;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  // 逾時被觸發時丟出來的錯誤叫 AbortError
  function isTimeoutError(err) {
    return !!(err && err.name === 'AbortError');
  }

  /*
   * 把瀏覽器丟出來的英文技術錯誤，翻成使用者看得懂的白話。
   * 例如 fetch 連不上時會丟「Failed to fetch」，直接顯示給使用者是沒有意義的。
   */
  function friendlyNetError(err, seconds) {
    if (isTimeoutError(err)) {
      return '等太久了（超過 ' + seconds + ' 秒），可能訊號不好或伺服器忙碌';
    }
    const raw = (err && err.message) ? String(err.message) : '';
    if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(raw)) {
      return '連不上伺服器。請檢查網路是否正常，或到設定頁確認網址有沒有貼錯';
    }
    // 我們自己丟的錯誤本來就是中文，直接用
    if (raw) return raw;
    return '連不上伺服器';
  }

  // ---------- 抓資料（查詢 API） ----------

  /*
   * 抓全部資料。回傳一個 Promise，結果格式：
   *   { ok: true, data: {...}, fromCache: false }
   *   { ok: false, message: '白話錯誤', data: 快取或 null, fromCache: true/false }
   */
  function fetchAll() {
    const s = getSettings();

    if (!s.readUrl || !s.readToken) {
      return Promise.resolve({
        ok: false,
        message: '還沒設定查詢連線，請先到設定頁填寫。',
        data: getCachedData(),
        fromCache: !!getCachedData()
      });
    }

    // 組網址：token 與 action 都做編碼避免特殊字元出錯
    const url = s.readUrl +
      (s.readUrl.indexOf('?') >= 0 ? '&' : '?') +
      'token=' + encodeURIComponent(s.readToken) +
      '&action=all';

    return fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, READ_TIMEOUT_MS)
      .then(function (resp) {
        return resp.text().then(function (text) {
          // 先確認 HTTP 狀態
          if (!resp.ok) {
            throw new Error('伺服器回應狀態 ' + resp.status);
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            throw new Error('回傳的不是預期的資料格式（可能網址貼錯或部署有問題）。');
          }
          return json;
        });
      })
      .then(function (json) {
        if (json.status === 'success') {
          saveCachedData(json);
          localStorage.setItem(KEY.lastFetch, String(Date.now()));
          return { ok: true, data: json, fromCache: false };
        }
        // 後端回報的錯誤（密語錯誤、分頁被改名等）
        const msg = json.message || '查詢發生未知錯誤。';
        return { ok: false, message: msg, data: getCachedData(), fromCache: !!getCachedData() };
      })
      .catch(function (err) {
        // 網路層失敗：連不上、逾時、CORS 等
        const cached = getCachedData();
        const base = friendlyNetError(err, READ_TIMEOUT_MS / 1000);
        return {
          ok: false,
          message: cached ? (base + '，先顯示上次抓到的資料。') : (base + '。'),
          data: cached,
          fromCache: !!cached
        };
      });
  }

  // ---------- 送出記帳（寫入 API） ----------

  /*
   * 送出一筆記帳或轉帳。payload 由 app.js 準備好，這裡只負責送。
   * 一般記帳：{ item, amount, category, account, note }
   * 轉帳：    { item, amount, account, note, to_account }（category 可省略）
   * 回傳：{ ok: true, message } 或 { ok: false, message }
   *
   * ★技術重點：body 是 JSON 字串，但「不設 Content-Type」，
   *   讓它維持 text/plain 的簡單請求，避免瀏覽器 CORS 預檢被 Apps Script 擋掉。
   */
  function submitEntry(payload) {
    const s = getSettings();

    if (!s.writeUrl || !s.writeToken) {
      return Promise.resolve({
        ok: false,
        message: '還沒設定記帳連線，請先到設定頁填寫記帳 API 網址與寫入密語。'
      });
    }

    const body = Object.assign({ token: s.writeToken }, payload);

    return fetchWithTimeout(s.writeUrl, {
      method: 'POST',
      redirect: 'follow',
      // 故意不設 headers，維持簡單請求（text/plain）
      body: JSON.stringify(body)
    }, WRITE_TIMEOUT_MS)
      .then(function (resp) {
        return resp.text().then(function (text) {
          if (!resp.ok) {
            throw new Error('伺服器回應狀態 ' + resp.status);
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            // 契約規定寫入 API 一定回 JSON；解析不了代表打錯網址或伺服器異常，一律視為失敗
            return { status: 'error', message: '伺服器回應格式異常，請到設定頁確認記帳 API 網址是否正確。' };
          }
          return json;
        });
      })
      .then(function (json) {
        const okStatus = (json.status === 'success');
        return {
          ok: !!okStatus,
          message: json.message || (okStatus ? '記帳成功' : '記帳失敗')
        };
      })
      .catch(function (err) {
        /*
         * ⚠️ 逾時「不等於失敗」。
         * 很可能伺服器其實已經寫進去了，只是回應塞在路上。
         * 這裡的訊息絕對不能寫「失敗」，不然使用者會再按一次，
         * 試算表就會出現兩筆一模一樣的帳。
         */
        if (isTimeoutError(err)) {
          return {
            ok: false,
            timeout: true,
            message: '等太久沒有回應。這筆帳有可能已經記進去了，請先到「明細」確認，不要直接重送。'
          };
        }
        return { ok: false, message: '沒送出去。' + friendlyNetError(err, WRITE_TIMEOUT_MS / 1000) + '。' };
      });
  }

  // ---------- 測試連線 ----------

  // 打一次查詢 API，回傳 { ok, message }
  function testRead() {
    return fetchAll().then(function (res) {
      if (res.ok) {
        const n = (res.data && res.data.accounts) ? res.data.accounts.length : 0;
        return { ok: true, message: '連線成功，讀到 ' + n + ' 個帳戶。' };
      }
      return { ok: false, message: res.message || '連線失敗' };
    });
  }

  // 對外公開的介面
  return {
    KEY: KEY,
    getTheme: getTheme,
    getRecentItems: getRecentItems,
    pushRecentItem: pushRecentItem,
    saveTheme: saveTheme,
    shouldUseDark: shouldUseDark,
    getSettings: getSettings,
    saveSettings: saveSettings,
    hasReadConfig: hasReadConfig,
    hasWriteConfig: hasWriteConfig,
    getCachedData: getCachedData,
    secondsUntilCanRefresh: secondsUntilCanRefresh,
    fetchAll: fetchAll,
    submitEntry: submitEntry,
    testRead: testRead
  };
})();
