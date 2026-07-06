/**
 * @file routes/gymProfile.js
 * @description Gym owner self-service profile (gym name, phone, owner name, login email, username).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const requireGymOwner = require('../middleware/requireGymOwner');
const { ROLES } = require('../utils/roles');
const { validateBody } = require('../middleware/validate');
const { updateOwnerProfileSchema } = require('../validation/schemas');

router.use(auth, requireGymOwner);

router.use(checkSubscription);

/**
 * GET /api/gym/profile
 * Returns gym contact fields and the logged-in owner account.
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `
      SELECT
        g.id AS gym_id,
        g.name AS gym_name,
        g.owner_name,
        g.phone,
        u.id AS user_id,
        u.name AS user_name,
        u.email,
        u.username
      FROM Gyms g
      INNER JOIN Users u ON u.gym_id = g.id AND u.id = $2 AND u.role = $3
      WHERE g.id = $1
      `,
      [req.user.gym_id, req.user.id, ROLES.GYM_OWNER]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gym profile not found.' });
    }

    const row = result.rows[0];
    res.json({
      gym: {
        id: row.gym_id,
        name: row.gym_name,
        owner_name: row.owner_name,
        phone: row.phone,
      },
      user: {
        id: row.user_id,
        name: row.user_name,
        email: row.email,
        username: row.username,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/gym/profile
 * Updates gym details and/or owner login (name, email, username).
 */
router.patch('/', requireActiveSubscription, validateBody(updateOwnerProfileSchema), async (req, res, next) => {
  const { name, gym_name, phone, email, username } = req.body;
  const gymId = req.user.gym_id;
  const userId = req.user.id;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      `SELECT name, owner_name, phone FROM Gyms WHERE id = $1`,
      [gymId]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const gym = current.rows[0];
    const nextGymName = gym_name !== undefined ? gym_name.trim() : gym.name;
    const nextOwnerName = name !== undefined ? name.trim() : gym.owner_name;
    const nextPhone = phone !== undefined ? phone : gym.phone;

    const gymResult = await client.query(
      `
      UPDATE Gyms
      SET name = $1, owner_name = $2, phone = $3
      WHERE id = $4
      RETURNING id, name, owner_name, phone
      `,
      [nextGymName, nextOwnerName, nextPhone, gymId]
    );

    const userSets = [];
    const userParams = [];
    if (name !== undefined) {
      userParams.push(name.trim());
      userSets.push(`name = $${userParams.length}`);
    }
    if (email !== undefined) {
      userParams.push(email.trim());
      userSets.push(`email = $${userParams.length}`);
    }
    if (username !== undefined) {
      userParams.push(username);
      userSets.push(`username = $${userParams.length}`);
    }

    let userRow;
    if (userSets.length > 0) {
      userParams.push(userId, gymId, ROLES.GYM_OWNER);
      const userResult = await client.query(
        `
        UPDATE Users
        SET ${userSets.join(', ')}
        WHERE id = $${userParams.length - 2}
          AND gym_id = $${userParams.length - 1}
          AND role = $${userParams.length}
        RETURNING id, name, email, username
        `,
        userParams
      );
      userRow = userResult.rows[0];
    } else {
      const userResult = await client.query(
        `SELECT id, name, email, username FROM Users WHERE id = $1`,
        [userId]
      );
      userRow = userResult.rows[0];
    }

    await client.query('COMMIT');

    const updatedGym = gymResult.rows[0];
    res.json({
      gym: {
        id: updatedGym.id,
        name: updatedGym.name,
        owner_name: updatedGym.owner_name,
        phone: updatedGym.phone,
      },
      user: userRow,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email or username is already in use.' });
    }
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
