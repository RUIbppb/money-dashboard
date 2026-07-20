/*
 * charts.js — 圖表層（製作人Rui / Maker Rui）
 * 用自帶的 Chart.js v4 畫三張圖：本月支出圓餅、資產成長折線、每月收支長條。
 * 配色一律無印風低飽和大地色系，不用 Chart.js 的鮮豔預設色。
 */

const JZCharts = (function () {
  'use strict';

  // 支出分類固定配色（順序對應 app.js 的 EXPENSE_CATEGORIES：食/玩樂/交通/寵物/貸款/其他）
  // 刻意選低飽和柔和色，貼近無印風；辨識度不足的部分由圖表旁的文字清單（金額＋百分比）補強，
  // 不讓「顏色」單獨扛辨識責任。同一分類永遠同一個顏色，不隨資料順序改變。
  const CATEGORY_COLORS = {
    '食': '#8b5050',
    '玩樂': '#bf9f6a',
    '交通': '#3f704b',
    '寵物': '#63b4b8',
    '貸款': '#486491',
    '其他': '#bb95c4'
  };
  const FALLBACK_COLOR = '#9B9186'; // 未預期的分類名稱才會用到
  const LINE_COLOR = '#8C9A88';   // 資產折線（暗綠大地色）
  const INCOME_COLOR = '#9AA48C'; // 收入長條
  const EXPENSE_COLOR = '#B99A8C'; // 支出長條（紅棕大地色）
  const GRID = '#ECE8E1';
  const TEXT = '#6B655C';

  // 圖表全域字型
  if (window.Chart) {
    Chart.defaults.font.family = '"Microsoft JhengHei","微軟正黑體","PingFang TC","Noto Sans TC",sans-serif';
    Chart.defaults.font.size = 13;
    Chart.defaults.color = TEXT;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.padding = 12;
  }

  // 保存已建立的圖表實例，重畫前先銷毀避免重疊
  const instances = {};

  function destroy(id) {
    if (instances[id]) {
      instances[id].destroy();
      delete instances[id];
    }
  }

  function fmt(n) {
    return (n || 0).toLocaleString('zh-TW');
  }

  // 圓餅圖：本月各支出分類
  // catTotals: { 食: 1200, 玩樂: 300, ... }
  function drawCategoryPie(canvasId, catTotals) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    // 固定順序排列（跟 CATEGORY_COLORS 一致），讓每個月的相鄰分類都一樣，配色驗證才有意義
    const order = Object.keys(CATEGORY_COLORS);
    const labels = Object.keys(catTotals).sort(function (a, b) {
      return order.indexOf(a) - order.indexOf(b);
    });
    const values = labels.map(function (k) { return catTotals[k]; });

    const legendEl = document.getElementById(canvasId + '-legend');

    if (labels.length === 0) {
      showEmpty(canvasId, '本月沒有支出紀錄');
      if (legendEl) legendEl.innerHTML = '';
      return;
    }
    hideEmpty(canvasId);

    instances[canvasId] = new Chart(el, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map(function (cat) { return CATEGORY_COLORS[cat] || FALLBACK_COLOR; }),
          borderColor: '#FFFFFF',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          // 底下改用我們自己的文字清單顯示金額與百分比，比 Chart.js 內建圖例更清楚，這裡關掉
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ' ' + ctx.label + '：' + fmt(ctx.parsed) + ' 元';
              }
            }
          }
        }
      }
    });

    // 文字清單：色塊＋分類＋金額＋百分比，由高到低排序，顏色不夠明顯時靠文字補足辨識度
    if (legendEl) {
      const total = values.reduce(function (a, b) { return a + b; }, 0) || 1;
      const rows = labels.map(function (cat, i) { return { cat: cat, val: values[i] }; })
        .sort(function (a, b) { return b.val - a.val; });
      legendEl.innerHTML = rows.map(function (r) {
        const pct = Math.round((r.val / total) * 100);
        const color = CATEGORY_COLORS[r.cat] || FALLBACK_COLOR;
        return '<div class="pie-legend-row">' +
          '<span class="pie-legend-dot" style="background:' + color + '"></span>' +
          '<span class="pie-legend-name">' + r.cat + '</span>' +
          '<span class="pie-legend-pct">' + pct + '%</span>' +
          '<span class="pie-legend-amt">' + fmt(r.val) + ' 元</span>' +
          '</div>';
      }).join('');
    }
  }

  // 折線圖：資產成長
  // monthly: [{month, assets}, ...]（由舊到新）
  function drawAssetLine(canvasId, monthly) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    if (!monthly || monthly.length === 0) {
      showEmpty(canvasId, '沒有每月資料');
      return;
    }
    hideEmpty(canvasId);

    instances[canvasId] = new Chart(el, {
      type: 'line',
      data: {
        labels: monthly.map(function (m) { return m.month; }),
        datasets: [{
          label: '總資產',
          data: monthly.map(function (m) { return m.assets; }),
          borderColor: LINE_COLOR,
          backgroundColor: 'rgba(140,154,136,0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: LINE_COLOR,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) { return ' 資產：' + fmt(ctx.parsed.y) + ' 元'; }
            }
          }
        },
        scales: {
          x: { grid: { color: GRID } },
          y: {
            grid: { color: GRID },
            ticks: { callback: function (v) { return fmt(v); } }
          }
        }
      }
    });
  }

  // 長條圖：每月收入 vs 支出並排
  function drawMonthlyBar(canvasId, monthly) {
    destroy(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    if (!monthly || monthly.length === 0) {
      showEmpty(canvasId, '沒有每月資料');
      return;
    }
    hideEmpty(canvasId);

    instances[canvasId] = new Chart(el, {
      type: 'bar',
      data: {
        labels: monthly.map(function (m) { return m.month; }),
        datasets: [
          {
            label: '收入',
            data: monthly.map(function (m) { return m.income; }),
            backgroundColor: INCOME_COLOR,
            borderRadius: 3
          },
          {
            label: '支出',
            data: monthly.map(function (m) { return m.expense; }),
            backgroundColor: EXPENSE_COLOR,
            borderRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: function (ctx) { return ' ' + ctx.dataset.label + '：' + fmt(ctx.parsed.y) + ' 元'; }
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            grid: { color: GRID },
            ticks: { callback: function (v) { return fmt(v); } }
          }
        }
      }
    });
  }

  // 圖表沒資料時，在 canvas 旁邊的提示元素顯示文字
  function showEmpty(canvasId, text) {
    const el = document.getElementById(canvasId);
    if (el) el.style.display = 'none';
    const hint = document.getElementById(canvasId + '-empty');
    if (hint) {
      hint.textContent = text;
      hint.style.display = 'block';
    }
  }

  function hideEmpty(canvasId) {
    const el = document.getElementById(canvasId);
    if (el) el.style.display = 'block';
    const hint = document.getElementById(canvasId + '-empty');
    if (hint) hint.style.display = 'none';
  }

  return {
    drawCategoryPie: drawCategoryPie,
    drawAssetLine: drawAssetLine,
    drawMonthlyBar: drawMonthlyBar
  };
})();

// const 宣告不會自動掛上 window，這行讓 app.js 的 window.JZCharts 檢查找得到它
window.JZCharts = JZCharts;
