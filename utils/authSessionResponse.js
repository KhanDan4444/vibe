/**
 * Shared login/session payload for web (cookie) and mobile (Bearer token).
 */

const db = require('../config/db');

async function buildAuthSessionPayload(user) {
  let subscription = null;
  let branch = null;

  if (user.gym_id) {
    const gymResult = await db.query(
      'SELECT name, subscription_status FROM Gyms WHERE id = $1',
      [user.gym_id]
    );
    if (gymResult.rows.length > 0) {
      const { describeGymSubscriptionAccess } = require('./gymSubscriptionStatus');
      subscription = {
        gymName: gymResult.rows[0].name,
        ...describeGymSubscriptionAccess(gymResult.rows[0].subscription_status),
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
