/**
 * Blocks mutating requests unless the gym SaaS license is active.
 * Suspended gyms remain read-only; expired gyms never reach this middleware.
 */

const { isPlatformAdmin } = require('../utils/roles');
const { isGymSubscriptionActive } = require('../utils/gymSubscriptionStatus');

module.exports = function requireActiveSubscription(req, res, next) {
  if (isPlatformAdmin(req.user.role)) {
    return next();
  }

  const status = req.gymSubscriptionStatus;
  if (!isGymSubscriptionActive(status)) {
    return res.status(403).json({
      error:
        'Your gym is in read-only mode while suspended. Contact platform admin to restore full access.',
      code: 'SUBSCRIPTION_READ_ONLY',
      subscriptionStatus: status,
    });
  }

  next();
};
