/**
 * @file middleware/adminCheck.js
 * @description Platform Admin Authorization Middleware.
 * Restricts access to downstream route handlers only to users with the Platform Admin role.
 * Should always be chained after the `auth` middleware.
 * 
 * @module middleware/adminCheck
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function in the stack.
 * @returns {void}
 */
const { isPlatformAdmin } = require('../utils/roles');

module.exports = function (req, res, next) {
  if (req.user && isPlatformAdmin(req.user.role)) {
    return next();
  }
  
  // Return forbidden access for non-admins
  return res.status(403).json({ error: 'Access denied. Platform Admins only.' });
};