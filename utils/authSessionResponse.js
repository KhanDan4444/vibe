/**
 * Shared login/session payload for web (cookie) and mobile (Bearer token).
 */

const db = require('../config/db');

async function buildAuthSessionPayload(user) {
  let subscription = null;
  let branch = null;

  if (user.gym_id) {
    const gymResult = await db.query(
      `
      SELECT g.name, g.subscription_status, gs.plan, gs.saas_plan_id, gs.start_date, gs.end_date,
             sp.duration AS saas_plan_duration
      FROM Gyms g
      LEFT JOIN GymSubscriptions gs ON gs.gym_id = g.id
      LEFT JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
      WHERE g.id = $1
      `,
      [user.gym_id]
    );
    if (gymResult.rows.length > 0) {
      const { describeGymSubscriptionAccess } = require('./gymSubscriptionStatus');
      const {
        isTrialSubscription,
        trialDaysLeft,
        trialDaysUsed,
        trialTotalDays,
      } = require('./gymTrial');
      const { calendarDateString } = require('./localDate');
      const row = gymResult.rows[0];
      const access = describeGymSubscriptionAccess(row.subscription_status);
      const isTrial = isTrialSubscription(row);
      const licenseStartDate = calendarDateString(row.start_date) || null;
      const licenseEndDate = calendarDateString(row.end_date) || null;
      const daysLeft = isTrial && licenseEndDate ? trialDaysLeft(licenseEndDate) : null;
      const daysUsed = isTrial && licenseStartDate ? trialDaysUsed(licenseStartDate) : null;
      const totalDays =
        isTrial && licenseStartDate && licenseEndDate
          ? trialTotalDays(licenseStartDate, licenseEndDate)
          : null;
      const duration = row.saas_plan_duration != null ? parseInt(row.saas_plan_duration, 10) : null;
      subscription = {
        gymName: row.name,
        ...access,
        isTrial,
        trialStartDate: isTrial ? licenseStartDate : undefined,
        trialEndDate: isTrial ? licenseEndDate : undefined,
        trialDaysLeft: isTrial && daysLeft != null && daysLeft >= 0 ? daysLeft : isTrial ? 0 : undefined,
        trialDaysUsed:
          isTrial && daysUsed != null
            ? Math.min(daysUsed, totalDays != null ? totalDays : daysUsed)
            : undefined,
        trialTotalDays: isTrial ? totalDays ?? undefined : undefined,
        licensePlanName: row.plan || null,
        licensePlanDuration: Number.isFinite(duration) && duration > 0 ? duration : null,
        licenseStartDate,
        licenseEndDate,
      };
    }
    if (user.branch_id) {
      const branchResult = await db.query(
        'SELECT id, name FROM Branches WHERE id = $1 AND gym_id = $2',
        [user.branch_id, user.gym_id]
      );
      if (branchResult.rows.length > 0) {
        branch = branchResult.rows[0];
      }
    }
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username ?? null,
      role: user.role,
      gym_id: user.gym_id,
      branch_id: user.branch_id ?? null,
      branch_name: branch?.name ?? null,
    },
    subscription,
  };
}

module.exports = { buildAuthSessionPayload };
