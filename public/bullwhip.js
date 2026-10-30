/* Shared by player, admin and report. Histories contain settled weeks only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BeerMetrics = api;
})(globalThis, function () {
  'use strict';
  const MAX_WEEKS = 26;
  const MIN_WEEKS = 5;
  const labels = ['未放大', '轻度放大', '中度放大', '高度放大', '极高放大'];
  function level(ratio) {
    const index = ratio <= 1 ? 0 : ratio <= 2 ? 1 : ratio <= 4 ? 2 : ratio <= 8 ? 3 : 4;
    return { level: index, label: labels[index], cls: 'bw-' + index };
  }
  function formatRatio(ratio) {
    if (!Number.isFinite(ratio)) return '—';
    for (let digits = 2; digits <= 12; digits++) {
      const value = ratio.toFixed(digits);
      if (level(Number(value)).level === level(ratio).level && (ratio === 0 || Number(value) > 0)) return value + '×';
    }
    return String(ratio) + '×';
  }
  function statistics(values) {
    const sum = values.reduce((total, v) => total + v, 0);
    const mean = sum / values.length;
    // Integer box quantities keep this numerator exact, including classification boundaries.
    const varianceNumerator = values.length * values.reduce((total, v) => total + v * v, 0) - sum * sum;
    const variance = varianceNumerator / values.length ** 2;
    return { mean, variance, varianceNumerator, stdDev: Math.sqrt(variance), cv: mean > 0 ? Math.sqrt(variance) / mean : null,
      min: Math.min(...values), max: Math.max(...values) };
  }
  function calculate(orderHistory, demandHistory, weeks, historyStartWeek) {
    const result = { version: 1, weeks, ratio: null, status: 'incomplete', label: '数据不完整', cls: 'bw-neutral',
      orders: null, demand: null, note: '' };
    if (!Number.isInteger(weeks) || weeks < 0 || weeks > MAX_WEEKS) return result;
    if (weeks === 0) return { ...result, status: 'collecting', label: '样本积累中：0/5 周' };
    // Do not compress missing entries, infer legacy demand or align a replacement's history to week 1.
    const valid = values => Array.isArray(values) && values.length >= weeks &&
      Array.from(values.slice(0, weeks)).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (historyStartWeek !== 1 || !valid(orderHistory) || !valid(demandHistory)) return result;
    result.orders = statistics(orderHistory.slice(0, weeks));
    result.demand = statistics(demandHistory.slice(0, weeks));
    result.note = result.orders.max === 0 ? '未发生订货' : '';
    if (weeks < MIN_WEEKS) return { ...result, status: 'collecting', label: '样本积累中：' + weeks + '/5 周' };
    if (result.demand.variance === 0) {
      return result.orders.variance === 0
        ? { ...result, status: 'constant', label: '需求与订货均无波动' }
        : { ...result, status: 'constant-demand', label: '恒定需求下出现订单波动', cls: 'bw-2' };
    }
    const ratio = result.orders.varianceNumerator / result.demand.varianceNumerator;
    if (!Number.isFinite(ratio)) return { ...result, orders: null, demand: null };
    return { ...result, status: 'valid', ratio, ...level(ratio) };
  }
  function completedWeeks(week) {
    return Number.isInteger(week) ? Math.max(0, Math.min(MAX_WEEKS, week - 1)) : 0;
  }
  function forUser(user, weeks) {
    return calculate(user && user.orderHistory, user && user.demandHistory, weeks, user && user.historyStartWeek);
  }
  function summarize(users, weeks) {
    const results = Array.from({ length: 4 }, (_, i) => forUser((users || [])[i], weeks));
    const valid = results.filter(m => m.status === 'valid');
    const max = valid.length ? valid.reduce((a, b) => a.ratio >= b.ratio ? a : b) : null;
    return { results, max, validCount: valid.length,
      maxIndices: max ? results.flatMap((m, i) => m.ratio === max.ratio ? [i] : []) : [],
      warningCount: results.filter(m => m.status === 'constant-demand').length,
      incompleteCount: results.filter(m => m.status === 'incomplete').length };
  }
  function text(metric) {
    return (metric.ratio === null ? metric.label : formatRatio(metric.ratio) + ' · ' + metric.label) +
      (metric.note ? ' · ' + metric.note : '');
  }
  function badge(metric) {
    // All text is derived from numeric inputs and fixed labels, never user-provided HTML.
    return '<span class="bw-badge ' + metric.cls + '">' + text(metric) + '</span>';
  }
  function details(metric) {
    const range = metric.weeks > 0 ? '已统计：第 1—' + metric.weeks + ' 周' : '尚未完成结算';
    let html = '<div class="bw-detail">' + range + '</div>';
    if (metric.orders) {
      html += '<div class="bw-detail">订货标准差 ' + metric.orders.stdDev.toFixed(2) +
        ' 箱 · 需求标准差 ' + metric.demand.stdDev.toFixed(2) + ' 箱<br>订货相对波动 CV：' +
        (metric.orders.cv === null ? '—（均值为零）' : (metric.orders.cv * 100).toFixed(1) + '%') +
        ' · 订货范围 ' + metric.orders.min + '—' + metric.orders.max + ' 箱</div>';
    }
    if (metric.status === 'incomplete') html = '<div class="bw-detail">第 1—' + metric.weeks + ' 周需求或订货记录缺失，无法完整统计。</div>';
    return html;
  }
  function coverage(summary) {
    return '可计算 ' + summary.validCount + '/4 个角色' +
      (summary.warningCount ? '；恒定需求下有订单波动：' + summary.warningCount + ' 个角色' : '') +
      (summary.incompleteCount ? '；数据不完整：' + summary.incompleteCount + ' 个角色' : '');
  }
  return { calculate, forUser, summarize, level, formatRatio, completedWeeks, text, badge, details, coverage };
});
