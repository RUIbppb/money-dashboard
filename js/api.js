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
    lastFetch: 'jz_last_fetch'   // 上次成功抓取的毫秒時間戳（給 60 秒節流用）
  };

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

    return fetch(url, { method: 'GET', redirect: 'follow' })
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
        const base = (err && err.message) ? err.message : '連不上伺服器。';
        return {
          ok: false,
          message: cached ? ('連不上，顯示離線資料（' + base + '）') : ('連不上：' + base),
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

    return fetch(s.writeUrl, {
      method: 'POST',
      redirect: 'follow',
      // 故意不設 headers，維持簡單請求（text/plain）
      body: JSON.stringify(body)
    })
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
        const base = (err && err.message) ? err.message : '未知錯誤';
        return { ok: false, message: '送出失敗，連不上記帳伺服器（' + base + '）' };
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
