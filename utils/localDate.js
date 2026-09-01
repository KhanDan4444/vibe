/**
 * @file localDate.js
 * Calendar dates for payment/term rules.
 * Never use toISOString() for YYYY-MM-DD — that is UTC and shifts the day.
 *
 * Server "today" uses APP_TIMEZONE (default Africa/Addis_Ababa) so enrolls from
 * Ethiopia are not rejected when the host OS clock is still on the previous UTC day.
 */

const DEFAULT_APP_TIMEZONE = 'Africa/Addis_Ababa';

/** @param {Date} d */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Calendar YYYY-MM-DD in a named IANA timezone.
 * @param {string} [timeZone]
 * @param {Date} [now]
 */
function todayInTimeZone(timeZone = DEFAULT_APP_TIMEZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) return formatLocalDate(now);
  return `${year}-${month}-${day}`;
}

/** Today's date as YYYY-MM-DD in the app business timezone. */
function todayLocalString(now = new Date()) {
  const tz = process.env.APP_TIMEZONE || DEFAULT_APP_TIMEZONE;
  try {
    return todayInTimeZone(tz, now);
  } catch {
    return formatLocalDate(now);
  }
}

/**
 * Normalize DB/client dates to YYYY-MM-DD.
 * node-pg returns DATE as JS Date at UTC midnight — use UTC parts for those.
 * @param {string | Date | null | undefined} dateStr
 */
function calendarDateString(dateStr) {
  if (!dateStr) return '';
  if (dateStr instanceof Date) {
    if (Number.isNaN(dateStr.getTime())) return '';
    const y = dateStr.getUTCFullYear();
    const m = String(dateStr.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dateStr.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(dateStr).split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * Parse YYYY-MM-DD (or ISO prefix) as local midnight.
 * @param {string | Date} dateStr
 * @returns {Date}
 */
function parseLocalDate(dateStr) {
  if (dateStr instanceof Date) {
    return new Date(dateStr.getFullYear(), dateStr.getMonth(), dateStr.getDate());
  }
  const s = String(dateStr).split('T')[0];
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return new Date(dateStr);
  return new Date(y, m - 1, d);
}

function formatDisplayDateFromIso(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('T')[0].split('-');
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y.slice(-2)}`;
}

/**
 * @param {string | Date} dateStr YYYY-MM-DD (or Date)
 * @param {number} days calendar days to add (may be negative)
 * @returns {string} YYYY-MM-DD
 */
function addCalendarDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

function appTimeZone() {
  return process.env.APP_TIMEZONE || DEFAULT_APP_TIMEZONE;
}

/**
 * SQL fragment: a timestamptz column falls on calendar date $dateParamIndex in app TZ.
 * @param {string} column e.g. `c.checked_in_at`
 * @param {number} dateParamIndex 1-based pg placeholder index for YYYY-MM-DD
 * @param {string} [timeZone]
 */
function checkInOnCalendarDaySql(column, dateParamIndex, timeZone) {
  const tz = timeZone || appTimeZone();
  return `(${column} >= ($${dateParamIndex}::text || ' 00:00:00')::timestamp AT TIME ZONE '${tz}' AND ${column} < (($${dateParamIndex}::date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE '${tz}')`;
}

module.exports = {
  DEFAULT_APP_TIMEZONE,
  formatLocalDate,
  todayInTimeZone,
  todayLocalString,
  appTimeZone,
  checkInOnCalendarDaySql,
  calendarDateString,
  parseLocalDate,
  formatDisplayDateFromIso,
  addCalendarDays,
};
