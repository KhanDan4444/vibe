/**
 * @file middleware/subscriptionCheck.js
 * @description SaaS multi-tenant subscription guard.
 * - active: full access
 * - suspended: read-only (writes blocked by requireActiveSubscription)
 * - expired: full lockout (no gym owner API access)
 */

const db = require('../config/db');
const { isPlatformAdmin } = require('../utils/roles');
const {
  normalizeGymSubscriptionStatus,
  gymSubscriptionAllowsRead,
  isGymSubscriptionExpired,
} = require('../utils/gymSubscriptionStatus');

module.exports = async function subscriptionCheck(req, res, next) {
  if (isPlatformAdmin(req.user.role)) {
    return next();
  }

  const gymId = req.user.gym_id;
  if (!gymId) {
    return res.status(400).json({ error: 'No gym associated with this user account.' });
  }

  try {
    const result = await db.query('SELECT subscription_status FROM Gyms WHERE id = $1', [gymId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Associated gym not found.' });
    }

    const status = normalizeGymSubscriptionStatus(result.rows[0].subscription_status);
    req.gymSubscriptionStatus = status;

    if (isGymSubscriptionExpired(status)) {
      return res.status(403).json({
        error: 'Your SaaS license has expired. Contact platform admin to renew and restore access.',
        code: 'SUBSCRIPTION_EXPIRED',
        subscriptionStatus: status,
      });
    }

    if (!gymSubscriptionAllowsRead(status)) {
      return res.status(403).json({
        error: 'Access denied. Your gym subscription is not active.',
        code: 'SUBSCRIPTION_INACTIVE',
        subscriptionStatus: status,
      });
    }

    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database verification failed during subscription check.' });
  }
};
