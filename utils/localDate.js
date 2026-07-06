/**
 * @file localDate.js
 * Calendar dates in the server's local timezone (never use toISOString for YYYY-MM-DD).
 */

/** @param {Date} d */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's date as YYYY-MM-DD (local). */
function todayLocalString() {
  return formatLocalDate(new Date());
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

module.exports = {
  formatLocalDate,
  todayLocalString,
  parseLocalDate,
  formatDisplayDateFromIso,
};
