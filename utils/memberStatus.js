const { parseLocalDate, todayLocalString } = require('./localDate');

/**
 * Member status values (lowercase; enforced by schema CHECK constraints).
 */
const MEMBER_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  DUE_SOON: 'due soon',
};

/** Days before end_date when a member is flagged due soon. */
const DUE_SOON_DAYS = 3;

/** @param {string | undefined} status */
function normalizeMemberStatus(status) {
  if (!status || typeof status !== 'string') return status;
  const lower = status.trim().toLowerCase();
  if (lower === 'due soon' || lower === 'due_soon') return MEMBER_STATUS.DUE_SOON;
  return lower;
}

/** Derive canonical status from an end date (source of truth for new/updated members). */
function deriveMemberStatusFromEndDate(endDateStr) {
  const today = parseLocalDate(todayLocalString());
  const end = parseLocalDate(endDateStr);
  const diffDays = Math.round((end - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return MEMBER_STATUS.EXPIRED;
  if (diffDays <= DUE_SOON_DAYS) return MEMBER_STATUS.DUE_SOON;
  return MEMBER_STATUS.ACTIVE;
}

/** SQL fragment: recompute status from end_date vs CURRENT_DATE. */
const MEMBER_STATUS_CASE_SQL = `
  CASE
    WHEN end_date < CURRENT_DATE THEN 'expired'
    WHEN end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days' THEN 'due soon'
    ELSE 'active'
  END
`;

module.exports = {
  MEMBER_STATUS,
  DUE_SOON_DAYS,
  normalizeMemberStatus,
  deriveMemberStatusFromEndDate,
  MEMBER_STATUS_CASE_SQL,
};
