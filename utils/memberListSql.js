const { DUE_SOON_DAYS, MEMBER_STATUS, normalizeMemberStatus } = require('./memberStatus');

/** Member has no payment on or after their current term start_date. */
const MEMBER_UNPAID_SQL = `
  NOT EXISTS (
    SELECT 1 FROM Payments p
    WHERE p.member_id = m.id AND p.gym_id = m.gym_id AND p.date >= m.start_date
  )
`;

const MEMBER_IS_UNPAID_SELECT = `
  (
    NOT EXISTS (
      SELECT 1 FROM Payments p
      WHERE p.member_id = m.id AND p.gym_id = m.gym_id AND p.date >= m.start_date
    )
  ) AS is_unpaid
`;

function statusWhereSql(status) {
  const normalized = normalizeMemberStatus(status);
  if (normalized === MEMBER_STATUS.EXPIRED) {
    return 'm.end_date < CURRENT_DATE';
  }
  if (normalized === MEMBER_STATUS.DUE_SOON) {
    return `m.end_date >= CURRENT_DATE AND m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'`;
  }
  if (normalized === MEMBER_STATUS.ACTIVE) {
    // Paid + valid term — unpaid members are not "active" for ops/reporting.
    return `m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days' AND NOT (${MEMBER_UNPAID_SQL})`;
  }
  return null;
}

/**
 * @param {object} query - req.query
 * @param {number} startParamIndex - first $N index after gym_id ($1)
 */
function buildMemberListFilters(query, startParamIndex = 2) {
  const conditions = [];
  const params = [];
  let idx = startParamIndex;

  const { status, filter, search } = query;

  if (search && String(search).trim()) {
    conditions.push(`(m.name ILIKE $${idx} OR COALESCE(m.phone, '') ILIKE $${idx})`);
    params.push(`%${String(search).trim()}%`);
    idx += 1;
  }

  if (filter === 'unpaid') {
    conditions.push(`(${MEMBER_UNPAID_SQL})`);
  } else if (filter === 'due_soon') {
    conditions.push(`(${statusWhereSql(MEMBER_STATUS.DUE_SOON)})`);
  } else if (filter === 'expired') {
    conditions.push(`(${statusWhereSql(MEMBER_STATUS.EXPIRED)})`);
  } else if (status) {
    const statusCondition = statusWhereSql(status);
    if (statusCondition) {
      conditions.push(`(${statusCondition})`);
    } else {
      conditions.push(`LOWER(m.status) = LOWER($${idx})`);
      params.push(normalizeMemberStatus(status));
      idx += 1;
    }
  }

  const whereExtra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  return { whereExtra, params, nextIndex: idx };
}

module.exports = {
  MEMBER_UNPAID_SQL,
  MEMBER_IS_UNPAID_SELECT,
  buildMemberListFilters,
};
