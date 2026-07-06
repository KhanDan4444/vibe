/**
 * @file requireGymOwner.js
 * @description Restricts routes to authenticated gym owners with a tenant gym_id.
 */

const { isGymOwner } = require('../utils/roles');

module.exports = function requireGymOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access denied. Not authenticated.' });
  }
  if (!isGymOwner(req.user.role)) {
    return res.status(403).json({ error: 'Access denied. Gym owners only.' });
  }
  if (!req.user.gym_id) {
    return res.status(403).json({ error: 'No gym associated with this account.' });
  }
  return next();
};
