/**
 * Platform SaaS plan catalog (what gyms subscribe to when registered).
 */
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const adminCheck = require('../middleware/adminCheck');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  idParamSchema,
  createSaasPlanSchema,
  updateSaasPlanSchema,
} = require('../validation/schemas');

router.use(auth, adminCheck);

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT sp.*,
        (SELECT COUNT(*)::int FROM GymSubscriptions gs WHERE gs.saas_plan_id = sp.id) AS gym_count
       FROM SaaSPlans sp
       ORDER BY sp.price ASC`
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', validateBody(createSaasPlanSchema), async (req, res, next) => {
  const { name, duration, price, description } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO SaaSPlans (name, duration, price, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, duration, price, description || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', validateParams(idParamSchema), validateBody(updateSaasPlanSchema), async (req, res, next) => {
  const { id } = req.params;
  const { name, duration, price, description, is_active } = req.body;

  try {
    const result = await db.query(
      `
      UPDATE SaaSPlans
      SET name = COALESCE($1, name),
          duration = COALESCE($2, duration),
          price = COALESCE($3, price),
          description = COALESCE($4, description),
          is_active = COALESCE($5, is_active)
      WHERE id = $6
      RETURNING *
      `,
      [
        name || null,
        duration ?? null,
        price ?? null,
        description !== undefined ? (description || null) : null,
        is_active !== undefined ? Boolean(is_active) : null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'SaaS plan not found.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  const { id } = req.params;
  try {
    const usage = await db.query(
      'SELECT COUNT(*)::int AS count FROM GymSubscriptions WHERE saas_plan_id = $1',
      [id]
    );
    if (usage.rows[0].count > 0) {
      return res.status(400).json({
        error: `Cannot delete plan: ${usage.rows[0].count} gym(s) are subscribed.`,
      });
    }

    const result = await db.query('DELETE FROM SaaSPlans WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'SaaS plan not found.' });
    }
    res.json({ message: 'SaaS plan deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
