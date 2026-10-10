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
const { normalizeEthiopianPhone } = require('../utils/phone');
const {
  createGymLinkToken,
  unlinkTelegramGym,
  isTelegramConfigured,
} = require('../utils/telegramLink');

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
        g.telegram_chat_id,
        g.telegram_linked_at,
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
        telegram_chat_id: row.telegram_chat_id || null,
        telegram_linked_at: row.telegram_linked_at || null,
        telegram_linked: Boolean(row.telegram_chat_id),
      },
      user: {
        id: row.user_id,
        name: row.user_name,
        email: row.email,
        username: row.username,
      },
      telegram_configured: isTelegramConfigured(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/gym/profile/telegram/link-token
 * One-time deep link so the gym owner can receive license alerts on Telegram.
 */
router.post('/telegram/link-token', async (req, res, next) => {
  try {
    if (!isTelegramConfigured()) {
      return res.status(503).json({ error: 'Telegram is not configured on this server.' });
    }
    const gymId = req.user.gym_id;
    const gym = await db.query(
      `SELECT id, telegram_chat_id FROM Gyms WHERE id = $1 AND deleted_at IS NULL`,
      [gymId]
    );
    if (!gym.rows[0]) {
      return res.status(404).json({ error: 'Gym not found.' });
    }
    if (gym.rows[0].telegram_chat_id) {
      return res.json({
        already_linked: true,
        telegram_linked: true,
      });
    }
    const token = await createGymLinkToken(gymId);
    res.status(201).json({
      already_linked: false,
      ...token,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/gym/profile/telegram
 * Unlink gym Telegram for license alerts.
 */
router.delete('/telegram', async (req, res, next) => {
  try {
    const result = await unlinkTelegramGym(req.user.gym_id);
    if (!result.ok) {
      if (result.error === 'not_linked') {
        return res.status(400).json({ error: 'Telegram is not linked for this gym.' });
      }
      return res.status(404).json({ error: 'Gym not found.' });
    }
    res.json({ ok: true, gym_id: result.gym.id });
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
    let nextPhone = phone !== undefined ? phone : gym.phone;
    if (nextPhone) {
      nextPhone = normalizeEthiopianPhone(nextPhone) || nextPhone;
    }

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
