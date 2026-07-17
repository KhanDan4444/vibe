/**
 * Payment helpers scoped to a member's current membership term.
 * A term is identified by start_date — renew/enroll updates start_date, so
 * payments on or after start_date belong to the current term.
 */

const { formatLocalDate, parseLocalDate, todayLocalString } = require('./localDate');
const {
  validatePaymentDate: validatePaymentDateShared,
  normalizeIso,
} = require('../shared/paymentDateRules');

/** Normalize DB date/timestamp to YYYY-MM-DD in local calendar. */
function calendarDateString(dateStr) {
  if (!dateStr) return '';
  const fromShared = normalizeIso(dateStr);
  if (fromShared) return fromShared;
  return formatLocalDate(parseLocalDate(dateStr));
}

/** Validate payment date against term start and today (canonical shared rules). */
function validatePaymentDate(paymentDateStr, termStartDateStr) {
  return validatePaymentDateShared(
    calendarDateString(paymentDateStr) || paymentDateStr,
    calendarDateString(termStartDateStr) || termStartDateStr,
    todayLocalString()
  );
}

/**
 * @param {string} startDate - Member start_date (YYYY-MM-DD)
 * @param {Array<{ date: string }>} payments - Payment rows for this member
 * @returns {boolean}
 */
function hasPaymentForTermStart(startDate, payments) {
  if (!startDate || !Array.isArray(payments)) return false;
  const termStart = String(startDate).split('T')[0];
  return payments.some((p) => p.date && String(p.date).split('T')[0] >= termStart);
}

/** SQL EXISTS — matches MEMBER_UNPAID_SQL / list is_unpaid. */
async function queryMemberPaidForCurrentTerm(dbOrClient, memberId, gymId) {
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM Payments p
      JOIN Members m ON m.id = p.member_id AND m.gym_id = p.gym_id
      WHERE m.id = $1 AND m.gym_id = $2 AND p.date >= m.start_date
    ) AS ok
    `,
    [memberId, gymId]
  );
  return Boolean(result.rows[0]?.ok);
}

/** SQL EXISTS — payment on or after a specific term start date. */
async function queryHasPaymentForTermStart(dbOrClient, memberId, gymId, termStartDate) {
  const termStart = String(termStartDate).split('T')[0];
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM Payments
      WHERE member_id = $1 AND gym_id = $2 AND date >= $3::date
    ) AS ok
    `,
    [memberId, gymId, termStart]
  );
  return Boolean(result.rows[0]?.ok);
}

/** SQL EXISTS — payment already recorded on this calendar date. */
async function queryPaymentExistsOnCalendarDate(dbOrClient, memberId, gymId, paymentDateStr) {
  const paymentDate = calendarDateString(paymentDateStr);
  if (!paymentDate) return false;
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM Payments
      WHERE member_id = $1 AND gym_id = $2 AND date::date = $3::date
    ) AS ok
    `,
    [memberId, gymId, paymentDate]
  );
  return Boolean(result.rows[0]?.ok);
}

/** SQL EXISTS — plan-change payment already on this calendar date (blocks duplicate change-plan, not enroll/renew). */
async function queryChangePlanPaymentExistsOnCalendarDate(dbOrClient, memberId, gymId, paymentDateStr) {
  const paymentDate = calendarDateString(paymentDateStr);
  if (!paymentDate) return false;
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM Payments
      WHERE member_id = $1 AND gym_id = $2 AND date::date = $3::date
        AND source = 'change_plan'
    ) AS ok
    `,
    [memberId, gymId, paymentDate]
  );
  return Boolean(result.rows[0]?.ok);
}

/** SQL EXISTS — member already has a paid term beginning on this date. */
async function queryHasPaidTermStartingOn(dbOrClient, memberId, gymId, termStartDate) {
  const termStart = String(termStartDate).split('T')[0];
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM Members m
      WHERE m.id = $1 AND m.gym_id = $2 AND m.start_date::date = $3::date
        AND EXISTS (
          SELECT 1 FROM Payments p
          WHERE p.member_id = m.id AND p.gym_id = m.gym_id AND p.date >= m.start_date
        )
    ) AS ok
    `,
    [memberId, gymId, termStart]
  );
  return Boolean(result.rows[0]?.ok);
}

/**
 * @param {{ start_date: string }} member
 * @param {Array<{ date: string }>} memberPayments - Payments for this member only
 */
function memberHasPaymentForCurrentTerm(member, memberPayments) {
  return hasPaymentForTermStart(member?.start_date, memberPayments);
}

/** @param {string} dateStr @param {number} days */
function addDaysToDateString(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

/**
 * Earliest allowed start_date for a renewal when the current term is paid.
 * Paid-through members renew after end_date; lapsed terms may start today.
 */
function minimumRenewStartDate(member, isPaidForCurrentTerm) {
  const today = todayLocalString();
  if (!member?.end_date || !isPaidForCurrentTerm) {
    return today;
  }
  const dayAfterEnd = addDaysToDateString(member.end_date, 1);
  return dayAfterEnd > today ? dayAfterEnd : today;
}

module.exports = {
  hasPaymentForTermStart,
  memberHasPaymentForCurrentTerm,
  queryMemberPaidForCurrentTerm,
  queryHasPaymentForTermStart,
  queryHasPaidTermStartingOn,
  queryPaymentExistsOnCalendarDate,
  queryChangePlanPaymentExistsOnCalendarDate,
  addDaysToDateString,
  minimumRenewStartDate,
  calendarDateString,
  validatePaymentDate,
};
