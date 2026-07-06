/**
 * Date-range filters for payment list/report queries.
 * Supports preset aliases used by the frontend revenue page.
 */

const { formatLocalDate, parseLocalDate } = require('./localDate');

function parsePeriodQuery(query) {
  const { preset, from, to } = query;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (from || to) {
    return {
      start: from || null,
      end: to || null,
      conditions: [],
      params: [],
    };
  }

  let start = null;
  let end = null;

  switch (preset) {
    case 'today': {
      const d = formatLocalDate(today);
      start = d;
      end = d;
      break;
    }
    case 'this_week': {
      const day = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
      start = formatLocalDate(monday);
      end = formatLocalDate(today);
      break;
    }
    case 'this_month': {
      start = formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 1));
      end = formatLocalDate(today);
      break;
    }
    case 'last_month': {
      start = formatLocalDate(new Date(today.getFullYear(), today.getMonth() - 1, 1));
      end = formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 0));
      break;
    }
    case 'last_30_days': {
      const rangeStart = new Date(today);
      rangeStart.setDate(rangeStart.getDate() - 29);
      start = formatLocalDate(rangeStart);
      end = formatLocalDate(today);
      break;
    }
    case 'this_year': {
      start = formatLocalDate(new Date(today.getFullYear(), 0, 1));
      end = formatLocalDate(today);
      break;
    }
    default:
      break;
  }

  return { start, end };
}

/**
 * @param {string} tableAlias - e.g. 'p' for Payments p
 * @param {number} startParamIndex
 */
function buildPaymentDateFilter(period, tableAlias, startParamIndex) {
  const conditions = [];
  const params = [];
  let idx = startParamIndex;

  if (period.start) {
    conditions.push(`${tableAlias}.date >= $${idx}`);
    params.push(period.start);
    idx += 1;
  }
  if (period.end) {
    conditions.push(`${tableAlias}.date <= $${idx}`);
    params.push(period.end);
    idx += 1;
  }

  const clause = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  return { clause, params, nextIndex: idx };
}

module.exports = {
  formatLocalDate,
  parseLocalDate,
  parsePeriodQuery,
  buildPaymentDateFilter,
};
