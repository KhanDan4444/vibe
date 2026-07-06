/**
 * Helpers for platform SaaS gym subscriptions (GymSubscriptions + SaaSPlans).
 */

const { formatLocalDate, parseLocalDate, todayLocalString } = require('./localDate');

/**
 * @param {Date | string} startDate
 * @param {number} durationMonths
 * @returns {string} YYYY-MM-DD
 */
function calculateSaasEndDate(startDate, durationMonths) {
  const start = parseLocalDate(startDate);
  const months = parseInt(durationMonths, 10);
  if (Number.isNaN(months) || months < 1) {
    throw new Error('Invalid plan duration.');
  }
  const targetMonth = start.getMonth() + months;
  const targetYear = start.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedTargetMonth = ((targetMonth % 12) + 12) % 12;
  const daysInTargetMonth = new Date(targetYear, normalizedTargetMonth + 1, 0).getDate();
  const nextStart =
    start.getDate() <= daysInTargetMonth
      ? new Date(targetYear, normalizedTargetMonth, start.getDate())
      : new Date(targetYear, normalizedTargetMonth + 1, 1);

  nextStart.setDate(nextStart.getDate() - 1);
  return formatLocalDate(nextStart);
}

/**
 * @param {import('pg').PoolClient | { query: Function }} client
 * @param {number} gymId
 * @param {number} saasPlanId
 * @param {string} [startDateStr] defaults to today
 */
async function assignSaasPlanToGym(client, gymId, saasPlanId, startDateStr, endDateStr) {
  const planResult = await client.query(
    'SELECT id, name, duration, price FROM SaaSPlans WHERE id = $1 AND is_active = true',
    [saasPlanId]
  );
  if (planResult.rows.length === 0) {
    const err = new Error('SaaS plan not found or inactive.');
    err.statusCode = 404;
    throw err;
  }

  const plan = planResult.rows[0];
  const start = startDateStr || todayLocalString();
  const end = endDateStr || calculateSaasEndDate(start, plan.duration);

  await client.query(
    `
    INSERT INTO GymSubscriptions (gym_id, saas_plan_id, plan, start_date, end_date, status)
    VALUES ($1, $2, $3, $4, $5, 'active')
    ON CONFLICT (gym_id) DO UPDATE SET
      saas_plan_id = EXCLUDED.saas_plan_id,
      plan = EXCLUDED.plan,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      status = 'active'
    `,
    [gymId, saasPlanId, plan.name, start, end]
  );

  return { plan, start_date: start, end_date: end };
}

module.exports = { calculateSaasEndDate, assignSaasPlanToGym };
