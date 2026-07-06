const { formatLocalDate, parseLocalDate } = require('./localDate');

function addMonthsAsInclusiveEnd(start, months) {
  const targetMonth = start.getMonth() + months;
  const targetYear = start.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedTargetMonth = ((targetMonth % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, normalizedTargetMonth + 1, 0).getDate();
  const nextStart =
    start.getDate() <= daysInTargetMonth
      ? new Date(targetYear, normalizedTargetMonth, start.getDate())
      : new Date(targetYear, normalizedTargetMonth + 1, 1);

  nextStart.setDate(nextStart.getDate() - 1);
  return nextStart;
}

/**
 * Calculates membership end date from start date and plan duration (months).
 */
function calculateEndDate(startDateStr, duration) {
  const start = parseLocalDate(startDateStr);

  const months = parseInt(duration, 10);
  if (!Number.isNaN(months)) {
    return formatLocalDate(addMonthsAsInclusiveEnd(start, months));
  } else if (typeof duration === 'string') {
    const normalized = duration.trim();
    if (normalized === 'Monthly') {
      return formatLocalDate(addMonthsAsInclusiveEnd(start, 1));
    } else if (normalized === 'Quarterly') {
      return formatLocalDate(addMonthsAsInclusiveEnd(start, 3));
    } else if (normalized === '6-month') {
      return formatLocalDate(addMonthsAsInclusiveEnd(start, 6));
    } else if (normalized === 'Yearly') {
      return formatLocalDate(addMonthsAsInclusiveEnd(start, 12));
    }
  }

  return formatLocalDate(start);
}

module.exports = { calculateEndDate };
