/**
 * @file paymentQuerySql.js
 * @description Parameterized WHERE builders for owner member payments and admin SaaS payments.
 */

/**
 * @param {object} period - from parsePeriodQuery
 * @param {string} tableAlias - e.g. 'p'
 * @param {string[]} conditions - mutable conditions array
 * @param {unknown[]} params - mutable params array
 * @param {number} startIdx - next $N index
 * @returns {number} next placeholder index
 */
function appendPaymentPeriodConditions(period, tableAlias, conditions, params, startIdx) {
  let idx = startIdx;
  if (period?.start) {
    conditions.push(`${tableAlias}.date >= $${idx}`);
    params.push(period.start);
    idx += 1;
  }
  if (period?.end) {
    conditions.push(`${tableAlias}.date <= $${idx}`);
    params.push(period.end);
    idx += 1;
  }
  return idx;
}

/**
 * Owner gym: Payments joined to Members (fixed gym_id).
 * @param {object} query - req.query (search, method)
 * @param {object} period - parsePeriodQuery result
 * @param {number} gymId - tenant gym id
 */
function buildOwnerPaymentWhere(query, period, gymId, branchId = null) {
  const conditions = ['p.gym_id = $1'];
  const params = [gymId];
  let idx = 2;
  if (branchId) {
    conditions.push(`m.branch_id = $${idx}`);
    params.push(branchId);
    idx += 1;
  }
  idx = appendPaymentPeriodConditions(period, 'p', conditions, params, idx);

  const { search, method } = query;
  if (search && String(search).trim()) {
    conditions.push(`m.name ILIKE $${idx}`);
    params.push(`%${String(search).trim()}%`);
    idx += 1;
  }
  if (method && method !== 'All') {
    conditions.push(`p.method = $${idx}`);
    params.push(method);
    idx += 1;
  }

  return { whereClause: conditions.join(' AND '), params, nextIndex: idx };
}

/**
 * Platform admin: SaaSPayments joined to Gyms.
 * @param {object} query - req.query (search, gym_id)
 * @param {object} period - parsePeriodQuery result
 */
function buildAdminSaaSPaymentWhere(query, period) {
  const conditions = ['1=1'];
  const params = [];
  let idx = appendPaymentPeriodConditions(period, 'p', conditions, params, 1);

  const { search, gym_id: gymIdFilter } = query;
  if (search && String(search).trim()) {
    conditions.push(`g.name ILIKE $${idx}`);
    params.push(`%${String(search).trim()}%`);
    idx += 1;
  }
  if (gymIdFilter) {
    conditions.push(`g.id = $${idx}`);
    params.push(parseInt(gymIdFilter, 10));
    idx += 1;
  }

  return { whereClause: conditions.join(' AND '), params, nextIndex: idx };
}

module.exports = {
  appendPaymentPeriodConditions,
  buildOwnerPaymentWhere,
  buildAdminSaaSPaymentWhere,
};
