/*
 * pure.js — 純算式模組（製作人Rui / Maker Rui）
 *
 * 這支檔案只放「不碰畫面、只做計算」的函式。
 * 好處是可以用 Node 直接自動測試（畫面邏輯沒辦法這樣測），
 * 執行方式：從 記帳app 資料夾下 `node 測試\test_pure.js`
 *
 * 【鐵律】
 *  1. 這裡面絕對不可以出現 document、window、fetch、localStorage 這些瀏覽器專屬的東西。
 *  2. 也不可以出現 new Date()。「今天是哪個月」一律由外面傳進來，
 *     否則測試結果會隨著執行當天的日期跑掉，測了等於沒測。
 *  3. 任何參數傳 null / undefined 進來都不可以讓程式爆掉。
 */

var JZPure = (function () {
  'use strict';

  // ============================================================
  // 共用小工具
  // ============================================================

  /** 把值轉成數字；空白、看不懂的東西一律當 0（絕不回傳 NaN） */
  function toNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    var num = Number(String(value).replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
  }

  /** 四捨五入到小數第 2 位，避免電腦浮點數的微小誤差 */
  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /** 安全地取字串（null/undefined 都回空字串） */
  function safeStr(value) {
    return (value === null || value === undefined) ? '' : String(value);
  }

  // ============================================================
  // 一、parseAmountFromText —— 從截圖辨識出的文字裡找金額
  // ============================================================
  /*
   * 三層階梯，由嚴到寬，先中先用：
   *   第 1 層　有錢幣符號　　 $1,234 / NT$1,234 / ＄1,234 / NTD 1,234
   *   第 2 層　數字後面接「元」1,234 元 / 890元
   *   第 3 層　關鍵字後面的數字 金額 / 合計 / 總計 / Total / Amount
   *
   * ★刻意「沒有第 4 層」★
   *   RUI 明確決定不做「純數字兜底」——畫面上沒有錢幣符號、沒有「元」、
   *   也沒有關鍵字時，一律回 null。設計哲學是「寧可少抓，不要亂填」：
   *   抓不到頂多多打幾個字，亂填一個錯金額可能會不小心就送出去。
   */

  var AMOUNT_MIN = 0;        // 必須大於 0
  var AMOUNT_MAX = 1000000;  // 必須小於一百萬（一次消費不會破百萬，順便擋掉 16 位卡號）

  // 第 3 層的關鍵字（英文不分大小寫）
  var AMOUNT_KEYWORDS = ['付款金額', '消費金額', '交易金額', '金額', '合計', '總計', 'Total', 'Amount'];

  // 關鍵字後面往下找數字的範圍（截圖常常是關鍵字一行、金額在下一行，所以要能跨行）
  var KEYWORD_WINDOW = 40;

  /** 把「1,234.00」這種字串轉成整數 1234（小數無條件捨去），失敗回 null */
  function toAmountInt(rawDigits) {
    var cleaned = String(rawDigits).replace(/,/g, '');
    var num = parseFloat(cleaned);
    if (isNaN(num)) return null;
    var intValue = Math.floor(num);
    if (intValue <= AMOUNT_MIN || intValue >= AMOUNT_MAX) return null;
    return intValue;
  }

  /** 這個數字看起來像日期或時間的一部分嗎？（緊鄰著 : / - 而且旁邊也是數字） */
  function looksLikeDateOrTime(text, start, end) {
    var before = text.charAt(start - 1);
    var beforeBefore = text.charAt(start - 2);
    var after = text.charAt(end);
    var afterAfter = text.charAt(end + 1);
    if ((before === ':' || before === '/' || before === '-') && /[0-9]/.test(beforeBefore)) return true;
    if ((after === ':' || after === '/' || after === '-') && /[0-9]/.test(afterAfter)) return true;
    return false;
  }

  /*
   * 這個數字是卡號、帳號之類的識別碼嗎？兩種情況都要擋：
   *   1. 前面是遮罩符號，例如「**** 1234」
   *   2. 前面緊接著「卡號」「末四碼」這類字眼，例如「卡號末四碼1234」
   *
   * ⚠️ 第 2 種只看「緊貼在數字前面」那幾個字，不能往前掃一大段。
   *    否則像「消費金額 卡號末四碼1234 580」這種，後面真正的金額 580
   *    也會因為前面某處出現過「卡號」而被一起誤殺。
   */
  function looksLikeMaskedCard(text, start) {
    // 往前跳過空白，找第一個非空白字元
    var i = start - 1;
    while (i >= 0 && /\s/.test(text.charAt(i))) i--;
    if (i < 0) return false;

    var ch = text.charAt(i);
    if (ch === '*' || ch === '＊' || ch === '•' || ch === 'x' || ch === 'X') return true;

    // 只取緊貼著的最後 6 個字來看，而且必須「以」這些字眼結尾
    var lookback = text.slice(Math.max(0, i - 5), i + 1);
    return /(卡號|帳號|末四碼|後四碼|末4碼|後4碼|尾號)$/.test(lookback);
  }

  /** 這個數字後面緊接著百分比符號嗎？ */
  function looksLikePercent(text, end) {
    var i = end;
    while (i < text.length && text.charAt(i) === ' ') i++;
    return text.charAt(i) === '%';
  }

  /** 沒有逗號也沒有小數的四位數，而且開頭是 19 或 20 —— 很可能是年份 */
  function looksLikeYear(rawDigits) {
    return /^(19|20)[0-9]{2}$/.test(String(rawDigits));
  }

  function parseAmountFromText(text) {
    if (typeof text !== 'string' || text === '') return null;

    var i, m, found;

    // ---- 第 1 層：有錢幣符號 ----
    // NTD 要排在前面，否則 NT 後面接 D 的情況會漏掉
    var moneyRe = /(?:NTD|NT\s*[$＄]|[$＄])\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi;
    while ((m = moneyRe.exec(text)) !== null) {
      found = toAmountInt(m[1]);
      if (found !== null) return found;
    }

    // ---- 第 2 層：數字後面接「元」----
    var yuanRe = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*元/g;
    while ((m = yuanRe.exec(text)) !== null) {
      found = toAmountInt(m[1]);
      if (found !== null) return found;
    }

    // ---- 第 3 層：關鍵字後面的數字 ----
    var lowerText = text.toLowerCase();
    for (i = 0; i < AMOUNT_KEYWORDS.length; i++) {
      var keyword = AMOUNT_KEYWORDS[i].toLowerCase();
      var from = 0;
      var at;
      while ((at = lowerText.indexOf(keyword, from)) !== -1) {
        var windowStart = at + keyword.length;
        var segment = text.slice(windowStart, windowStart + KEYWORD_WINDOW);
        var candidate = pickNumberFromSegment(text, windowStart, segment);
        if (candidate !== null) return candidate;
        from = at + keyword.length;
      }
    }

    return null;
  }

  /*
   * 在關鍵字後面那一小段文字裡找第一個「像金額」的數字。
   * offset 是這段文字在原文裡的起始位置，用來檢查前後文（日期、卡號、百分比）。
   */
  function pickNumberFromSegment(fullText, offset, segment) {
    var numRe = /[0-9][0-9,]*(?:\.[0-9]+)?/g;
    var m;
    while ((m = numRe.exec(segment)) !== null) {
      var absStart = offset + m.index;
      var absEnd = absStart + m[0].length;
      if (looksLikeDateOrTime(fullText, absStart, absEnd)) continue;
      if (looksLikeMaskedCard(fullText, absStart)) continue;
      if (looksLikePercent(fullText, absEnd)) continue;
      if (looksLikeYear(m[0])) continue;
      var value = toAmountInt(m[0]);
      if (value !== null) return value;
    }
    return null;
  }

  // ============================================================
  // 二、computeAccountMismatch —— 抓出「支付帳戶名稱打錯字」造成的缺口
  // ============================================================
  /*
   * 原理（白話）：
   *   accounts 裡每個帳戶的 balance，只算得到「名字對得上帳戶名單」的那些帳；
   *   monthly 最後一筆的 assets，則是拿全部流水帳算出來的（不管帳戶名對不對）。
   *   所以「assets 減掉全部 balance 加總」剩下的差額，
   *   就是名字打錯的那幾筆造成的缺口。初始金額兩邊一樣，會自己抵銷掉。
   *
   * 另外再多做一步：直接掃過流水帳，把「帳戶名不在名單裡」的挑出來，
   * 這樣就能直接告訴使用者是哪個名字打錯、幾筆、多少錢。
   */

  var MONEY_TYPES = ['收入', '支出', '轉入', '轉出'];
  var MISMATCH_TOLERANCE = 0.01; // 差額在一分錢以內視為相等（浮點數誤差）

  function computeAccountMismatch(accounts, monthly, transactions) {
    var empty = { hasIssue: false, diff: 0, unknownAccounts: [] };

    if (!accounts || !accounts.length) return empty;
    if (!monthly || !monthly.length) return empty;

    // 帳戶餘額加總
    var balanceTotal = 0;
    var known = {};
    var i;
    for (i = 0; i < accounts.length; i++) {
      var acc = accounts[i] || {};
      balanceTotal += toNumber(acc.balance);
      known[safeStr(acc.name)] = true;
    }

    // 最後一個月的總資產
    var lastMonth = monthly[monthly.length - 1] || {};
    var assets = toNumber(lastMonth.assets);

    var diff = round2(assets - balanceTotal);

    // 掃出名字不在名單裡的帳戶
    var unknownMap = {};
    if (transactions && transactions.length) {
      for (i = 0; i < transactions.length; i++) {
        var tx = transactions[i] || {};
        var type = safeStr(tx.type).trim();
        if (MONEY_TYPES.indexOf(type) < 0) continue;
        var name = safeStr(tx.account).trim();
        if (name === '') continue;
        if (known[name]) continue;
        if (!unknownMap[name]) unknownMap[name] = { name: name, count: 0, total: 0 };
        unknownMap[name].count += 1;
        unknownMap[name].total += Math.abs(toNumber(tx.amount));
      }
    }

    var unknownAccounts = [];
    for (var key in unknownMap) {
      if (unknownMap.hasOwnProperty(key)) {
        unknownMap[key].total = round2(unknownMap[key].total);
        unknownAccounts.push(unknownMap[key]);
      }
    }
    // 金額大到小；金額一樣就照名稱排，讓結果穩定
    unknownAccounts.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    var hasIssue = (Math.abs(diff) > MISMATCH_TOLERANCE) || (unknownAccounts.length > 0);

    return { hasIssue: hasIssue, diff: diff, unknownAccounts: unknownAccounts };
  }

  // ============================================================
  // 三、filterTransactions —— 明細頁的篩選
  // ============================================================
  /*
   * filter = { month, cat, kw }
   *   month / cat 用 '__all' 代表不篩
   *   kw 是關鍵字，會同時比對「項目」和「備註」，不分大小寫
   *
   * 月份一律取 time 字串的前 7 碼（time 本來就是台北時間，
   * 絕對不可以再用 new Date() 換算一次，那會在跨日跨月時出錯）。
   */
  function filterTransactions(transactions, filter) {
    if (!transactions || !transactions.length) return [];

    var f = filter || {};
    var month = f.month || '__all';
    var cat = f.cat || '__all';
    var kw = safeStr(f.kw).trim().toLowerCase();

    var result = [];
    for (var i = 0; i < transactions.length; i++) {
      var tx = transactions[i] || {};

      if (month !== '__all' && safeStr(tx.time).slice(0, 7) !== month) continue;
      if (cat !== '__all' && safeStr(tx.category) !== cat) continue;
      if (kw) {
        var hay = (safeStr(tx.item) + ' ' + safeStr(tx.note)).toLowerCase();
        if (hay.indexOf(kw) < 0) continue;
      }
      result.push(tx);
    }
    return result;
  }

  // ============================================================
  // 四、summarize —— 算筆數與合計
  // ============================================================
  /*
   * 回傳 { count, income, expense, transfer }
   * count 是全部筆數（不分收支類型）。
   * 轉帳（轉入＋轉出）另外單獨算，不混進收入或支出——
   * 因為那是「錢從左口袋到右口袋」，跟收支是不同性質的事。
   */
  function summarize(rows) {
    var out = { count: 0, income: 0, expense: 0, transfer: 0 };
    if (!rows || !rows.length) return out;

    for (var i = 0; i < rows.length; i++) {
      var tx = rows[i] || {};
      var amount = Math.abs(toNumber(tx.amount));
      var type = safeStr(tx.type).trim();

      out.count += 1;
      if (type === '收入') out.income += amount;
      else if (type === '支出') out.expense += amount;
      else if (type === '轉入' || type === '轉出') out.transfer += amount;
    }

    out.income = round2(out.income);
    out.expense = round2(out.expense);
    out.transfer = round2(out.transfer);
    return out;
  }

  // ============================================================
  // 五、topItems —— 統計最常用的項目名稱（給「常用項目一鍵填入」用）
  // ============================================================
  /*
   * opts = { untilMonth: '2026-09', months: 3, limit: 10 }
   *   untilMonth 是「統計到哪個月為止」，一定要由外面傳進來（見檔案開頭鐵律 2）
   *   沒給 untilMonth 就不做月份篩選，統計全部
   *
   * 只統計「支出」和「收入」，轉帳不算——轉帳的項目通常是「資金調度」，
   * 放進常用按鈕沒有意義。
   */

  /** 給 '2026-01'，回傳上一個月 '2025-12' */
  function prevMonthKey(monthKey) {
    var parts = String(monthKey).split('-');
    var year = Number(parts[0]);
    var month = Number(parts[1]) - 1;
    if (month < 1) { year -= 1; month = 12; }
    return year + '-' + (month < 10 ? '0' + month : String(month));
  }

  function topItems(transactions, opts) {
    if (!transactions || !transactions.length) return [];

    var o = opts || {};
    var months = (typeof o.months === 'number' && o.months > 0) ? o.months : 3;
    var limit = (typeof o.limit === 'number' && o.limit > 0) ? o.limit : 10;
    var untilMonth = o.untilMonth;

    // 算出「可以列入統計」的月份清單（含當月往回推）
    var allowed = null;
    if (untilMonth) {
      allowed = {};
      var cursor = untilMonth;
      for (var k = 0; k < months; k++) {
        allowed[cursor] = true;
        cursor = prevMonthKey(cursor);
      }
    }

    var counter = {};
    for (var i = 0; i < transactions.length; i++) {
      var tx = transactions[i] || {};
      var type = safeStr(tx.type).trim();
      if (type !== '支出' && type !== '收入') continue;

      if (allowed) {
        var m = safeStr(tx.time).slice(0, 7);
        if (!allowed[m]) continue;
      }

      var item = safeStr(tx.item).trim();
      if (item === '') continue;

      counter[item] = (counter[item] || 0) + 1;
    }

    var list = [];
    for (var name in counter) {
      if (counter.hasOwnProperty(name)) list.push({ name: name, n: counter[name] });
    }
    // 次數多到少；次數一樣就照名稱排，讓結果穩定、可以被測試驗證
    list.sort(function (a, b) {
      if (b.n !== a.n) return b.n - a.n;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    var out = [];
    for (var j = 0; j < list.length && j < limit; j++) out.push(list[j].name);
    return out;
  }

  // ============================================================
  // 對外公開的介面
  // ============================================================
  return {
    parseAmountFromText: parseAmountFromText,
    computeAccountMismatch: computeAccountMismatch,
    filterTransactions: filterTransactions,
    summarize: summarize,
    topItems: topItems,
    // 下面兩個是小工具，畫面層偶爾也用得到
    toNumber: toNumber,
    round2: round2
  };
})();

// 這行讓 Node 的測試腳本 require 得到它；瀏覽器裡沒有 module，不會執行
if (typeof module !== 'undefined' && module.exports) { module.exports = JZPure; }
