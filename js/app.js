/*
 * app.js — 畫面邏輯（製作人Rui / Maker Rui）
 * 負責分頁切換、把資料畫到畫面上、記帳表單、設定頁。
 * 所有網路請求都交給 api.js（JZ），這裡不直接碰 fetch。
 */

(function () {
  'use strict';

  const APP_VERSION = 'v1.0';

  // 記帳分類清單（一般記帳用）
  const RECORD_CATEGORIES = ['食', '玩樂', '交通', '寵物', '貸款', '其他', '警察收入', '其他收入', '股票收入'];
  // 支出分類（圓餅圖與明細篩選用）
  const EXPENSE_CATEGORIES = ['食', '玩樂', '交通', '寵物', '貸款', '其他'];

  // 整個 app 的狀態
  const state = {
    data: null,       // 目前畫面用的資料（可能來自快取）
    fromCache: false  // 目前顯示的是不是離線快取
  };

  // ---------- 小工具 ----------

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // 金額千分位（整數顯示，四捨五入到元）
  function money(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString('zh-TW');
  }

  // 台北時間的當月字串 yyyy-MM
  function taipeiCurrentMonth() {
    // en-CA 會給 yyyy-MM-dd，指定時區確保永遠用台北時間判斷
    const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    return s.slice(0, 7);
  }

  // 把 ISO 時間字串轉成 MM/DD HH:mm（字串本身已是台北時間，直接取用）
  function fmtDateTime(iso) {
    if (!iso || iso.length < 16) return iso || '';
    // 2026-07-14T19:51:35+08:00 -> 07/14 19:51
    const d = iso.slice(5, 10).replace('-', '/');
    const t = iso.slice(11, 16);
    return d + ' ' + t;
  }

  // 交易的月份字串（time 已是台北時間，取前 7 碼即可）
  function txMonth(iso) {
    return (iso || '').slice(0, 7);
  }

  // ---------- 分頁切換 ----------

  function switchTab(name) {
    $all('.tab-section').forEach(function (sec) {
      sec.classList.toggle('active', sec.id === 'tab-' + name);
    });
    $all('.nav-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    });
    // 圖表分頁被打開時才畫圖（canvas 要先可見才量得到尺寸）
    if (name === 'charts') renderCharts();
    // 捲回頂端
    const main = $('#main');
    if (main) main.scrollTop = 0;
  }

  // ---------- 離線／資料時間提示 ----------

  function renderDataTimeBanner() {
    const banner = $('#offline-banner');
    const timeText = $('#data-time');
    const gen = state.data && state.data.generated_at ? fmtDateTime(state.data.generated_at) : '—';

    if (timeText) timeText.textContent = gen;

    if (banner) {
      if (state.fromCache) {
        banner.textContent = '目前顯示 ' + gen + ' 的離線資料';
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    }
  }

  // ---------- 總覽頁 ----------

  function renderOverview() {
    const d = state.data;
    const totalEl = $('#total-asset');
    const accList = $('#account-list');
    const tagWrap = $('#tag-section');
    const tagList = $('#tag-list');

    if (!d) {
      if (totalEl) totalEl.textContent = '—';
      if (accList) accList.innerHTML = '<div class="empty-hint">尚無資料，請先到設定頁連線。</div>';
      if (tagWrap) tagWrap.style.display = 'none';
      return;
    }

    // 總資產 = 所有帳戶餘額加總
    const accounts = d.accounts || [];
    let total = 0;
    accounts.forEach(function (a) { total += Number(a.balance) || 0; });
    if (totalEl) {
      totalEl.textContent = money(total);
      totalEl.classList.toggle('neg', total < 0);
    }

    // 本月收入／支出／淨流動：從 transactions 算當月
    const cm = taipeiCurrentMonth();
    let income = 0, expense = 0;
    (d.transactions || []).forEach(function (t) {
      if (txMonth(t.time) !== cm) return;
      if (t.type === '收入') income += Number(t.amount) || 0;
      else if (t.type === '支出') expense += Number(t.amount) || 0;
    });
    const net = income - expense;

    const inEl = $('#month-income');
    const outEl = $('#month-expense');
    const netEl = $('#month-net');
    if (inEl) inEl.textContent = money(income);
    if (outEl) outEl.textContent = money(expense);
    if (netEl) {
      netEl.textContent = (net < 0 ? '' : '+') + money(net);
      netEl.classList.toggle('neg', net < 0);
    }

    // 帳戶清單
    if (accList) {
      if (accounts.length === 0) {
        accList.innerHTML = '<div class="empty-hint">沒有帳戶資料。</div>';
      } else {
        accList.innerHTML = accounts.map(function (a) {
          const bal = Number(a.balance) || 0;
          const cls = bal < 0 ? ' neg' : '';
          return '<div class="row">' +
            '<span class="row-name">' + escapeHtml(a.name) + '</span>' +
            '<span class="row-val' + cls + '">' + money(bal) + '</span>' +
            '</div>';
        }).join('');
      }
    }

    // 專案標籤
    const tags = d.tags || [];
    if (tagWrap && tagList) {
      if (tags.length === 0) {
        tagWrap.style.display = 'none';
      } else {
        tagWrap.style.display = 'block';
        tagList.innerHTML = tags.map(function (t) {
          return '<div class="row">' +
            '<span class="row-name tag-name">' + escapeHtml(t.tag) + '</span>' +
            '<span class="row-val">' + money(t.total) + '</span>' +
            '</div>';
        }).join('');
      }
    }
  }

  // ---------- 圖表頁 ----------

  function renderCharts() {
    const d = state.data;
    if (!d || !window.JZCharts) return;

    // 本月支出分類彙總
    const cm = taipeiCurrentMonth();
    const catTotals = {};
    (d.transactions || []).forEach(function (t) {
      if (t.type !== '支出') return;
      if (txMonth(t.time) !== cm) return;
      const cat = EXPENSE_CATEGORIES.indexOf(t.category) >= 0 ? t.category : '其他';
      catTotals[cat] = (catTotals[cat] || 0) + (Number(t.amount) || 0);
    });

    JZCharts.drawCategoryPie('chart-pie', catTotals);
    JZCharts.drawAssetLine('chart-line', d.monthly || []);
    JZCharts.drawMonthlyBar('chart-bar', d.monthly || []);
  }

  // ---------- 明細頁 ----------

  function initDetailFilters() {
    const d = state.data;
    const monthSel = $('#detail-month');
    const catSel = $('#detail-cat');
    if (!monthSel || !catSel) return;

    // 月份下拉：從交易有的月份產生（新到舊）
    const months = [];
    (d ? d.transactions || [] : []).forEach(function (t) {
      const m = txMonth(t.time);
      if (m && months.indexOf(m) < 0) months.push(m);
    });
    months.sort().reverse();

    const cm = taipeiCurrentMonth();
    let monthOpts = '<option value="__all">全部月份</option>';
    months.forEach(function (m) {
      monthOpts += '<option value="' + m + '">' + m + '</option>';
    });
    monthSel.innerHTML = monthOpts;
    // 預設選本月；若本月沒資料就選第一個有的月份
    if (months.indexOf(cm) >= 0) monthSel.value = cm;
    else if (months.length > 0) monthSel.value = months[0];
    else monthSel.value = '__all';

    // 分類下拉
    const cats = ['食', '玩樂', '交通', '寵物', '貸款', '其他', '警察收入', '其他收入', '股票收入'];
    let catOpts = '<option value="__all">全部分類</option>';
    cats.forEach(function (c) { catOpts += '<option value="' + c + '">' + c + '</option>'; });
    catSel.innerHTML = catOpts;
    catSel.value = '__all';
  }

  function renderDetailList() {
    const d = state.data;
    const listEl = $('#detail-list');
    if (!listEl) return;

    if (!d) {
      listEl.innerHTML = '<div class="empty-hint">尚無資料。</div>';
      return;
    }

    const month = ($('#detail-month') || {}).value || '__all';
    const cat = ($('#detail-cat') || {}).value || '__all';
    const kw = (($('#detail-kw') || {}).value || '').trim().toLowerCase();

    const rows = (d.transactions || []).filter(function (t) {
      if (month !== '__all' && txMonth(t.time) !== month) return false;
      if (cat !== '__all' && t.category !== cat) return false;
      if (kw) {
        const hay = ((t.item || '') + ' ' + (t.note || '')).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });

    if (rows.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">沒有符合條件的紀錄。</div>';
      return;
    }

    listEl.innerHTML = rows.map(function (t) {
      const amt = Number(t.amount) || 0;
      let sign = '', cls = '';
      if (t.type === '支出') { sign = '−'; cls = 'amt-out'; }
      else if (t.type === '收入') { sign = '+'; cls = 'amt-in'; }
      else { sign = ''; cls = 'amt-transfer'; } // 轉入／轉出用灰色

      const noteHtml = t.note ? '<div class="tx-note">' + escapeHtml(t.note) + '</div>' : '';

      return '<div class="tx">' +
        '<div class="tx-top">' +
          '<span class="tx-item">' + escapeHtml(t.item || '') + '</span>' +
          '<span class="tx-amt ' + cls + '">' + sign + money(amt) + '</span>' +
        '</div>' +
        '<div class="tx-sub">' +
          '<span>' + fmtDateTime(t.time) + '</span>' +
          '<span class="tx-tags">' + escapeHtml(t.category || '') + ' · ' + escapeHtml(t.account || '') + '　<em>' + escapeHtml(t.type || '') + '</em></span>' +
        '</div>' +
        noteHtml +
        '</div>';
    }).join('');
  }

  // ---------- 記帳頁 ----------

  function refreshRecordAccounts() {
    // 依 API 帳戶名單動態產生下拉選項
    const d = state.data;
    const names = (d && d.accounts) ? d.accounts.map(function (a) { return a.name; }) : [];

    const gate = $('#record-gate');
    const forms = $('#record-forms');

    if (!JZ.hasWriteConfig()) {
      if (gate) { gate.style.display = 'block'; gate.textContent = '請先到設定頁填寫記帳連線（記帳 API 網址與寫入密語），才能使用記帳功能。'; }
      if (forms) forms.style.display = 'none';
      return;
    }
    if (gate) gate.style.display = 'none';
    if (forms) forms.style.display = 'block';

    const selectors = ['#r-account', '#t-from', '#t-to'];
    selectors.forEach(function (sel) {
      const el = $(sel);
      if (!el) return;
      const keep = el.value;
      if (names.length === 0) {
        el.innerHTML = '<option value="">（尚無帳戶名單，請先在設定頁測試連線）</option>';
      } else {
        el.innerHTML = names.map(function (n) {
          return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
        }).join('');
        if (keep && names.indexOf(keep) >= 0) el.value = keep;
      }
    });
  }

  function initRecordForm() {
    // 分類下拉
    const catSel = $('#r-category');
    if (catSel) {
      catSel.innerHTML = RECORD_CATEGORIES.map(function (c) {
        return '<option value="' + c + '">' + c + '</option>';
      }).join('');
    }

    // 模式切換（一般記帳 / 轉帳）
    $all('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mode = btn.getAttribute('data-mode');
        $all('.mode-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
        $('#form-normal').style.display = (mode === 'normal') ? 'block' : 'none';
        $('#form-transfer').style.display = (mode === 'transfer') ? 'block' : 'none';
        setRecordMsg('', '');
      });
    });

    // 一般記帳送出
    const normalBtn = $('#r-submit');
    if (normalBtn) normalBtn.addEventListener('click', submitNormal);

    // 轉帳送出
    const transferBtn = $('#t-submit');
    if (transferBtn) transferBtn.addEventListener('click', submitTransfer);
  }

  function setRecordMsg(text, kind) {
    const el = $('#record-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'record-msg' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  function submitNormal() {
    const amount = parseFloat(($('#r-amount') || {}).value);
    const item = (($('#r-item') || {}).value || '').trim();
    const category = ($('#r-category') || {}).value || '';
    const account = ($('#r-account') || {}).value || '';
    const note = (($('#r-note') || {}).value || '').trim();

    if (!(amount > 0)) { setRecordMsg('金額要大於 0 才能送出。', 'err'); return; }
    if (!item) { setRecordMsg('請填寫項目名稱。', 'err'); return; }
    if (!account) { setRecordMsg('請選擇支付帳戶。', 'err'); return; }

    const btn = $('#r-submit');
    lockBtn(btn, true, '送出中…');
    setRecordMsg('送出中…', '');

    JZ.submitEntry({ item: item, amount: amount, category: category, account: account, note: note })
      .then(function (res) {
        lockBtn(btn, false, '送出記帳');
        setRecordMsg(res.message, res.ok ? 'ok' : 'err');
        if (res.ok) {
          $('#r-amount').value = '';
          $('#r-item').value = '';
          $('#r-note').value = '';
          reloadAfterWrite();
        }
      });
  }

  function submitTransfer() {
    const amount = parseFloat(($('#t-amount') || {}).value);
    const item = (($('#t-item') || {}).value || '').trim() || '資金調度';
    const from = ($('#t-from') || {}).value || '';
    const to = ($('#t-to') || {}).value || '';
    const note = (($('#t-note') || {}).value || '').trim();

    if (!(amount > 0)) { setRecordMsg('金額要大於 0 才能送出。', 'err'); return; }
    if (!from || !to) { setRecordMsg('請選擇轉出與轉入帳戶。', 'err'); return; }
    if (from === to) { setRecordMsg('轉出與轉入帳戶不能相同。', 'err'); return; }

    const btn = $('#t-submit');
    lockBtn(btn, true, '送出中…');
    setRecordMsg('送出中…', '');

    // category 一定要帶非空值，伺服器第一道檢查會擋空欄位（實際會被自動記成轉出/轉入）
    JZ.submitEntry({ item: item, amount: amount, category: '轉帳', account: from, to_account: to, note: note })
      .then(function (res) {
        lockBtn(btn, false, '送出轉帳');
        setRecordMsg(res.message, res.ok ? 'ok' : 'err');
        if (res.ok) {
          $('#t-amount').value = '';
          reloadAfterWrite();
        }
      });
  }

  function lockBtn(btn, locked, text) {
    if (!btn) return;
    btn.disabled = locked;
    if (text) btn.textContent = text;
  }

  // 記帳成功後重新抓資料（略過 60 秒節流，因為是使用者主動記帳）
  function reloadAfterWrite() {
    loadData(true);
  }

  // ---------- 設定頁 ----------

  function loadSettingsIntoForm() {
    const s = JZ.getSettings();
    if ($('#set-read-url')) $('#set-read-url').value = s.readUrl;
    if ($('#set-read-token')) $('#set-read-token').value = s.readToken;
    if ($('#set-write-url')) $('#set-write-url').value = s.writeUrl;
    if ($('#set-write-token')) $('#set-write-token').value = s.writeToken;
  }

  function initSettings() {
    // 儲存
    const saveBtn = $('#set-save');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      JZ.saveSettings({
        readUrl: $('#set-read-url').value,
        readToken: $('#set-read-token').value,
        writeUrl: $('#set-write-url').value,
        writeToken: $('#set-write-token').value
      });
      setSettingsMsg('設定已儲存。', 'ok');
      refreshRecordAccounts();
      // 存好後自動抓一次，並跳到總覽頁（與使用說明一致）
      loadData(true);
      switchTab('overview');
    });

    // 測試連線
    const testBtn = $('#set-test');
    if (testBtn) testBtn.addEventListener('click', function () {
      // 先把當前欄位存起來再測，才不會測到舊值
      JZ.saveSettings({
        readUrl: $('#set-read-url').value,
        readToken: $('#set-read-token').value,
        writeUrl: $('#set-write-url').value,
        writeToken: $('#set-write-token').value
      });
      lockBtn(testBtn, true, '測試中…');
      setSettingsMsg('測試中…', '');
      JZ.testRead().then(function (res) {
        lockBtn(testBtn, false, '測試連線');
        setSettingsMsg(res.message, res.ok ? 'ok' : 'err');
      });
    });

    // 重新整理資料（60 秒節流）
    const refreshBtn = $('#set-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      const wait = JZ.secondsUntilCanRefresh(60);
      if (wait > 0) {
        setSettingsMsg('太頻繁了，請再等 ' + wait + ' 秒。', 'err');
        return;
      }
      lockBtn(refreshBtn, true, '更新中…');
      setSettingsMsg('更新中…', '');
      loadData(false).then(function (res) {
        lockBtn(refreshBtn, false, '重新整理資料');
        setSettingsMsg(res.ok ? '資料已更新。' : res.message, res.ok ? 'ok' : 'err');
      });
    });

    // 密語顯示/隱藏切換
    $all('.toggle-eye').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = $('#' + btn.getAttribute('data-target'));
        if (!target) return;
        if (target.type === 'password') { target.type = 'text'; btn.textContent = '隱藏'; }
        else { target.type = 'password'; btn.textContent = '顯示'; }
      });
    });
  }

  function setSettingsMsg(text, kind) {
    const el = $('#set-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'record-msg' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  // ---------- 抓資料主流程 ----------

  // force = true 代表使用者主動要抓（略過畫面上的節流提示，但 api 內不阻擋）
  function loadData(force) {
    return JZ.fetchAll().then(function (res) {
      if (res.data) {
        state.data = res.data;
        state.fromCache = res.fromCache;
      }
      // 全畫面重繪
      renderAll();

      // 抓取結果的提示（只有非成功且不是「沒設定」時，額外提示）
      if (!res.ok && res.message && !force) {
        // 靜默處理，離線橫幅已經會顯示
      }
      return res;
    });
  }

  function renderAll() {
    renderDataTimeBanner();
    renderOverview();
    initDetailFilters();
    renderDetailList();
    refreshRecordAccounts();
    // 圖表只有在圖表頁可見時畫，這裡若正在圖表頁就順手重畫
    if ($('#tab-charts') && $('#tab-charts').classList.contains('active')) {
      renderCharts();
    }
  }

  // ---------- Service Worker 更新橫幅 ----------

  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('service-worker.js').then(function (reg) {
      // 偵測到有新版本在等待
      function checkWaiting() {
        if (reg.waiting) showUpdateBanner(reg.waiting);
      }
      checkWaiting();
      reg.addEventListener('updatefound', function () {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(nw);
          }
        });
      });
    }).catch(function () { /* 註冊失敗不影響使用 */ });

    // 新 SW 接管後重新整理頁面
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  }

  function showUpdateBanner(worker) {
    const banner = $('#update-banner');
    if (!banner) return;
    banner.style.display = 'block';
    banner.onclick = function () {
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  }

  // ---------- HTML 跳脫（防止資料裡的特殊字元破壞畫面） ----------

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- 啟動 ----------

  function init() {
    // 版本號
    $all('.app-version').forEach(function (el) { el.textContent = APP_VERSION; });

    // 底部導覽
    $all('.nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });

    // 明細篩選事件
    ['#detail-month', '#detail-cat'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.addEventListener('change', renderDetailList);
    });
    if ($('#detail-kw')) $('#detail-kw').addEventListener('input', renderDetailList);

    initRecordForm();
    initSettings();
    loadSettingsIntoForm();

    // 先用快取畫一次（開得快、離線也有東西看）
    const cached = JZ.getCachedData();
    if (cached) {
      state.data = cached;
      state.fromCache = true;
      renderAll();
    }

    // 首次啟動：沒設定就落在設定頁
    if (!JZ.hasReadConfig()) {
      switchTab('settings');
      setSettingsMsg('第一次使用請填入連線資訊：查詢 API 網址與唯讀密語（記帳功能另外填下面兩欄）。', '');
    } else {
      switchTab('overview');
      // 有設定就抓一次最新資料
      loadData(false);
    }

    initServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
