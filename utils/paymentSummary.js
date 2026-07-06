/**
 * @file paymentSummary.js
 * @description Aggregates payment rows into totals used by list and report endpoints.
 */

/**
 * @param {Array<{ amount: string|number, method?: string }>} rows
 * @returns {{ total: number, count: number, average: number, byMethod: Record<string, number> }}
 */
function summarizePaymentRows(rows) {
  const total = rows.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  const count = rows.length;
  const byMethod = rows.reduce((acc, p) => {
    const method = p.method || 'Other';
    acc[method] = (acc[method] || 0) + parseFloat(p.amount);
    return acc;
  }, {});
  return {
    total,
    count,
    average: count > 0 ? total / count : 0,
    byMethod,
  };
}

module.exports = { summarizePaymentRows };
