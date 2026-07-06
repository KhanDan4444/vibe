/**
 * @file routes/plans.js
 * @description Gym Membership Plans Router.
 * Provides multi-tenant REST endpoints for creating, retrieving, updating, and 
 * deleting gym membership options scoped entirely to the authenticated Gym Owner.
 * Enforces rigid subscription checking to protect structural tenant actions.
 * * @module routes/plans
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  idParamSchema,
  createPlanSchema,
  updatePlanSchema,
} = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');

// Guard: authenticated gym portal users; mutations are owner-only below.
router.use(auth, checkSubscription, requireGymAccess);

router.post('/', requireGymOwner, requireActiveSubscription, validateBody(createPlanSchema), async (req, res, next) => {
  const { name, duration, price } = req.body;
  const gym_id = req.user.gym_id;

  try {
    const insertPlanQuery = `
      INSERT INTO Plans (gym_id, name, duration, price)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const result = await db.query(insertPlanQuery, [gym_id, name, duration, price]);
    const plan = result.rows[0];
    await recordAuditLog({
      req,
      action: ACTIONS.PLAN_CREATED,
      entityType: 'plan',
      entityId: plan.id,
      entityLabel: plan.name,
      details: { duration: plan.duration, price: parseFloat(plan.price) },
    });
    res.status(201).json(plan);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  const gym_id = req.user.gym_id;

  try {
    const queryText = `
      SELECT p.*, COUNT(m.id) FILTER (WHERE LOWER(m.status) = 'active')::int AS active_member_count
      FROM Plans p
      LEFT JOIN Members m ON m.plan_id = p.id AND m.gym_id = p.gym_id
      WHERE p.gym_id = $1
      GROUP BY p.id
      ORDER BY p.price ASC;
    `;
    const result = await db.query(queryText, [gym_id]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), validateBody(updatePlanSchema), async (req, res, next) => {
  const { id } = req.params;
  const { name, duration, price } = req.body;
  const gym_id = req.user.gym_id;

  try {
    const updateQuery = `
      UPDATE Plans 
      SET name = COALESCE($1, name),
          duration = COALESCE($2, duration),
          price = COALESCE($3, price)
      WHERE id = $4 AND gym_id = $5
      RETURNING *;
    `;
    const result = await db.query(updateQuery, [name, duration, price, id, gym_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membership plan not found or unauthorized.' });
    }

    const plan = result.rows[0];
    await recordAuditLog({
      req,
      action: ACTIONS.PLAN_UPDATED,
      entityType: 'plan',
      entityId: plan.id,
      entityLabel: plan.name,
      details: { duration: plan.duration, price: parseFloat(plan.price) },
    });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), async (req, res, next) => {
  const { id } = req.params;
  const gym_id = req.user.gym_id;

  try {
    const deleteQuery = 'DELETE FROM Plans WHERE id = $1 AND gym_id = $2 RETURNING *;';
    const result = await db.query(deleteQuery, [id, gym_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membership plan not found or unauthorized.' });
    }

    const plan = result.rows[0];
    await recordAuditLog({
      req,
      action: ACTIONS.PLAN_DELETED,
      entityType: 'plan',
      entityId: plan.id,
      entityLabel: plan.name,
    });
    res.json({ message: 'Membership plan successfully deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
