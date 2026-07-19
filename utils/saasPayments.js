/**
 * SaaS payment helpers scoped to a gym's current subscription term.
 * Term is identified by GymSubscriptions.start_date.
 */

const { formatLocalDate, parseLocalDate, todayLocalString, calendarDateString } = require('./localDate');

function hasPaymentForTermStart(startDate, payments) {
  if (!startDate || !Array.isArray(payments)) return false;
  const termStart = calendarDateString(startDate) || formatLocalDate(parseLocalDate(startDate));
  return payments.some((p) => {
    const coverageStart = p.coverage_start_date ? calendarDateString(p.coverage_start_date) : null;
    if (coverageStart) return coverageStart === termStart;
    const payDate = p.date ? calendarDateString(p.date) : null;
    return payDate && payDate >= termStart;
  });
}

function gymHasPaymentForCurrentTerm(subscription, payments) {
  return hasPaymentForTermStart(subscription?.start_date, payments);
}

function validatePaymentDate(paymentDateStr, termStartDateStr) {
  const paymentDate = calendarDateString(paymentDateStr) || formatLocalDate(parseLocalDate(paymentDateStr));
  const termStart = termStartDateStr
    ? calendarDateString(termStartDateStr) || formatLocalDate(parseLocalDate(termStartDateStr))
    : '';
  const today = todayLocalString();
  if (!paymentDate) {
    return { ok: false, error: 'Invalid payment date.' };
  }
  if (paymentDate > today) {
    return { ok: false, error: 'Payment date cannot be in the future.' };
  }
  if (termStart && paymentDate < termStart) {
    return {
      ok: false,
      error: `Payment date must be on or after the license start (${termStart}) or it will not count toward this term.`,
    };
  }
  return { ok: true };
}

/** @param {string} dateStr @param {number} days */
function addDaysToDateString(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

function minimumRenewStartDate(subscription, isPaidForCurrentTerm) {
  const today = todayLocalString();
  if (!subscription?.end_date || !isPaidForCurrentTerm) {
    return today;
  }
  const dayAfterEnd = addDaysToDateString(subscription.end_date, 1);
  return dayAfterEnd > today ? dayAfterEnd : today;
}

async function queryGymPaidForCurrentTerm(dbOrClient, gymId) {
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM SaaSPayments sp
      JOIN GymSubscriptions gs ON gs.gym_id = sp.gym_id
      WHERE gs.gym_id = $1
        AND (
          sp.coverage_start_date::date = gs.start_date::date
          OR (sp.coverage_start_date IS NULL AND sp.date >= gs.start_date)
        )
    ) AS ok
    `,
    [gymId]
  );
  return Boolean(result.rows[0]?.ok);
}

async function queryHasPaidTermStartingOn(dbOrClient, gymId, termStartDate) {
  const termStart = String(termStartDate).split('T')[0];
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM GymSubscriptions gs
      WHERE gs.gym_id = $1 AND gs.start_date::date = $2::date
        AND EXISTS (
          SELECT 1 FROM SaaSPayments sp
          WHERE sp.gym_id = gs.gym_id
            AND (
              sp.coverage_start_date::date = gs.start_date::date
              OR (sp.coverage_start_date IS NULL AND sp.date >= gs.start_date)
            )
        )
    ) AS ok
    `,
    [gymId, termStart]
  );
  return Boolean(result.rows[0]?.ok);
}

async function queryPaymentExistsOnCalendarDate(dbOrClient, gymId, paymentDateStr) {
  const paymentDate = calendarDateString(paymentDateStr);
  if (!paymentDate) return false;
  const result = await dbOrClient.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM SaaSPayments
      WHERE gym_id = $1 AND date::date = $2::date
    ) AS ok
    `,
    [gymId, paymentDate]
  );
  return Boolean(result.rows[0]?.ok);
}

module.exports = {
  hasPaymentForTermStart,
  gymHasPaymentForCurrentTerm,
  validatePaymentDate,
  calendarDateString,
  minimumRenewStartDate,
  queryGymPaidForCurrentTerm,
  queryHasPaidTermStartingOn,
  queryPaymentExistsOnCalendarDate,
};
