/**
 * @file gymListSql.js
 * @description Shared SQL fragments and filters for admin gym list and report queries.
 */

const GYM_UNPAID_SQL = `
  LOWER(g.subscription_status) = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM SaaSPayments sp
    INNER JOIN GymSubscriptions gs2 ON gs2.gym_id = g.id
    WHERE sp.gym_id = g.id
      AND (
        sp.coverage_start_date::date = gs2.start_date::date
        OR (sp.coverage_start_date IS NULL AND sp.date >= gs2.start_date)
      )
  )
`;

const GYM_IS_UNPAID_SELECT = `
  (
    LOWER(g.subscription_status) = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM SaaSPayments sp
      INNER JOIN GymSubscriptions gs2 ON gs2.gym_id = g.id
      WHERE sp.gym_id = g.id
        AND (
          sp.coverage_start_date::date = gs2.start_date::date
          OR (sp.coverage_start_date IS NULL AND sp.date >= gs2.start_date)
        )
    )
  ) AS is_unpaid
`;

const { DUE_SOON_DAYS } = require('./memberStatus');

const GYM_DUE_SOON_SQL = `
  LOWER(g.subscription_status) = 'active'
  AND g.saas_end_date IS NOT NULL
  AND g.saas_end_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days')
`;

const GYM_EXPIRED_OR_SUSPENDED_SQL = `
  LOWER(g.subscription_status) IN ('expired', 'suspended')
`;

const GYM_NEEDS_RENEWAL_SQL = `
  (
    (${GYM_EXPIRED_OR_SUSPENDED_SQL})
    OR (${GYM_DUE_SOON_SQL})
  )
`;

/**
 * @param {object} query - req.query (status, filter, search)
 * @param {number} [startParamIndex=1] - first $N placeholder index
 */
function buildGymListFilters(query, startParamIndex = 1) {
  const conditions = [];
  const params = [];
  let idx = startParamIndex;
  const { status, filter, search } = query;

  if (search && String(search).trim()) {
    conditions.push(`(g.name ILIKE $${idx} OR g.owner_name ILIKE $${idx})`);
    params.push(`%${String(search).trim()}%`);
    idx += 1;
  }

  if (filter === 'unpaid') {
    conditions.push(`(${GYM_UNPAID_SQL})`);
  } else if (filter === 'due_soon') {
    conditions.push(`(${GYM_DUE_SOON_SQL})`);
  } else if (filter === 'expired') {
    conditions.push(`(${GYM_EXPIRED_OR_SUSPENDED_SQL})`);
  } else if (filter === 'needs_renewal') {
    conditions.push(`(${GYM_NEEDS_RENEWAL_SQL})`);
  } else if (status && status !== 'All') {
    conditions.push(`LOWER(g.subscription_status) = LOWER($${idx})`);
    params.push(status);
    idx += 1;
  }

  const whereExtra = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return { whereExtra, params, nextIndex: idx };
}

module.exports = {
  GYM_UNPAID_SQL,
  GYM_IS_UNPAID_SELECT,
  GYM_DUE_SOON_SQL,
  GYM_EXPIRED_OR_SUSPENDED_SQL,
  GYM_NEEDS_RENEWAL_SQL,
  buildGymListFilters,
};
