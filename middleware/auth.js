/**
 * @file middleware/auth.js
 * @description JWT authentication with database re-validation (role, gym_id, password stamp).
 */

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { passwordChangedStamp } = require('../utils/authTokens');

module.exports = async function auth(req, res, next) {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access denied. Invalid token format.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token.' });
  }

  if (!decoded?.id) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  try {
    const result = await db.query(
      `SELECT id, name, email, username, role, gym_id, branch_id, password_changed_at, is_active FROM Users WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    }

    const user = result.rows[0];

    if (user.is_active === false) {
      return res.status(403).json({ error: 'This account has been disabled. Contact your gym owner.' });
    }
    const currentPwc = passwordChangedStamp(user);

    if (decoded.pwc === undefined || decoded.pwc !== currentPwc) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (decoded.role !== user.role) {
      return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    }

    const tokenGymId = decoded.gym_id ?? null;
    const userGymId = user.gym_id ?? null;
    if (tokenGymId !== userGymId) {
      return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username ?? null,
      role: user.role,
      gym_id: user.gym_id,
      branch_id: user.branch_id ?? null,
    };

    return next();
  } catch (error) {
    console.error('[auth] User verification failed:', error.message);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
};
