/*
 * app.js — 畫面邏輯（製作人Rui / Maker Rui）
 * 負責分頁切換、把資料畫到畫面上、記帳表單、設定頁。
 * 所有網路請求都交給 api.js（JZ），這裡不直接碰 fetch。
 */

(function () {
  'use strict';

  // 版本號。改版時這裡、index.html 的顯示版本、service-worker.js 的 CACHE_VERSION
  // 三個地方要一起改（詳見 service-worker.js 開頭的改版檢查清單）
  const APP_VERSION = 'v3.6';

  // 支出分類（圓餅圖、明細篩選、記帳下拉，全部都用這一份）
  const EXPENSE_CATEGORIES = ['食', '玩樂', '交通', '寵物', '貸款', '其他'];
  // 收入分類
  const INCOME_CATEGORIES = ['警察收入', '其他收入', '股票收入'];
  // 記帳分類清單 ＝ 支出 ＋ 收入
  // （以前這份完整清單在程式裡抄了兩次，以後要改分類很容易漏改一邊，
  //   現在統一從上面兩份組出來，只要改上面就好）
  const RECORD_CATEGORIES = EXPENSE_CATEGORIES.concat(INCOME_CATEGORIES);

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
      if ($('#account-warning')) $('#account-warning').style.display = 'none';
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
          return '<div class="row tag-row" data-tag="' + escapeHtml(t.tag) + '">' +
            '<span class="row-name tag-name">' + escapeHtml(t.tag) + ' ›</span>' +
            '<span class="row-val">' + money(t.total) + '</span>' +
            '</div>';
        }).join('');
      }
    }

    renderAccountWarning(d);
  }

  /*
   * 支付帳戶名稱打錯字時，那幾筆的錢會「不見」——因為帳戶餘額只算得到名字對得上的帳。
   * 這裡把它抓出來、講清楚是哪個名字打錯。算法見 pure.js 的 computeAccountMismatch。
   */
  /* ---------- 本月預算進度條 ----------
   * 資料來自唯讀 API 的 budgets（契約 2.6 節），後端已經算好「用了多少」。
   * 沒設預算的分類（例如貸款）根本不會出現在那份資料裡，所以這裡不用另外過濾。
   */
  function renderBudget() {
    const wrap = $('#budget-section');
    const list = $('#budget-list');
    const note = $('#budget-note');
    if (!wrap || !list) return;

    const d = state.data;
    const currentMonth = taipeiCurrentMonth();
    const rows = (d && d.budgets ? d.budgets : []).filter(function (b) {
      return b && b.month === currentMonth && Number(b.limit) > 0;
    });

    // 還沒設定預算就整區不顯示，不要放一個空殼在那邊讓人以為壞了
    if (rows.length === 0) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';

    renderAllowance(d, currentMonth);

    // 超支的排最前面，其次是用得最兇的——最該被看到的放最上面
    rows.sort(function (a, b) {
      return (Number(b.ratio) || 0) - (Number(a.ratio) || 0);
    });

    let html = '';
    let anyInherited = false;

    rows.forEach(function (b) {
      const limit = Number(b.limit) || 0;
      const spent = Number(b.spent) || 0;
      const percent = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      if (b.inherited) anyInherited = true;

      // 狀態分三段，跟超支提醒用的是同一組門檻，兩邊講的話才會一致
      let level = '';
      if (percent >= 100) level = 'over';
      else if (percent >= 80) level = 'near';

      // 條子最長畫到 100%，超支的部分靠顏色和數字表達，不要讓它衝出框
      const width = Math.min(percent, 100);

      html += '<div class="budget-row ' + level + '">' +
        '<div class="budget-top">' +
          '<span class="budget-cat">' + escapeHtml(b.category) + '</span>' +
          '<span class="budget-num">' + money(spent) + ' / ' + money(limit) +
            '<span class="budget-pct">' + percent + '%</span>' +
          '</span>' +
        '</div>' +
        '<div class="budget-track">' +
          '<div class="budget-fill ' + level + '" style="width:' + width + '%"></div>' +
        '</div>' +
      '</div>';
    });

    list.innerHTML = html;

    // 沿用上個月的數字時要講一聲，免得他以為自己這個月設過了
    if (note) {
      if (anyInherited) {
        note.textContent = '這個月還沒設定預算，先沿用上個月的數字。想調整就到試算表的「預算」分頁改。';
        note.style.display = '';
      } else {
        note.style.display = 'none';
      }
    }
  }

  /* ---------- 今天還能花多少 ----------
   * 進度條說的是「已經花掉多少」，那是過去式；
   * 這一行說的是「現在起到月底，平均每天還能花多少」，那才會影響你要不要買下手上這杯咖啡。
   *
   * 整體超支時不顯示負數——給一個負的金額只會讓人愣一下還要自己換算，
   * 直接講「今天的預算用完了」比較快。
   */
  function renderAllowance(d, currentMonth) {
    const el = $('#budget-allowance');
    if (!el) return;

    const today = taipeiToday();
    const a = JZ_PURE().dailyAllowance(d.budgets || [], currentMonth, today.day, today.daysInMonth);

    if (!a.ok) {
      el.style.display = 'none';
      return;
    }

    const main = a.perDay > 0
      ? '今天還能花 ' + money(a.perDay)
      : '今天的預算用完了';

    let sub;
    if (a.totalRemaining > 0) {
      sub = '剩 ' + a.daysLeft + ' 天，預算還有 ' + money(a.totalRemaining);
    } else {
      sub = '剩 ' + a.daysLeft + ' 天，整體已經超出 ' + money(Math.abs(a.totalRemaining));
    }
    if (a.overCategories.length > 0) {
      sub += '（' + a.overCategories.join('、') + '超支）';
    }

    el.innerHTML =
      '<div class="allowance-main' + (a.perDay > 0 ? '' : ' none-left') + '">' + escapeHtml(main) + '</div>' +
      '<div class="allowance-sub">' + escapeHtml(sub) + '</div>';
    el.style.display = '';
  }

  function renderAccountWarning(d) {
    const el = $('#account-warning');
    if (!el) return;

    const r = JZPure.computeAccountMismatch(d.accounts, d.monthly, d.transactions);
    if (!r.hasIssue) {
      el.style.display = 'none';
      return;
    }

    let msg;
    if (r.unknownAccounts.length > 0) {
      // 找得到是哪個名字打錯 → 做成可以點的，點下去直接看到是哪幾筆。
      // 只告訴他「有問題」卻要他自己去試算表大海撈針，等於把最麻煩的一段丟回給他
      const parts = r.unknownAccounts.map(function (u) {
        return '<button type="button" class="link-btn" data-acct="' + escapeHtml(u.name) + '">' +
          escapeHtml(u.name) + '（' + u.count + ' 筆，' + money(u.total) + ' 元）</button>';
      });
      msg = '有紀錄的支付帳戶不在帳戶名單裡：' + parts.join('、') +
        '。這些錢不會算進上面的帳戶餘額。<b>點一下名字就會列出是哪幾筆</b>，' +
        '確認是不是打錯字。';
    } else {
      // 只知道對不起來，但找不出是哪筆（例如後端算法有變）
      msg = '帳戶餘額加起來跟總資產差了 <b>' + money(Math.abs(r.diff)) +
        '</b> 元。可能有紀錄的支付帳戶名稱對不上帳戶名單，建議到試算表檢查一下。';
    }
    el.innerHTML = msg;
    el.style.display = 'block';
  }

  /*
   * 常用項目：統計最近 3 個月最常記的項目，做成一排小按鈕。
   * 為什麼從流水帳統計，而不是只記這個 App 送出過的？
   * 因為你大部分的帳是用 iPhone 捷徑記的，那些不會經過這個 App，
   * 只記 App 內的話樣本太少，可能好幾天都湊不滿一排按鈕。
   */
  function renderQuickItems() {
    const el = $('#r-quick');
    if (!el) return;

    const d = state.data;
    let names = JZPure.topItems(d ? d.transactions : null, {
      untilMonth: taipeiCurrentMonth(),
      months: 3,
      limit: 10
    });
    // 資料還沒抓回來時，退而用這支手機上最近按過的項目頂著
    if (names.length === 0) names = JZ.getRecentItems();

    if (names.length === 0) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }

    el.innerHTML = names.map(function (n) {
      return '<button type="button" class="quick-item" data-item="' + escapeHtml(n) + '">' +
        escapeHtml(n) + '</button>';
    }).join('');
    el.style.display = 'flex';
  }

  /*
   * 記帳成功的回饋：能震動就震一下，並讓金額欄閃一下綠色。
   * ⚠️ iPhone 的 Safari 不支援網頁震動（這是蘋果的平台限制，不是程式問題），
   *    所以在 iPhone 上只會看到閃綠色；Android 兩個都有。
   */
  /* ---------- 項目記憶分類 ----------
   * 打「午餐」就把上次記午餐時用的分類和帳戶帶出來，少點兩下。
   * 資料是從流水帳推出來的（見 pure.js 的 itemMemory），
   * 所以連用 iPhone 捷徑記的帳也算數，不是只記這個 App 送出過的。
   */
  function applyItemMemory(itemName) {
    const name = String(itemName || '').trim();
    if (name === '' || !state.data || !window.JZPure) return;

    const memory = JZPure.itemMemory(state.data.transactions || []);
    const hit = memory[name.toLowerCase()];
    if (!hit) return;

    const catSel = $('#r-category');
    const accSel = $('#r-account');

    // 只在「選項真的存在」時才設，避免設成一個不存在的值變成空白
    if (catSel && hit.category && hasOption(catSel, hit.category)) {
      catSel.value = hit.category;
    }
    if (accSel && hit.account && hasOption(accSel, hit.account)) {
      accSel.value = hit.account;
    }
  }

  function celebrate(inputEl) {
    try {
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) { /* 不支援就算了 */ }

    if (!inputEl) return;
    inputEl.classList.remove('flash-ok');
    // 讀一次 offsetWidth 逼瀏覽器重新計算版面，動畫才會重播（不然連續記兩筆只會亮一次）
    void inputEl.offsetWidth;
    inputEl.classList.add('flash-ok');
    setTimeout(function () { inputEl.classList.remove('flash-ok'); }, 600);
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

    renderTrend();
    renderCompare();
    renderYearPie();
    renderAchievement();
    renderIncome();
  }

  /* ---------- 分類走勢 ----------
   * 一次只畫一個分類。下拉選單選哪個就畫哪個，選擇記在 trendCategory 裡，
   * 資料重新整理時不會被重設掉。
   */
  var trendCategory = '';
  var TREND_MONTHS = 6;

  function renderTrend() {
    const d = state.data;
    const sel = $('#trend-cat');
    const summary = $('#trend-summary');
    if (!sel || !d) return;

    const trend = JZ_PURE().categoryTrend(d.transactions || [], {
      untilMonth: taipeiCurrentMonth(),
      months: TREND_MONTHS
    });

    // 只列出「這段期間真的有花過錢」的分類，空的分類放進選單只是干擾
    const names = Object.keys(trend.series).filter(function (name) {
      return trend.series[name].some(function (v) { return v > 0; });
    });
    // 依 EXPENSE_CATEGORIES 的順序排，跟圓餅圖、預算區的順序一致
    names.sort(function (a, b) {
      return EXPENSE_CATEGORIES.indexOf(a) - EXPENSE_CATEGORIES.indexOf(b);
    });

    if (names.length === 0) {
      sel.innerHTML = '<option value="">（還沒有支出資料）</option>';
      JZCharts.drawCategoryTrend('chart-trend', [], [], '');
      if (summary) summary.style.display = 'none';
      return;
    }

    if (names.indexOf(trendCategory) < 0) trendCategory = names[0];

    sel.innerHTML = names.map(function (n) {
      return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
    }).join('');
    sel.value = trendCategory;

    const values = trend.series[trendCategory] || [];
    JZCharts.drawCategoryTrend('chart-trend', trend.months, values, trendCategory);

    // 圖看完了還是要有一句話告訴他「所以呢」——
    // 成就感才是讓人繼續記帳的燃料，光有折線不夠
    if (summary) {
      const first = values[0] || 0;
      const last = values[values.length - 1] || 0;
      let text;
      if (first === 0) {
        text = '這段期間的第一個月沒有紀錄，看不出趨勢。';
      } else if (last < first) {
        const cut = Math.round(((first - last) / first) * 100);
        text = '跟 ' + trend.months[0] + ' 比，' + trendCategory + '少了 ' +
               money(first - last) + ' 元（少 ' + cut + '%）。';
      } else if (last > first) {
        const up = Math.round(((last - first) / first) * 100);
        text = '跟 ' + trend.months[0] + ' 比，' + trendCategory + '多了 ' +
               money(last - first) + ' 元（多 ' + up + '%）。';
      } else {
        text = '跟 ' + trend.months[0] + ' 比幾乎沒變。';
      }
      summary.textContent = text + '（本月還沒過完，最後一個月會偏低）';
      summary.style.display = '';
    }
  }

  /* ---------- 跟上個月比 ---------- */
  function renderCompare() {
    const d = state.data;
    const wrap = $('#compare-list');
    if (!wrap || !d) return;

    const rows = JZ_PURE().compareMonths(d.transactions || [], taipeiCurrentMonth());
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-hint">還沒有可以比較的資料。</div>';
      return;
    }

    wrap.innerHTML = rows.map(function (r) {
      let badge;
      if (r.previous === 0) {
        // 從 0 變成有，算不出百分比。硬寫「增加 100%」是騙人的
        badge = '<span class="cmp-new">新增</span>';
      } else if (r.delta > 0) {
        badge = '<span class="cmp-up">▲ ' + Math.abs(Math.round(r.percent)) + '%</span>';
      } else if (r.delta < 0) {
        badge = '<span class="cmp-down">▼ ' + Math.abs(Math.round(r.percent)) + '%</span>';
      } else {
        badge = '<span class="cmp-flat">持平</span>';
      }

      return '<div class="cmp-row">' +
        '<span class="cmp-cat">' + escapeHtml(r.category) + '</span>' +
        '<span class="cmp-nums">' + money(r.current) +
          '<span class="cmp-prev">上月 ' + money(r.previous) + '</span></span>' +
        badge +
      '</div>';
    }).join('');
  }

  /* ---------- 年度累計圓餅 ---------- */
  function renderYearPie() {
    const d = state.data;
    if (!d) return;

    const year = taipeiCurrentMonth().slice(0, 4);
    const titleEl = $('#year-title');
    if (titleEl) titleEl.textContent = year + ' 年支出';

    const totals = JZ_PURE().yearTotals(d.transactions || [], year);
    // 圓餅旁的文字清單由 drawCategoryPie 自己填進 chart-year-legend，這裡不用另外處理
    JZCharts.drawCategoryPie('chart-year', totals, year + ' 年還沒有支出紀錄');
  }

  /* ---------- 預算達成率 ---------- */
  function renderAchievement() {
    const d = state.data;
    const wrap = $('#achieve-list');
    if (!wrap || !d) return;

    const rows = JZ_PURE().budgetAchievement(d.budgets || [], taipeiCurrentMonth());

    // 第一個月打開一定是空的，這是正常的，要講清楚免得他以為壞了
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty-hint">' +
        '要等這個月過完才有第一筆紀錄。<br>' +
        '累積 2～3 個月之後，這裡會顯示你每個月守住了幾個分類。' +
        '</div>';
      return;
    }

    // 新到舊，最近的月份先看到
    const ordered = rows.slice().reverse();
    wrap.innerHTML = ordered.map(function (r) {
      const allKept = r.kept === r.total;
      const overText = r.over.length > 0 ? '超支：' + r.over.join('、') : '全部守住';
      return '<div class="achieve-row' + (allKept ? ' good' : '') + '">' +
        '<span class="achieve-month">' + escapeHtml(r.month) + '</span>' +
        '<span class="achieve-score">' + r.kept + ' / ' + r.total + '</span>' +
        '<span class="achieve-note">' + escapeHtml(overText) + '</span>' +
      '</div>';
    }).join('');
  }

  /* ---------- 收入來源 ----------
   * 走勢用 monthly 的 income（後端算好的，月份連續、沒收入的月份是 0）；
   * 下面的排行用 transactions 自己算。兩邊加起來會一致，因為後端的 income
   * 也是從同一份流水帳算出來的。
   *
   * 為什麼列「項目」不畫「分類」圓餅？
   * 因為收入分類只有三種、警察收入佔九成，圓餅畫出來幾乎是一個完整的圓，看不出東西。
   * 項目層級才有資訊：超勤、獎勵金、考績獎金、代墊回收各是多少。
   */
  var incomeMonth = '__all';
  var INCOME_TOP = 12;

  function renderIncome() {
    const d = state.data;
    if (!d) return;

    const monthly = d.monthly || [];
    const months = monthly.map(function (m) { return m.month; });
    const values = monthly.map(function (m) { return Number(m.income) || 0; });
    if (window.JZCharts) JZCharts.drawIncomeTrend('chart-income', months, values);

    // 月份下拉：全部期間 ＋ 各月份（新到舊）
    const sel = $('#income-month');
    if (sel) {
      let opts = '<option value="__all">全部期間</option>';
      months.slice().reverse().forEach(function (m) {
        opts += '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>';
      });
      sel.innerHTML = opts;
      // 選過的月份如果在新資料裡不見了就退回「全部期間」，不要卡在空畫面
      if (incomeMonth !== '__all' && months.indexOf(incomeMonth) < 0) incomeMonth = '__all';
      sel.value = incomeMonth;
    }

    renderIncomeList();
  }

  function renderIncomeList() {
    const d = state.data;
    const wrap = $('#income-list');
    if (!wrap || !d) return;

    // 先拿完整清單算總額，再截前幾名顯示。
    // 佔比一定要用「全部收入」當分母，用前 12 名的和當分母會算出假的比例
    const all = JZ_PURE().incomeItems(d.transactions || [], incomeMonth, 0);
    if (all.length === 0) {
      wrap.innerHTML = '<div class="empty-hint">這段期間沒有收入紀錄。</div>';
      return;
    }

    let total = 0;
    all.forEach(function (r) { total += r.total; });

    const rows = all.slice(0, INCOME_TOP);
    let html = rows.map(function (r) {
      const share = total > 0 ? Math.round(r.total / total * 100) : 0;
      return '<div class="income-row">' +
        '<span class="income-item">' + escapeHtml(r.item) + '</span>' +
        '<span class="income-count">' + r.count + ' 筆</span>' +
        '<span class="income-total">' + money(r.total) + '</span>' +
        '<span class="income-share">' + share + '%</span>' +
      '</div>';
    }).join('');

    // 被截掉的要補一行，不然清單加起來跟總收入對不上，看起來像少算
    if (all.length > rows.length) {
      let shown = 0;
      rows.forEach(function (r) { shown += r.total; });
      const restCount = all.length - rows.length;
      html += '<div class="income-row">' +
        '<span class="income-item muted">其餘 ' + restCount + ' 項</span>' +
        '<span class="income-count"></span>' +
        '<span class="income-total muted">' + money(total - shown) + '</span>' +
        '<span class="income-share"></span>' +
      '</div>';
    }

    wrap.innerHTML = html;
  }

  /* ---------- 月底預估 ----------
   * 算法故意很笨：到今天為止的平均日花費 × 剩下的天數，再扣掉還沒繳的固定支出。
   * 不做迴歸也不看季節性——資料量太小，複雜的模型只會給出假精準。
   */
  function renderForecast() {
    const d = state.data;
    const wrap = $('#forecast-section');
    const body = $('#forecast-body');
    if (!wrap || !body) return;

    /* 資料不夠的時候不要整區藏起來，要留著並說明原因。
     * 藏起來的話，使用者根本分不出「還沒到時候」跟「功能壞了」，
     * 只會覺得東西怎麼不見了。 */
    function showHint(text) {
      wrap.style.display = '';
      body.innerHTML = '<div class="empty-hint">' + escapeHtml(text) + '</div>';
    }

    if (!d) {
      showHint('還沒有資料，請先到設定頁連線。');
      return;
    }

    const cm = taipeiCurrentMonth();
    const now = taipeiToday();

    // 這個月已經花掉的「可控支出」＝有設預算的分類的支出總和。
    // 貸款那種固定支出不算進日均，不然日均會被月初的大筆扣款灌爆。
    const budgetRows = (d.budgets || []).filter(function (b) { return b.month === cm; });
    if (budgetRows.length === 0) {
      showHint('要先在試算表的「預算」分頁設定各分類的預算，這裡才算得出月底大概剩多少。');
      return;
    }

    let spentSoFar = 0;
    budgetRows.forEach(function (b) { spentSoFar += Number(b.spent) || 0; });

    // 還沒繳的固定支出
    let pendingFixed = 0;
    (d.recurring || []).forEach(function (r) {
      if (!r.done_this_month) {
        const amount = (!r.fixed && Number(r.last_amount) > 0) ? r.last_amount : r.amount;
        pendingFixed += Number(amount) || 0;
      }
    });

    let totalAssets = 0;
    (d.accounts || []).forEach(function (a) { totalAssets += Number(a.balance) || 0; });

    const forecast = JZ_PURE().forecastMonthEnd({
      totalAssets: totalAssets,
      spentSoFar: spentSoFar,
      dayOfMonth: now.day,
      daysInMonth: now.daysInMonth,
      pendingFixed: pendingFixed
    });

    if (!forecast) {
      // 月初前兩天樣本太少，推估出來只會嚇到自己。
      // 但還是要說一聲，不然他會以為壞了。
      const wait = Math.max(3 - now.day, 0);
      showHint(
        '月初資料太少，算出來會亂跳，所以先不顯示。' +
        (wait > 0 ? '再過 ' + wait + ' 天就會出現。' : '')
      );
      return;
    }
    wrap.style.display = '';

    let html = '<div class="forecast-main">' + money(forecast.projectedEnd) + '</div>' +
      '<div class="forecast-sub">照目前的花法，' + now.daysInMonth + ' 號月底大概剩這麼多</div>' +
      '<div class="forecast-detail">' +
        '<div><span>目前總資產</span><span>' + money(totalAssets) + '</span></div>' +
        '<div><span>平均每天花</span><span>' + money(forecast.dailyAverage) + '</span></div>' +
        '<div><span>剩下 ' + forecast.daysLeft + ' 天預估再花</span><span>−' + money(forecast.projectedSpend) + '</span></div>';
    if (forecast.pendingFixed > 0) {
      html += '<div><span>還沒繳的固定支出</span><span>−' + money(forecast.pendingFixed) + '</span></div>';
    }
    html += '</div>' +
      '<div class="forecast-note">這是最笨的算法：平均日花費乘上剩餘天數。' +
      '月初算出來的數字會特別不準，參考就好。</div>';

    body.innerHTML = html;
  }

  /** 台北時間的今天：幾號、這個月有幾天 */
  function taipeiToday() {
    const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const parts = s.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    // 下個月的第 0 天＝這個月的最後一天
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { year: year, month: month, day: day, daysInMonth: daysInMonth };
  }

  /** pure.js 沒載入時給一組什麼都不做的替身，不要讓整個畫面掛掉 */
  function JZ_PURE() {
    if (window.JZPure) return window.JZPure;
    return {
      categoryTrend: function () { return { months: [], series: {} }; },
      compareMonths: function () { return []; },
      yearTotals: function () { return {}; },
      budgetAchievement: function () { return []; },
      forecastMonthEnd: function () { return null; },
      incomeItems: function () { return []; },
      dailyAllowance: function () { return { ok: false, overCategories: [] }; }
    };
  }

  // ---------- 明細頁 ----------

  /*
   * 明細頁的狀態
   *  detailFilter：記住使用者「自己選過」什麼，這樣去記一筆帳回來，篩選才不會被重設。
   *                touched 代表他真的動過篩選；沒動過就維持「預設看本月」的原始行為。
   *  detailState： rows 是完整的篩選結果（合計一律用它算），shown 是畫面上目前顯示到第幾筆。
   */
  const detailFilter = { month: null, cat: '__all', acct: '__all', kw: '', touched: false };
  const detailState = { rows: [], shown: 0 };
  const DETAIL_PAGE_SIZE = 200; // 一次先畫這麼多筆，其餘按「載入更多」

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

    // 決定月份要選哪一個：
    // 使用者自己選過、而且那個選擇在新的清單裡還在 → 還給他
    // （一定要檢查「還在不在」。不然像 10 月 1 號這種新月份出現的時候，
    //   會發生「資料更新了畫面卻還卡在上個月」，看起來像壞掉。）
    const canRestoreMonth = detailFilter.touched && detailFilter.month &&
      (detailFilter.month === '__all' || months.indexOf(detailFilter.month) >= 0);
    if (canRestoreMonth) {
      monthSel.value = detailFilter.month;
    } else if (months.indexOf(cm) >= 0) {
      monthSel.value = cm;               // 預設本月
    } else if (months.length > 0) {
      monthSel.value = months[0];        // 本月沒資料就選最近有資料的月份
    } else {
      monthSel.value = '__all';
    }

    // 分類下拉：分成「支出」「收入」兩群，不要 9 個混在一起
    let catOpts = '<option value="__all">全部分類</option>';
    catOpts += '<optgroup label="支出">';
    EXPENSE_CATEGORIES.forEach(function (c) { catOpts += '<option value="' + c + '">' + c + '</option>'; });
    catOpts += '</optgroup><optgroup label="收入">';
    INCOME_CATEGORIES.forEach(function (c) { catOpts += '<option value="' + c + '">' + c + '</option>'; });
    catOpts += '</optgroup>';
    catSel.innerHTML = catOpts;

    const canRestoreCat = detailFilter.touched && detailFilter.cat &&
      (detailFilter.cat === '__all' || RECORD_CATEGORIES.indexOf(detailFilter.cat) >= 0);
    catSel.value = canRestoreCat ? detailFilter.cat : '__all';

    /*
     * 帳戶下拉：選項從「流水帳裡實際出現過的帳戶名」產生，**不是**從帳戶名單產生。
     * 這點是刻意的——名字打錯的那幾筆，它的帳戶名正好就不在名單裡；
     * 若照名單生選項，要查的那幾筆會永遠選不到，這個功能等於白做。
     * 不在名單裡的名字前面加個記號，讓他一眼看出哪個是打錯的。
     */
    const acctSel = $('#detail-acct');
    if (acctSel) {
      const known = {};
      (d && d.accounts ? d.accounts : []).forEach(function (a) { known[a.name] = true; });

      const accts = [];
      (d ? d.transactions || [] : []).forEach(function (t) {
        const name = (t.account || '').trim();
        if (name && accts.indexOf(name) < 0) accts.push(name);
      });
      // 不在名單裡的（known 是 false，排序值 0）排最前面，因為那才是要他去處理的；
      // 其餘照名稱排，讓順序穩定
      accts.sort(function (a, b) {
        const aKnown = known[a] ? 1 : 0;
        const bKnown = known[b] ? 1 : 0;
        if (aKnown !== bKnown) return aKnown - bKnown;
        return a < b ? -1 : (a > b ? 1 : 0);
      });

      let acctOpts = '<option value="__all">全部帳戶</option>';
      accts.forEach(function (n) {
        const mark = known[n] ? '' : '⚠ ';
        acctOpts += '<option value="' + escapeHtml(n) + '">' + mark + escapeHtml(n) + '</option>';
      });
      acctSel.innerHTML = acctOpts;

      const canRestoreAcct = detailFilter.touched && detailFilter.acct &&
        (detailFilter.acct === '__all' || accts.indexOf(detailFilter.acct) >= 0);
      acctSel.value = canRestoreAcct ? detailFilter.acct : '__all';
      detailFilter.acct = acctSel.value;
    }

    // 把最後決定的值寫回記憶，讓下次還原時有依據
    detailFilter.month = monthSel.value;
    detailFilter.cat = catSel.value;
  }

  /*
   * 篩選的「唯一入口」。
   * 換月份、換分類、打關鍵字、點標籤跳過來、資料重新載入——通通走這裡，
   * 這樣就不會有某條路徑忘記把「已顯示筆數」歸零、導致畫面和合計對不起來。
   */
  function applyDetailFilter() {
    const d = state.data;
    const monthSel = $('#detail-month');
    const catSel = $('#detail-cat');
    const acctSel = $('#detail-acct');
    const kwEl = $('#detail-kw');

    detailFilter.month = monthSel ? monthSel.value : '__all';
    detailFilter.cat = catSel ? catSel.value : '__all';
    detailFilter.acct = acctSel ? acctSel.value : '__all';
    detailFilter.kw = kwEl ? kwEl.value : '';

    detailState.rows = JZPure.filterTransactions(d ? d.transactions : null, {
      month: detailFilter.month,
      cat: detailFilter.cat,
      acct: detailFilter.acct,
      kw: detailFilter.kw
    });
    detailState.shown = 0;
    renderDetailList();
  }

  // 把一筆交易畫成一張小卡
  function txCardHtml(t) {
    const amt = Number(t.amount) || 0;
    let sign = '', cls = '';
    if (t.type === '支出') { sign = '−'; cls = 'amt-out'; }
    else if (t.type === '收入') { sign = '+'; cls = 'amt-in'; }
    else { sign = ''; cls = 'amt-transfer'; } // 轉入／轉出用灰色

    const noteHtml = t.note ? '<div class="tx-note">' + escapeHtml(t.note) + '</div>' : '';

    // 只有後端回得出列號時才給「⋯」。
    // 這樣在唯讀 API 還沒更新完之前，前端先上線也不會出現一顆按了沒反應的按鈕。
    const rowNo = Number(t.row) || 0;
    const moreBtn = rowNo > 0
      ? '<button type="button" class="tx-more" data-row="' + rowNo + '" title="修改或刪除">⋯</button>'
      : '';

    return '<div class="tx">' +
      '<div class="tx-top">' +
        '<span class="tx-item">' + escapeHtml(t.item || '') + '</span>' +
        '<span class="tx-amt ' + cls + '">' + sign + money(amt) + '</span>' +
      '</div>' +
      '<div class="tx-sub">' +
        '<span>' + fmtDateTime(t.time) + '</span>' +
        '<span class="tx-tags">' + escapeHtml(t.category || '') + ' · ' + escapeHtml(t.account || '') + '　<em>' + escapeHtml(t.type || '') + '</em>' + moreBtn + '</span>' +
      '</div>' +
      noteHtml +
      '</div>';
  }

  /* ---------- 修改／刪除一筆帳 ----------
   *
   * 靠唯讀 API 回傳的列號（row）定位試算表的那一列，送出時附上「時間＋金額＋項目」，
   * 後端會先比對那一列真的是這一筆才動手。
   *
   * 為什麼要這層保險：列號是「上次抓資料時」的狀態。如果這中間你自己在試算表刪了一列，
   * 後面所有列號都會往上移一格，照舊列號去刪就會刪到隔壁那筆帳，而且你不會發現。
   *
   * 轉帳（轉入／轉出）只給刪不給改：一次轉帳是兩列，改其中一列會讓兩邊對不起來。
   */
  var editingTx = null;   // 目前正在編輯的那一筆

  function isTransferTx(t) {
    return t && (t.type === '轉入' || t.type === '轉出');
  }

  function setEditMsg(text, kind) {
    const el = $('#edit-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'record-msg' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  function openEditModal(tx) {
    const modal = $('#edit-modal');
    if (!modal || !tx) return;

    editingTx = tx;
    setEditMsg('', '');
    // 每次打開都把刪除確認收回去，不要讓上一次按到一半的狀態殘留
    $('#e-confirm').style.display = 'none';
    $('#e-delete').style.display = '';

    const transfer = isTransferTx(tx);

    // 分類下拉：轉帳的分類（轉入／轉出）不在記帳用的清單裡，
    // 所以那種情況直接把它自己放進去並鎖住，不要讓畫面顯示一個對不上的值
    const catSel = $('#e-category');
    if (catSel) {
      if (transfer) {
        catSel.innerHTML = '<option value="' + escapeHtml(tx.category) + '">' + escapeHtml(tx.category) + '</option>';
      } else {
        let html = '<optgroup label="支出">';
        EXPENSE_CATEGORIES.forEach(function (c) { html += '<option value="' + c + '">' + c + '</option>'; });
        html += '</optgroup><optgroup label="收入">';
        INCOME_CATEGORIES.forEach(function (c) { html += '<option value="' + c + '">' + c + '</option>'; });
        html += '</optgroup>';
        catSel.innerHTML = html;
      }
      catSel.value = tx.category || '';
    }

    // 帳戶下拉：用目前的帳戶名單；萬一這筆的帳戶名打錯字（不在名單裡），
    // 也要把它加進去，否則畫面會顯示成別的帳戶，一存檔就改錯了
    const accSel = $('#e-account');
    if (accSel) {
      const d = state.data;
      const names = (d && d.accounts) ? d.accounts.map(function (a) { return a.name; }) : [];
      let html = '';
      names.forEach(function (n) { html += '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; });
      if (tx.account && names.indexOf(tx.account) < 0) {
        html += '<option value="' + escapeHtml(tx.account) + '">⚠ ' + escapeHtml(tx.account) + '（不在名單裡）</option>';
      }
      accSel.innerHTML = html;
      accSel.value = tx.account || '';
    }

    $('#e-amount').value = Math.abs(Number(tx.amount) || 0);
    $('#e-item').value = tx.item || '';
    $('#e-note').value = tx.note || '';

    const meta = $('#edit-meta');
    if (meta) {
      let text = fmtDateTime(tx.time) + '　第 ' + tx.row + ' 列';
      if (transfer) {
        text += '｜這是一筆轉帳的其中一半，只能刪除。刪掉之後記得把另一半（' +
          (tx.type === '轉出' ? '轉入' : '轉出') + '）也刪掉，不然帳會對不起來。';
      }
      meta.textContent = text;
    }

    // 轉帳不給改，只給刪
    ['#e-amount', '#e-item', '#e-category', '#e-account', '#e-note', '#e-save'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.disabled = transfer;
    });

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';   // 底下的明細不要跟著捲
  }

  function closeEditModal() {
    const modal = $('#edit-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    editingTx = null;
  }

  /** 後端要的身分證：對不上就拒絕動手 */
  function verifyOf(tx) {
    return { time: tx.time, amount: tx.amount, item: tx.item };
  }

  /*
   * 後端說「這一列跟你看到的不一樣」時的自動修復。
   *
   * 會發生的原因幾乎都是列號位移：你自己在試算表刪掉一列之後，後面所有帳的列號
   * 都往上移一格，而 App 手上還是舊的列號。後端擋下來是對的（不然就刪到隔壁那筆了），
   * 但只丟一句「請重新整理」就等於把麻煩丟回給你。
   *
   * 所以這裡自動重抓一次，再用「時間＋金額＋項目」把同一筆帳重新找出來、換上新的列號。
   * 找得到的話再按一次就會成功；找不到就代表那筆真的已經不在了。
   */
  function isStaleRowError(message) {
    return String(message || '').indexOf('重新整理') >= 0;
  }

  function findSameTx(target) {
    if (!target) return null;
    const list = (state.data && state.data.transactions) ? state.data.transactions : [];
    const amount = Math.abs(Number(target.amount) || 0);
    const item = String(target.item || '').trim();
    for (let i = 0; i < list.length; i++) {
      const t = list[i] || {};
      if (String(t.time) !== String(target.time)) continue;
      if (Math.abs(Number(t.amount) || 0) !== amount) continue;
      if (String(t.item || '').trim() !== item) continue;
      return t;
    }
    return null;
  }

  function recoverStaleRow(originalMessage) {
    const target = editingTx;
    setEditMsg('資料好像在別的地方被動過，正在重新確認…', '');

    loadData().then(function () {
      // 面板可能在這中間被關掉了，那就不用再管
      if (!editingTx || editingTx !== target) return;

      const fresh = findSameTx(target);
      if (fresh && Number(fresh.row) > 0) {
        editingTx = fresh;
        setEditMsg('這筆帳在試算表裡的位置變了（你可能刪過別列），已經幫你對回來，再按一次就可以了。', 'err');
        return;
      }
      setEditMsg('這筆帳在試算表裡已經找不到了，可能已經被刪掉。關掉這個視窗看一下最新的明細。', 'err');
    }).catch(function () {
      setEditMsg(originalMessage, 'err');
    });
  }

  function saveEdit() {
    if (!editingTx) return;
    const tx = editingTx;

    const amount = parseFloat($('#e-amount').value);
    const item = ($('#e-item').value || '').trim();
    const category = $('#e-category').value || '';
    const account = $('#e-account').value || '';
    const note = ($('#e-note').value || '').trim();

    if (!(amount > 0)) { setEditMsg('金額要大於 0。', 'err'); return; }
    if (!item) { setEditMsg('項目不能留空。', 'err'); return; }
    if (!account) { setEditMsg('請選擇支付帳戶。', 'err'); return; }

    const btn = $('#e-save');
    lockBtn(btn, true, '儲存中…');
    setEditMsg('儲存中…', '');

    JZ.updateEntry(tx.row, verifyOf(tx), {
      amount: amount, item: item, category: category, account: account, note: note
    }).then(function (res) {
      lockBtn(btn, false, '儲存');
      if (res.ok) {
        closeEditModal();
        loadData();
        return;
      }
      // 逾時的情況：可能已經改好了，重抓一次讓他自己看
      if (res.timeout) {
        setEditMsg(res.message + '（重新抓一次資料，請確認是不是已經改好了）', 'err');
        loadData();
        return;
      }
      // 列號位移：自動重抓並把列號對回來，不要叫他自己去重新整理
      if (isStaleRowError(res.message)) {
        recoverStaleRow(res.message);
        return;
      }
      setEditMsg(res.message, 'err');
    });
  }

  function doDelete() {
    if (!editingTx) return;
    const tx = editingTx;

    const yes = $('#e-delete-yes');
    lockBtn(yes, true, '刪除中…');
    setEditMsg('刪除中…', '');

    JZ.deleteEntry(tx.row, verifyOf(tx)).then(function (res) {
      lockBtn(yes, false, '確定刪除');
      if (res.ok) {
        closeEditModal();
        loadData();
        return;
      }
      if (res.timeout) {
        setEditMsg(res.message + '（重新抓一次資料，請確認是不是已經刪掉了）', 'err');
        loadData();
        return;
      }
      if (isStaleRowError(res.message)) {
        // 刪除的確認狀態要收回去，不然他看到訊息會直接又按「確定刪除」
        $('#e-confirm').style.display = 'none';
        $('#e-delete').style.display = '';
        recoverStaleRow(res.message);
        return;
      }
      setEditMsg(res.message, 'err');
    });
  }

  function initEditModal() {
    const cancel = $('#e-cancel');
    if (cancel) cancel.addEventListener('click', closeEditModal);

    const save = $('#e-save');
    if (save) save.addEventListener('click', saveEdit);

    // 點遮罩（面板外面）也能關掉
    const modal = $('#edit-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeEditModal();
      });
    }

    const del = $('#e-delete');
    if (del) del.addEventListener('click', function () {
      $('#e-confirm').style.display = 'block';
      del.style.display = 'none';
    });

    const no = $('#e-delete-no');
    if (no) no.addEventListener('click', function () {
      $('#e-confirm').style.display = 'none';
      $('#e-delete').style.display = '';
    });

    const yes = $('#e-delete-yes');
    if (yes) yes.addEventListener('click', doDelete);
  }

  // 摘要列：筆數與合計。
  // ★合計一律用「完整的篩選結果」算，跟畫面上目前顯示幾筆完全無關★
  function renderDetailSummary() {
    const el = $('#detail-summary');
    if (!el) return;

    const rows = detailState.rows;
    if (!rows || rows.length === 0) {
      el.style.display = 'none';
      return;
    }

    const s = JZPure.summarize(rows);
    let html = '<div class="sum-row">' +
      '<span class="sum-count">共 ' + s.count + ' 筆</span>' +
      '<span class="sum-pair">' +
        '<span class="sum-item out">支出 <b>' + money(s.expense) + '</b></span>' +
        '<span class="sum-item in">收入 <b>' + money(s.income) + '</b></span>' +
      '</span></div>';

    // 轉帳只有真的篩到才顯示，平常不佔版面。
    // 它是「錢從左口袋換到右口袋」，跟收支不同性質，所以另外列、不混進上面兩個數字。
    if (s.transfer > 0) {
      html += '<div class="sum-row"><span class="sum-note">轉帳 ' + money(s.transfer) + '（不計入收支）</span></div>';
    }

    el.innerHTML = html;
    el.style.display = 'block';
  }

  // 把明細畫出來。分批顯示：一次先畫 DETAIL_PAGE_SIZE 筆，其餘按「載入更多」再接上去。
  function renderDetailList() {
    const listEl = $('#detail-list');
    const moreBtn = $('#detail-more');
    if (!listEl) return;

    if (!state.data) {
      listEl.innerHTML = '<div class="empty-hint">尚無資料。</div>';
      if ($('#detail-summary')) $('#detail-summary').style.display = 'none';
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    renderDetailSummary();

    const rows = detailState.rows;
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">沒有符合條件的紀錄。</div>';
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    const end = Math.min(rows.length, DETAIL_PAGE_SIZE);
    detailState.shown = end;
    listEl.innerHTML = rows.slice(0, end).map(txCardHtml).join('');
    updateDetailMoreBtn();
  }

  // 按「載入更多」：把下一批接在後面，不要整份重畫（不然會跳回頂端）
  function loadMoreDetail() {
    const listEl = $('#detail-list');
    const rows = detailState.rows;
    if (!listEl || detailState.shown >= rows.length) return;

    const end = Math.min(rows.length, detailState.shown + DETAIL_PAGE_SIZE);
    const html = rows.slice(detailState.shown, end).map(txCardHtml).join('');
    listEl.insertAdjacentHTML('beforeend', html);
    detailState.shown = end;
    updateDetailMoreBtn();
  }

  function updateDetailMoreBtn() {
    const moreBtn = $('#detail-more');
    if (!moreBtn) return;
    const remain = detailState.rows.length - detailState.shown;
    if (remain > 0) {
      moreBtn.textContent = '載入更多（還有 ' + remain + ' 筆）';
      moreBtn.style.display = 'block';
    } else {
      moreBtn.style.display = 'none';
    }
  }

  /*
   * 從總覽的專案標籤點進來：切到明細頁，自動篩出這個標籤的所有花費。
   * ★月份一定要設成「全部」★——總覽上那個標籤金額是「全部期間」的加總，
   * 如果明細只篩本月，兩個數字會對不起來，看起來像程式壞了。
   * 做對的話會有一個很好的驗收指標：明細的「支出合計」會剛好等於總覽上那個數字。
   */
  function jumpToTag(tag) {
    switchTab('detail');
    const monthSel = $('#detail-month');
    const catSel = $('#detail-cat');
    const acctSel = $('#detail-acct');
    const kwEl = $('#detail-kw');
    if (monthSel) monthSel.value = '__all';
    if (catSel) catSel.value = '__all';
    if (acctSel) acctSel.value = '__all';
    if (kwEl) kwEl.value = tag;
    detailFilter.touched = true;
    applyDetailFilter();
  }

  /*
   * 從總覽的「帳戶對不上」提醒點進來：切到明細，篩出那個帳戶的全部紀錄。
   * 月份同樣要設成「全部」——提醒上寫的筆數與金額是全期間算的，
   * 只篩本月的話兩個數字對不起來，看起來像程式壞了。
   */
  function jumpToAccount(name) {
    if (!name) return;
    switchTab('detail');
    const monthSel = $('#detail-month');
    const catSel = $('#detail-cat');
    const acctSel = $('#detail-acct');
    const kwEl = $('#detail-kw');
    if (monthSel) monthSel.value = '__all';
    if (catSel) catSel.value = '__all';
    if (kwEl) kwEl.value = '';
    if (acctSel) {
      // 正常情況選項一定在（提醒跟下拉是同一批交易算出來的）。
      // 萬一資料剛好在這中間重整過，補一個進去，至少不要讓他點了沒反應。
      if (!hasOption(acctSel, name)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = '⚠ ' + name;
        acctSel.appendChild(opt);
      }
      acctSel.value = name;
    }
    detailFilter.touched = true;
    applyDetailFilter();
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

  /* ---------- 從網址預填記帳內容 ----------
   * Discord 的定期定額提醒會附一個這樣的連結：
   *   ...?tab=record&amount=13304&item=車貸&cat=貸款&acct=玉山
   * 點下去就直接開記帳頁、內容填好，按送出就完成。
   *
   * 兩條規矩：
   *  1. **只預填，絕不自動送出。** 帳是錢的事，一定要人按下去才算數。
   *  2. 只填一次。之後資料重新整理時不可以再蓋一遍，
   *     不然他改到一半被洗掉會很火大。
   */
  var recordPrefill = null;      // 開頁時解析出來的參數
  var prefillApplied = false;    // 填過了沒

  function readRecordPrefill() {
    try {
      var params = new URLSearchParams(window.location.search);
      var data = {
        amount: params.get('amount') || '',
        item: params.get('item') || '',
        category: params.get('cat') || '',
        account: params.get('acct') || ''
      };
      // 四個都空就當作沒有要預填
      if (!data.amount && !data.item && !data.category && !data.account) return null;
      return data;
    } catch (e) {
      return null;  // 舊瀏覽器不支援 URLSearchParams 就算了，不要讓整個 App 掛掉
    }
  }

  function applyRecordPrefill() {
    if (!recordPrefill || prefillApplied) return;

    // 帳戶與分類是下拉選單，要等選項都生出來才填得進去
    var accountSel = $('#r-account');
    if (recordPrefill.account && (!accountSel || accountSel.options.length === 0)) return;

    var amountEl = $('#r-amount');
    var itemEl = $('#r-item');
    var catSel = $('#r-category');

    if (amountEl && recordPrefill.amount) {
      var amount = Number(recordPrefill.amount);
      if (isFinite(amount) && amount > 0) amountEl.value = amount;
    }
    if (itemEl && recordPrefill.item) itemEl.value = recordPrefill.item;

    // 下拉選單只在「真的有這個選項」時才設，避免設成一個不存在的值變空白
    if (catSel && recordPrefill.category) {
      if (hasOption(catSel, recordPrefill.category)) catSel.value = recordPrefill.category;
    }
    if (accountSel && recordPrefill.account) {
      if (hasOption(accountSel, recordPrefill.account)) accountSel.value = recordPrefill.account;
    }

    prefillApplied = true;

    // 提示他這是帶進來的，要自己確認金額——
    // 電話費、房貸這種每月金額都不一樣，照著送出就記錯了
    setRecordMsg('已幫你填好，確認金額沒問題再按送出。', 'ok');
  }

  function hasOption(selectEl, value) {
    for (var i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].value === value) return true;
    }
    return false;
  }

  function initRecordForm() {
    // 分類下拉
    // 分類下拉分成「支出」「收入」兩群，不要 9 個混在一起滑到眼花
    const catSel = $('#r-category');
    if (catSel) {
      let html = '<optgroup label="支出">';
      EXPENSE_CATEGORIES.forEach(function (c) { html += '<option value="' + c + '">' + c + '</option>'; });
      html += '</optgroup><optgroup label="收入">';
      INCOME_CATEGORIES.forEach(function (c) { html += '<option value="' + c + '">' + c + '</option>'; });
      html += '</optgroup>';
      catSel.innerHTML = html;
    }

    // 常用項目：點一下就把項目填好，順便把上次用的分類與帳戶也帶出來
    const quickEl = $('#r-quick');
    if (quickEl) {
      quickEl.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('.quick-item') : null;
        if (!btn) return;
        const itemEl = $('#r-item');
        if (itemEl) {
          itemEl.value = btn.getAttribute('data-item') || '';
          itemEl.focus();
          applyItemMemory(itemEl.value);
        }
      });
    }

    // 自己打字的情況：離開項目欄時也試著帶出上次的分類與帳戶
    const itemInput = $('#r-item');
    if (itemInput) {
      itemInput.addEventListener('change', function () {
        applyItemMemory(itemInput.value);
      });
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

    // 截圖辨識
    initOcr();
  }

  // ---------- 截圖辨識（OCR）----------
  // Tesseract.js 檔案大（約 11MB），刻意不預先載入，等使用者第一次按辨識才動態載入。
  let ocrLibLoading = null; // 快取「載入函式庫」的 Promise，避免重複載入
  let ocrWorker = null;     // 快取辨識 worker，第二次辨識就不用重建

  function initOcr() {
    const btn = $('#r-ocr-btn');
    const file = $('#r-ocr-file');
    if (!btn || !file) return;

    // 按鈕 → 觸發選圖
    btn.addEventListener('click', function () { file.click(); });

    // 選好圖片 → 開始辨識
    file.addEventListener('change', function () {
      const img = file.files && file.files[0];
      // 使用者按取消，files 會是空的，安靜結束不報錯
      if (!img) return;
      recognizeImage(img);
      // 清掉 value，這樣下次選「同一張」圖也會觸發 change
      file.value = '';
    });
  }

  function setOcrStatus(text, kind) {
    const el = $('#r-ocr-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ocr-status' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  // 動態載入 Tesseract.js（只載一次）
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (ocrLibLoading) return ocrLibLoading;
    ocrLibLoading = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'lib/tesseract/tesseract.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () {
        ocrLibLoading = null; // 失敗要能重試
        reject(new Error('辨識工具載入失敗'));
      };
      document.head.appendChild(s);
    });
    return ocrLibLoading;
  }

  // 取得（或建立）辨識 worker，指向本機自帶的檔案，不連任何外部 CDN
  function getOcrWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    // 只辨識英數字（金額字串），用 eng 語言包最小最快
    return window.Tesseract.createWorker('eng', 1, {
      workerPath: 'lib/tesseract/worker.min.js',
      langPath: 'lib/tesseract/',
      corePath: 'lib/tesseract/'
    }).then(function (w) {
      ocrWorker = w;
      return w;
    });
  }

  function recognizeImage(imgFile) {
    const btn = $('#r-ocr-btn');
    if (btn) lockBtn(btn, true, '辨識中…');
    setOcrStatus('正在載入辨識工具…（第一次比較久）', '');

    loadTesseract()
      .then(function () {
        setOcrStatus('辨識中…請稍候', '');
        return getOcrWorker();
      })
      .then(function (worker) {
        return worker.recognize(imgFile);
      })
      .then(function (result) {
        const text = (result && result.data && result.data.text) ? result.data.text : '';
        applyOcrResult(text);
      })
      .catch(function (err) {
        // 辨識函式庫丟出來的是英文技術訊息，不要直接貼給使用者看。
        // 真的需要查原因時，到瀏覽器的開發者工具看 console 就有完整內容。
        if (window.console && console.warn) console.warn('截圖辨識失敗：', err);
        setOcrStatus('辨識失敗了，請改用手動輸入。（可能是圖片太大，或辨識工具沒載入成功）', 'err');
      })
      .then(function () {
        if (btn) lockBtn(btn, false, '📷 從截圖辨識金額');
      });
  }

  // 從辨識出的文字抓金額與支付帳戶，填進表單
  function applyOcrResult(text) {
    // 抓金額：交給 pure.js 的三層階梯規則（有錢幣符號、有「元」、或有「金額／合計」
    // 這類關鍵字才抓；都沒有就寧可回報抓不到，也不要亂填一個錯數字進去）
    const num = JZPure.parseAmountFromText(text);
    let filledAmount = false;
    if (num !== null) {
      const amtEl = $('#r-amount');
      if (amtEl) { amtEl.value = num; filledAmount = true; }
    }

    // 判斷支付帳戶：關鍵字比對，且該帳戶要真的在下拉清單裡才選
    const lower = text.toLowerCase();
    let matchedAccount = '';
    if (lower.indexOf('money') >= 0) {
      matchedAccount = 'LINE PAY MONEY';
    } else if (lower.indexOf('line pay') >= 0 || text.indexOf('國泰世華') >= 0) {
      matchedAccount = '國泰信用卡CUBE';
    }
    let filledAccount = false;
    if (matchedAccount) {
      const accEl = $('#r-account');
      if (accEl) {
        const has = Array.prototype.some.call(accEl.options, function (o) { return o.value === matchedAccount; });
        if (has) { accEl.value = matchedAccount; filledAccount = true; }
      }
    }

    // 回報結果（金額是重點；抓不到就提醒手動）
    if (filledAmount && filledAccount) {
      setOcrStatus('已帶入金額與支付帳戶，請確認並補上項目與分類。', 'ok');
    } else if (filledAmount) {
      setOcrStatus('已帶入金額，請確認並選擇支付帳戶、補上項目與分類。', 'ok');
    } else {
      setOcrStatus('沒辨識到金額，麻煩手動輸入。', 'err');
    }
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

    const payload = { item: item, amount: amount, category: category, account: account, note: note };

    // 確定離線就不用白跑一趟，直接排隊等有網路再送
    if (JZ.isDefinitelyOffline()) {
      queueAndClear(payload, item + ' ' + money(amount), function () {
        $('#r-amount').value = '';
        $('#r-item').value = '';
        $('#r-note').value = '';
      });
      JZ.pushRecentItem(item);
      return;
    }

    const btn = $('#r-submit');
    lockBtn(btn, true, '送出中…');
    setRecordMsg('送出中…', '');

    JZ.submitEntry(payload)
      .then(function (res) {
        lockBtn(btn, false, '送出記帳');
        if (res.ok) {
          setRecordMsg(res.message, 'ok');
          JZ.pushRecentItem(item);
          celebrate($('#r-amount'));
          $('#r-amount').value = '';
          $('#r-item').value = '';
          $('#r-note').value = '';
          reloadAfterWrite();
          return;
        }
        if (res.timeout) {
          // 逾時不代表沒記成功，先幫他重抓一次，切到明細馬上就能確認。
          // ⚠️ 這種狀況絕對不可以排隊補送，會變成兩筆一樣的帳。
          setRecordMsg(res.message, 'err');
          reloadAfterWrite();
          return;
        }
        // 送出當下才發現連不上（例如剛好斷線）：這種情況瀏覽器沒把請求送出去，排隊是安全的
        if (JZ.isDefinitelyOffline()) {
          queueAndClear(payload, item + ' ' + money(amount), function () {
            $('#r-amount').value = '';
            $('#r-item').value = '';
            $('#r-note').value = '';
          });
          JZ.pushRecentItem(item);
          return;
        }
        setRecordMsg(res.message, 'err');
      });
  }

  /* ---------- 離線排隊 ----------
   * 只有「瀏覽器明確說現在離線」才會走到這裡。
   * 逾時那種「可能寫進去了」的狀況一律不排隊——補送會變成兩筆一樣的帳，
   * 而重複的帳要他自己打開試算表找出來刪掉，比漏一筆麻煩得多。
   */
  function queueAndClear(payload, label, clearFn) {
    const count = JZ.pushQueue(payload, label);
    if (clearFn) clearFn();
    celebrate($('#r-amount'));
    setRecordMsg(
      '現在沒有網路，這筆帳先存在手機裡了（目前 ' + count + ' 筆等著送）。' +
      '等連上網路會自動補送，你不用做什麼。',
      'ok'
    );
    renderQueueBanner();
  }

  /** 把「還有幾筆等著送」顯示在記帳頁上方，不要讓他以為帳不見了 */
  function renderQueueBanner() {
    const el = $('#queue-banner');
    if (!el) return;
    const count = JZ.queueCount();
    if (count === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.textContent = '有 ' + count + ' 筆帳還沒送出去（沒網路時存下來的），連上網路會自動補送。';
  }

  /** 試著把排隊中的帳補送出去 */
  function tryFlushQueue(showWhenEmpty) {
    if (JZ.queueCount() === 0) {
      renderQueueBanner();
      return;
    }
    if (JZ.isDefinitelyOffline()) {
      renderQueueBanner();
      return;
    }

    JZ.flushQueue().then(function (res) {
      renderQueueBanner();
      if (res.sent === 0 && res.uncertain === 0) {
        if (showWhenEmpty && res.remaining > 0) {
          setRecordMsg('還有 ' + res.remaining + ' 筆送不出去，等網路好一點會再試。', 'err');
        }
        return;
      }

      let text = '';
      if (res.sent > 0) text += '補送成功 ' + res.sent + ' 筆。';
      if (res.uncertain > 0) {
        // 這種一定要講清楚，不能默默吞掉
        text += '有 ' + res.uncertain + ' 筆等太久沒回應，可能已經記進去了，' +
                '請到「明細」確認一下，沒有的話再自己補記。';
      }
      if (res.remaining > 0) text += '還有 ' + res.remaining + ' 筆等著送。';

      setRecordMsg(text, res.uncertain > 0 ? 'err' : 'ok');
      if (res.sent > 0) reloadAfterWrite();
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
          celebrate($('#t-amount'));
          $('#t-amount').value = '';
          reloadAfterWrite();
        } else if (res.timeout) {
          reloadAfterWrite();
        }
      });
  }

  function lockBtn(btn, locked, text) {
    if (!btn) return;
    btn.disabled = locked;
    if (text) btn.textContent = text;
  }

  // 記帳成功後立刻重新抓一次資料，讓餘額與明細馬上跟著更新。
  // （設定頁那個「兩次更新至少隔 60 秒」的限制只擋那顆按鈕，這條路徑不受影響）
  function reloadAfterWrite() {
    loadData();
  }

  /* ---------- 切回 App 就自動更新 ----------
   * 你大部分的帳是用 iPhone 捷徑記的。記完切回這個 App 的時候，它通常還停在
   * 記憶體裡沒有重新載入（iOS 的 PWA 就是這樣），畫面上還是你離開前抓的那份資料——
   * 剛記的那筆不會出現，看起來就像沒記到，得把 App 整個關掉再開才會更新。
   *
   * 所以只要視窗重新變成可見，就自動重抓一次。
   *
   * 為什麼可以放心在背景抓：fetchAll 不會拋錯，連不上時會回上次的快取資料，
   * 所以最壞的情況只是畫面維持原樣，不會跳錯誤訊息嚇人。
   *
   * 最小間隔 10 秒：避免在 App 裡切來切去（例如跳去看通知再回來）時連續打 API。
   */
  var RETURN_REFRESH_MIN_GAP_MS = 10 * 1000;
  var lastReturnRefresh = 0;

  function initRefreshOnReturn() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (!JZ.hasReadConfig()) return;   // 還沒設定連線就不用白跑

      const now = Date.now();
      if (now - lastReturnRefresh < RETURN_REFRESH_MIN_GAP_MS) return;
      lastReturnRefresh = now;

      loadData();
      // 順便試一次補送：剛才在背景的時候網路可能已經恢復了
      tryFlushQueue(false);
    });
  }

  /* 點「資料時間」就重新抓一次。
   * 設定頁那顆「重新整理資料」還在（而且有 60 秒節流），這裡是給「人在其他頁、
   * 想馬上看到剛記的帳」用的捷徑，不受那個節流影響。 */
  var manualRefreshing = false;

  function initDataTimeRefresh() {
    const btn = $('#data-time');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // 還沒設定連線的話，點了直接帶他去設定頁，不要按了沒反應
      if (!JZ.hasReadConfig()) { switchTab('settings'); return; }
      if (manualRefreshing) return;

      manualRefreshing = true;
      btn.textContent = '更新中…';
      loadData().then(function () {
        manualRefreshing = false;
        // 時間文字由 renderDataTimeBanner 寫回去，這裡不用自己設
      });
    });
  }

  /* ---------- 整理名稱（批次改名） ----------
   *
   * 解決「同一件事打成兩個名字」——例如收入項目裡「超勤」與「超勤加班」，
   * 報表上被拆成兩列，看起來像兩件事。
   *
   * 下拉刻意**依筆數由少到多排**：打錯字的版本通常只出現一兩次，
   * 這樣它會自動浮到最上面，不用自己在幾十個名稱裡找。
   */
  function refreshRenameOptions() {
    const sel = $('#rn-from');
    if (!sel) return;

    const d = state.data;
    const field = $('#rn-field') ? $('#rn-field').value : 'item';
    const key = (field === 'account') ? 'account' : 'item';

    const counts = {};
    (d && d.transactions ? d.transactions : []).forEach(function (t) {
      const name = ((t && t[key]) || '').trim();
      if (!name) return;
      counts[name] = (counts[name] || 0) + 1;
    });

    const names = Object.keys(counts).sort(function (a, b) {
      if (counts[a] !== counts[b]) return counts[a] - counts[b];   // 少的在前
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    if (names.length === 0) {
      sel.innerHTML = '<option value="">（還沒有資料）</option>';
      return;
    }

    const keep = sel.value;
    let html = '';
    names.forEach(function (n) {
      html += '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '（' + counts[n] + ' 筆）</option>';
    });
    sel.innerHTML = html;
    if (keep && names.indexOf(keep) >= 0) sel.value = keep;
  }

  function setRenameMsg(text, kind) {
    const el = $('#rn-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'record-msg' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  function initRename() {
    const fieldSel = $('#rn-field');
    if (fieldSel) fieldSel.addEventListener('change', function () {
      refreshRenameOptions();
      setRenameMsg('', '');
    });

    const go = $('#rn-go');
    if (!go) return;

    go.addEventListener('click', function () {
      const field = $('#rn-field').value || 'item';
      const from = $('#rn-from').value || '';
      const to = ($('#rn-to').value || '').trim();

      if (!from) { setRenameMsg('請先選一個要改的名稱。', 'err'); return; }
      if (!to) { setRenameMsg('請填要改成什麼名稱。', 'err'); return; }
      if (from === to) { setRenameMsg('新舊名稱一樣，不用改。', 'err'); return; }

      lockBtn(go, true, '改名中…');
      setRenameMsg('改名中…', '');

      JZ.renameField(field, from, to).then(function (res) {
        lockBtn(go, false, '開始改');
        if (res.ok) {
          setRenameMsg(res.message, 'ok');
          $('#rn-to').value = '';
          loadData();      // 重抓，讓下拉與報表跟著更新
          return;
        }
        if (res.timeout) {
          // 改名重送是安全的（第二次會找不到舊名稱、改 0 筆），但還是先讓他自己確認
          setRenameMsg(res.message + '（重新抓一次資料，請確認是不是已經改好了）', 'err');
          loadData();
          return;
        }
        setRenameMsg(res.message, 'err');
      });
    });
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
      loadData();
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
      loadData().then(function (res) {
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

  // ---------- 深淺色主題 ----------

  /*
   * 把目前的主題套到畫面上。做三件事：
   *  1. 換 <html data-theme="light|dark">，整份 CSS 的顏色會跟著換
   *  2. 通知圖表換一套配色，並把已經畫出來的圖重畫（Chart.js 不會自己換色）
   *  3. 更新設定頁那三顆按鈕誰被選中
   */
  function refreshTheme() {
    const dark = JZ.shouldUseDark();
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');

    if (window.JZCharts && JZCharts.applyTheme) {
      JZCharts.applyTheme(dark);
      // 只有正在看圖表頁時才需要當場重畫；其他頁切過去時本來就會重畫一次
      if ($('#tab-charts') && $('#tab-charts').classList.contains('active')) {
        renderCharts();
      }
    }

    const pref = JZ.getTheme();
    $all('.theme-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme-pref') === pref);
    });
  }

  function initTheme() {
    $all('.theme-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        JZ.saveTheme(btn.getAttribute('data-theme-pref'));
        refreshTheme();
      });
    });

    // 選「跟隨手機」時，使用者在手機設定裡切深色，畫面要當場跟著變
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = function () { if (JZ.getTheme() === 'auto') refreshTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange); // 舊版 Safari 只認得這個寫法
    } catch (e) { /* 瀏覽器不支援就算了，不影響使用 */ }

    refreshTheme();
  }

  // ---------- 抓資料主流程 ----------

  // 抓一次最新資料，然後把整個畫面重畫。
  // 抓失敗不用另外跳訊息——上方的離線橫幅本來就會顯示「現在看的是哪個時間的舊資料」。
  function loadData() {
    return JZ.fetchAll().then(function (res) {
      if (res.data) {
        state.data = res.data;
        state.fromCache = res.fromCache;
      }
      // 全畫面重繪
      renderAll();
      return res;
    });
  }

  function renderAll() {
    renderDataTimeBanner();
    renderOverview();
    renderBudget();
    renderForecast();
    initDetailFilters();
    applyDetailFilter();
    refreshRecordAccounts();
    applyRecordPrefill();   // 要排在帳戶下拉生出來之後
    renderQuickItems();
    refreshRenameOptions();
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

  // 讀網址上的 ?tab=xxx，決定一打開要停在哪一頁；沒指定或名字不認得就回傳空字串
  function startTabFromUrl() {
    const VALID = ['overview', 'charts', 'detail', 'record', 'settings'];
    try {
      const m = window.location.search.match(/[?&]tab=([a-z]+)/i);
      const name = m ? m[1].toLowerCase() : '';
      return VALID.indexOf(name) >= 0 ? name : '';
    } catch (e) {
      return '';
    }
  }

  function init() {
    // 版本號
    $all('.app-version').forEach(function (el) { el.textContent = APP_VERSION; });

    // 開頁時先把網址帶來的預填參數讀起來。
    // 真正填進表單要等資料載好、下拉選單生出來之後（renderAll 裡會做）。
    recordPrefill = readRecordPrefill();

    // 離線排隊：一連上網路就自動補送，不用他做任何事
    renderQueueBanner();
    window.addEventListener('online', function () { tryFlushQueue(false); });
    // 開 App 的時候也試一次（可能是上次沒網路存下來的）
    tryFlushQueue(false);

    // 用捷徑記完帳切回來，畫面要是新的；標題列的「資料時間」也可以點一下手動更新
    initRefreshOnReturn();
    initDataTimeRefresh();

    // 分類走勢的切換：只重畫這一張圖，不用整頁重新渲染
    const trendSel = $('#trend-cat');
    if (trendSel) {
      trendSel.addEventListener('change', function () {
        trendCategory = trendSel.value;
        renderTrend();
      });
    }

    // 底部導覽
    $all('.nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });

    // 明細篩選事件：使用者一動就記下來（touched），
    // 這樣跑去記一筆帳、資料重新載入回來時，篩選條件不會被重設掉
    ['#detail-month', '#detail-cat', '#detail-acct'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.addEventListener('change', function () {
        detailFilter.touched = true;
        applyDetailFilter();
      });
    });
    // 搜尋框：等手停下來 250 毫秒再開始搜，不要每打一個字就整份重畫。
    // 中文輸入法選字過程會觸發很多次，這個延遲特別有感。
    if ($('#detail-kw')) {
      let kwTimer = null;
      $('#detail-kw').addEventListener('input', function () {
        if (kwTimer) clearTimeout(kwTimer);
        kwTimer = setTimeout(function () {
          detailFilter.touched = true;
          applyDetailFilter();
        }, 250);
      });
    }
    if ($('#detail-more')) $('#detail-more').addEventListener('click', loadMoreDetail);

    // 明細卡片右下角的「⋯」：打開修改／刪除面板。
    // 綁在容器上（事件委派），因為卡片每次篩選都會重新畫
    const detailListEl = $('#detail-list');
    if (detailListEl) {
      detailListEl.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('.tx-more') : null;
        if (!btn) return;
        const rowNo = Number(btn.getAttribute('data-row')) || 0;
        if (!rowNo) return;
        // 從目前的篩選結果裡找那一筆，不另外存一份，免得兩邊不同步
        const found = (detailState.rows || []).filter(function (t) { return Number(t.row) === rowNo; })[0];
        if (found) openEditModal(found);
      });
    }
    initEditModal();

    // 總覽的專案標籤可以點：點下去跳到明細並自動篩出這個標籤
    const tagListEl = $('#tag-list');
    if (tagListEl) {
      tagListEl.addEventListener('click', function (e) {
        const row = e.target && e.target.closest ? e.target.closest('.tag-row') : null;
        const tag = row ? row.getAttribute('data-tag') : '';
        if (tag) jumpToTag(tag);
      });
    }

    // 「帳戶對不上」提醒裡的名字可以點：跳到明細，列出是哪幾筆。
    // 綁在容器上（事件委派），因為裡面的按鈕每次重新渲染都會換掉
    const warnEl = $('#account-warning');
    if (warnEl) {
      warnEl.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('.link-btn') : null;
        const name = btn ? btn.getAttribute('data-acct') : '';
        if (name) jumpToAccount(name);
      });
    }

    // 收入來源的月份切換：只重畫下面的排行，上面的走勢圖不用動
    const incomeSel = $('#income-month');
    if (incomeSel) {
      incomeSel.addEventListener('change', function () {
        incomeMonth = incomeSel.value;
        renderIncomeList();
      });
    }

    initRecordForm();
    initSettings();
    initRename();
    initTheme();
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
      // 打開 app 直接停在記帳頁，這是最常用的操作；總覽/圖表/明細仍在下方導覽列一鍵可達。
      // 也支援用網址參數指定，例如 index.html?tab=overview 會直接開總覽——
      // 你可以用 Safari 的「加入主畫面」多做一顆圖示，等於自己 DIY 一個捷徑。
      switchTab(startTabFromUrl() || 'record');
      // 有設定就抓一次最新資料
      loadData();
    }

    initServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
