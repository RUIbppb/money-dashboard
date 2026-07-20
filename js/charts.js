/*
 * charts.js — 圖表層（製作人Rui / Maker Rui）
 * 用自帶的 Chart.js v4 畫三張圖：本月支出圓餅、資產成長折線、每月收支長條。
 * 配色一律無印風低飽和大地色系，不用 Chart.js 的鮮豔預設色。
 */

const JZCharts = (function () {
  'use strict';

  // 無印風大地色盤（圓餅圖各分類用）
  const EARTH = ['#A89A8C', '#9AA48C', '#C8B8A8', '#9A8C7E', '#B8A890', '#8C9A88', '#C2B280', '#B0A0A0'];
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
    const labels = Object.keys(catTotals);
    const values = labels.map(function (k) { return catTotals[k]; });

    if (labels.length === 0) {
      showEmpty(canvasId, '本月沒有支出紀錄');
      return;
    }
    hideEmpty(canvasId);

    instances[canvasId] = new Chart(el, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map(function (_, i) { return EARTH[i % EARTH.length]; }),
          borderColor: '#FFFFFF',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'bottom' },
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
