/**
 * @file utils/checkIns.js
 * @description Weekly visit window + check-in validation helpers.
 */

const db = require('../config/db');
const { todayLocalString, checkInOnCalendarDaySql } = require('./localDate');

function startOfWeek(date, weekStartsOn = 'monday') {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun … 6 Sat
  const startDow = weekStartsOn === 'sunday' ? 0 : 1;
  const diff = (day - startDow + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function endOfWeek(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

function toDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function getGymAttendanceSettings(gymId, executor = db) {
  const result = await executor.query(
    `
    SELECT visits_per_week, week_starts_on, one_checkin_per_day, over_limit_policy,
           station_self_checkin
    FROM Gyms
    WHERE id = $1
    `,
    [gymId]
  );
  const row = result.rows[0] || {};
  return {
    visits_per_week: row.visits_per_week == null ? null : Number(row.visits_per_week),
    week_starts_on: row.week_starts_on === 'sunday' ? 'sunday' : 'monday',
    one_checkin_per_day: row.one_checkin_per_day !== false,
    over_limit_policy: row.over_limit_policy === 'warn_allow' ? 'warn_allow' : 'block',
    station_self_checkin: Boolean(row.station_self_checkin),
  };
}

async function countVisitsInRange(memberId, gymId, rangeStart, rangeEnd, executor = db) {
  const result = await executor.query(
    `
    SELECT COUNT(*)::int AS count
    FROM CheckIns
    WHERE member_id = $1
      AND gym_id = $2
      AND checked_in_at >= $3::timestamptz
      AND checked_in_at < $4::timestamptz
    `,
    [memberId, gymId, rangeStart.toISOString(), rangeEnd.toISOString()]
  );
  return result.rows[0]?.count ?? 0;
}

async function hasCheckedInOnLocalDay(memberId, gymId, dayDate, executor = db) {
  const day =
    dayDate == null
      ? todayLocalString()
      : dayDate instanceof Date
        ? toDateString(dayDate)
        : String(dayDate).slice(0, 10);
  const result = await executor.query(
    `
    SELECT 1
    FROM CheckIns
    WHERE member_id = $1
      AND gym_id = $2
      AND ${checkInOnCalendarDaySql('checked_in_at', 3)}
    LIMIT 1
    `,
    [memberId, gymId, day]
  );
  return result.rows.length > 0;
}

/**
 * @returns {{ ok: true, visitsThisWeek, visitsLimit, weekStart, weekEnd } | { ok: false, error, code, visitsThisWeek?, visitsLimit? }}
 */
async function evaluateCheckInEligibility(member, gymId, settings, { force = false } = {}, executor = db) {
  if (member.deleted_at) {
    return { ok: false, error: 'This member is Former and cannot check in.', code: 'MEMBER_FORMER' };
  }

  const endDate = member.end_date ? String(member.end_date).slice(0, 10) : null;
  const today = toDateString(new Date());
  if (endDate && endDate < today) {
    return { ok: false, error: 'Membership is expired. Renew before checking in.', code: 'MEMBER_EXPIRED' };
  }

  const now = new Date();
  const weekStart = startOfWeek(now, settings.week_starts_on);
  const weekEnd = endOfWeek(weekStart);
  const visitsThisWeek = await countVisitsInRange(member.id, gymId, weekStart, weekEnd, executor);
  const visitsLimit = settings.visits_per_week;

  if (settings.one_checkin_per_day) {
    const alreadyToday = await hasCheckedInOnLocalDay(member.id, gymId, now, executor);
    if (alreadyToday) {
      return {
        ok: false,
        error: 'Already checked in today.',
        code: 'ALREADY_TODAY',
        visitsThisWeek,
        visitsLimit,
        weekStart: toDateString(weekStart),
        weekEnd: toDateString(new Date(weekEnd.getTime() - 1)),
      };
    }
  }

  if (visitsLimit != null && visitsThisWeek >= visitsLimit) {
    if (settings.over_limit_policy === 'block' || !force) {
      return {
        ok: false,
        error: `Weekly visit limit reached (${visitsThisWeek}/${visitsLimit}).`,
        code: 'WEEKLY_LIMIT',
        visitsThisWeek,
        visitsLimit,
        weekStart: toDateString(weekStart),
        weekEnd: toDateString(new Date(weekEnd.getTime() - 1)),
        canForce: settings.over_limit_policy === 'warn_allow',
      };
    }
  }

  return {
    ok: true,
    visitsThisWeek,
    visitsLimit,
    weekStart: toDateString(weekStart),
    weekEnd: toDateString(new Date(weekEnd.getTime() - 1)),
  };
}

function mapCheckInRow(row) {
  return {
    id: row.id,
    gym_id: row.gym_id,
    branch_id: row.branch_id,
    member_id: row.member_id,
    checked_in_at: row.checked_in_at,
    checked_in_by_user_id: row.checked_in_by_user_id || null,
    method: row.method || 'search',
    notes: row.notes || null,
    member_name: row.member_name || null,
    member_phone: row.member_phone || null,
    member_photo_url: row.member_photo_url || null,
    branch_name: row.branch_name || null,
    checked_in_by_name: row.checked_in_by_name || null,
  };
}

module.exports = {
  startOfWeek,
  endOfWeek,
  toDateString,
  getGymAttendanceSettings,
  countVisitsInRange,
  hasCheckedInOnLocalDay,
  evaluateCheckInEligibility,
  mapCheckInRow,
};
