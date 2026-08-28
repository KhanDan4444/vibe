/**
 * Free-trial gym subscriptions (self-service signup before admin assigns a paid SaaS plan).
 */

const { TRIAL_PLAN_LABEL } = require('./saasSubscription');
const { calendarDateString, parseLocalDate, todayLocalString } = require('./localDate');

/** Days ahead for admin "trial ending this week" alerts. */
const GYM_TRIAL_ENDING_WEEK_DAYS = 7;

/**
 * @param {{ saas_plan_id?: number|null, plan?: string|null, saas_plan_name?: string|null }} row
 */
function isTrialSubscription(row) {
  if (row?.saas_plan_id != null) return false;
  const planName = row?.plan ?? row?.saas_plan_name ?? '';
  return planName === TRIAL_PLAN_LABEL;
}

/**
 * Whole calendar days until end date (0 = today, negative = past).
 * @param {string | Date | null | undefined} endDate
 * @param {string} [todayStr]
 */
function trialDaysLeft(endDate, todayStr = todayLocalString()) {
  const end = calendarDateString(endDate);
  if (!end) return null;
  const endLocal = parseLocalDate(end);
  const todayLocal = parseLocalDate(todayStr);
  return Math.round((endLocal.getTime() - todayLocal.getTime()) / 86400000);
}

/** SQL on gym list subquery alias `g` (saas_plan_id / saas_plan_name / saas_end_date). */
const GYM_IS_TRIAL_SQL = `
  g.saas_plan_id IS NULL
  AND g.saas_plan_name = '${TRIAL_PLAN_LABEL}'
`;

const GYM_TRIAL_ENDING_SQL = `
  LOWER(g.subscription_status) = 'active'
  AND (${GYM_IS_TRIAL_SQL})
  AND g.saas_end_date IS NOT NULL
  AND g.saas_end_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '${GYM_TRIAL_ENDING_WEEK_DAYS} days')
`;

/** Raw join form for expiry cron queries (alias gs). */
const GS_IS_TRIAL_SQL = `
  gs.saas_plan_id IS NULL
  AND gs.plan = '${TRIAL_PLAN_LABEL}'
`;

module.exports = {
  TRIAL_PLAN_LABEL,
  GYM_TRIAL_ENDING_WEEK_DAYS,
  isTrialSubscription,
  trialDaysLeft,
  GYM_IS_TRIAL_SQL,
  GYM_TRIAL_ENDING_SQL,
  GS_IS_TRIAL_SQL,
};
