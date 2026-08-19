const { DUE_SOON_DAYS, MEMBER_STATUS, normalizeMemberStatus } = require('./memberStatus');

/** Membership payments only — trainer fees do not mark a term as paid. */
const MEMBER_TERM_PAYMENT_EXISTS_SQL = `
  EXISTS (
    SELECT 1 FROM Payments p
    WHERE p.member_id = m.id AND p.gym_id = m.gym_id AND p.date >= m.start_date
      AND COALESCE(p.source, 'collect') <> 'trainer'
  )
`;

/** Member has no membership payment on or after their current term start_date. */
const MEMBER_UNPAID_SQL = `
  NOT ${MEMBER_TERM_PAYMENT_EXISTS_SQL}
`;

const MEMBER_IS_UNPAID_SELECT = `
  (
    ${MEMBER_UNPAID_SQL}
  ) AS is_unpaid
`;

/** Live roster only — archived members keep payment rows for reports. */
const MEMBER_LIVE_SQL = ' AND m.deleted_at IS NULL';
const MEMBER_LIVE_BARE_SQL = ' AND deleted_at IS NULL';

const MEMBER_LIST_FROM = `
  FROM Members m
  LEFT JOIN Plans p ON p.id = m.plan_id
  LEFT JOIN Branches b ON b.id = m.branch_id
  LEFT JOIN Trainers tr ON tr.id = m.trainer_id
`;

const MEMBER_LIST_SELECT = `m.*, p.name AS plan_name, b.name AS branch_name, tr.name AS trainer_name, ${MEMBER_IS_UNPAID_SELECT}`;

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
 * @param {{ includeArchived?: boolean }} [options]
 */
function buildMemberListFilters(query, startParamIndex = 2, options = {}) {
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

  const liveSql = options.includeArchived ? '' : MEMBER_LIVE_SQL;
  const whereExtra = `${liveSql}${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`;
  return { whereExtra, params, nextIndex: idx };
}

/**
 * Members present in [start, end]: overlapping roster dates, or a payment in range.
 * Archived members are included when they were still on the roster (or paid) in the window.
 * @param {{ start?: string|null, end?: string|null }} period
 * @param {unknown[]} params
 * @param {number} startIdx
 */
function appendMemberPeriodPresence(period, params, startIdx) {
  const start = period?.start || null;
  const end = period?.end || null;
  if (!start && !end) {
    return { sql: '', nextIndex: startIdx };
  }

  const parts = [];
  let idx = startIdx;
  const overlap = [];
  if (end) {
    overlap.push(`m.start_date <= $${idx}`);
    params.push(end);
    idx += 1;
  }
  if (start) {
    overlap.push(`COALESCE(m.deleted_at::date, 'infinity'::date) >= $${idx}`);
    params.push(start);
    idx += 1;
  }
  if (overlap.length) {
    parts.push(`(${overlap.join(' AND ')})`);
  }

  const pay = ['pay.member_id = m.id', 'pay.gym_id = m.gym_id'];
  if (start) {
    pay.push(`pay.date >= $${idx}`);
    params.push(start);
    idx += 1;
  }
  if (end) {
    pay.push(`pay.date <= $${idx}`);
    params.push(end);
    idx += 1;
  }
  parts.push(`EXISTS (SELECT 1 FROM Payments pay WHERE ${pay.join(' AND ')})`);

  return { sql: ` AND (${parts.join(' OR ')})`, nextIndex: idx };
}

module.exports = {
  MEMBER_UNPAID_SQL,
  MEMBER_IS_UNPAID_SELECT,
  MEMBER_LIVE_SQL,
  MEMBER_LIVE_BARE_SQL,
  MEMBER_LIST_FROM,
  MEMBER_LIST_SELECT,
  buildMemberListFilters,
  appendMemberPeriodPresence,
};
