/**
 * @file requireGymAccess.js
 * @description Restricts routes to gym owners or staff with a tenant gym_id.
 */

const { hasGymPortalAccess, isGymStaff } = require('../utils/roles');

module.exports = function requireGymAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access denied. Not authenticated.' });
  }
  if (!hasGymPortalAccess(req.user.role)) {
    return res.status(403).json({ error: 'Access denied. Gym accounts only.' });
  }
  if (!req.user.gym_id) {
    return res.status(403).json({ error: 'No gym associated with this account.' });
  }
  if (isGymStaff(req.user.role) && !req.user.branch_id) {
    return res.status(403).json({
      error: 'Your account is not assigned to a branch. Contact your gym owner.',
      code: 'STAFF_NO_BRANCH',
    });
  }
  return next();
};
