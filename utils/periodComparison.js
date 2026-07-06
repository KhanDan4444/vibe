/**
 * Month-over-month and period comparison helpers.
 */

function computePercentChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) {
    return cur > 0 ? '+100%' : null;
  }
  const change = ((cur - prev) / prev) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

function computeCountDelta(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  const delta = cur - prev;
  if (delta === 0) return 'same as last month';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta} vs last month`;
}

module.exports = {
  computePercentChange,
  computeCountDelta,
};
