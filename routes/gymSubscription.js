/**
 * @file routes/gymSubscription.js
 * @description Gym owner subscription state (no subscription guard — works when expired).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymAccess = require('../middleware/requireGymAccess');
const { describeGymSubscriptionAccess } = require('../utils/gymSubscriptionStatus');
const { isTrialSubscription, trialDaysLeft } = require('../utils/gymTrial');
const { calendarDateString } = require('../utils/localDate');

router.use(auth, requireGymAccess);

/**
 * GET /api/gym/subscription
 * Returns license state for the logged-in gym owner (used before loading the app shell).
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `
      SELECT g.name, g.subscription_status, gs.plan, gs.saas_plan_id, gs.end_date
      FROM Gyms g
      LEFT JOIN GymSubscriptions gs ON gs.gym_id = g.id
      WHERE g.id = $1
      `,
      [req.user.gym_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const row = result.rows[0];
    const access = describeGymSubscriptionAccess(row.subscription_status);
    const isTrial = isTrialSubscription(row);
    const licenseEndDate = calendarDateString(row.end_date) || null;
    const daysLeft = isTrial && licenseEndDate ? trialDaysLeft(licenseEndDate) : null;

    res.json({
      gymName: row.name,
      ...access,
      isTrial,
      trialEndDate: isTrial ? licenseEndDate : undefined,
      trialDaysLeft: isTrial && daysLeft != null && daysLeft >= 0 ? daysLeft : isTrial ? 0 : undefined,
      licensePlanName: row.plan || null,
      licenseEndDate,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
