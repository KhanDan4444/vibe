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

router.use(auth, requireGymAccess);

/**
 * GET /api/gym/subscription
 * Returns license state for the logged-in gym owner (used before loading the app shell).
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT name, subscription_status FROM Gyms WHERE id = $1',
      [req.user.gym_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const row = result.rows[0];
    const access = describeGymSubscriptionAccess(row.subscription_status);

    res.json({
      gymName: row.name,
      ...access,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
