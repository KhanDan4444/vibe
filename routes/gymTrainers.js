/**
 * @file routes/gymTrainers.js
 * @description Gym trainers — employees with no login. Owner mutates; staff can list live trainers.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { z } = require('zod');
const { idParamSchema, createTrainerSchema, updateTrainerSchema } = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');
const { assertBranchInGym } = require('../utils/branches');
const { resolveBranchScope } = require('../utils/branchScope');
const { mapTrainerRow } = require('../utils/trainers');
const { isGymOwner } = require('../utils/roles');

router.use(auth, requireGymAccess, checkSubscription);

const listQuerySchema = z.object({
  archived: z.enum(['1', 'true']).optional(),
});

const TRAINER_SELECT = `
  SELECT t.id, t.name, t.phone, t.specialty, t.branch_id, t.deleted_at, t.created_at, b.name AS branch_name
  FROM Trainers t
  LEFT JOIN Branches b ON b.id = t.branch_id
`;

router.get('/', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    const liveSql = archived ? ' AND t.deleted_at IS NOT NULL' : ' AND t.deleted_at IS NULL';
    const branchSql = scope.branchId ? ' AND t.branch_id = $2' : '';
    const result = await db.query(
      `${TRAINER_SELECT}
       WHERE t.gym_id = $1${branchSql}${liveSql}
       ORDER BY t.name ASC`,
      [req.user.gym_id, ...scope.params]
    );
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM Trainers t
       WHERE t.gym_id = $1 AND t.deleted_at IS NOT NULL${scope.branchId ? ' AND t.branch_id = $2' : ''}`,
      [req.user.gym_id, ...scope.params]
    );
    res.json({
      trainers: result.rows.map(mapTrainerRow),
      archivedTotal: countResult.rows[0].count,
      canManage: isGymOwner(req.user.role),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/',
  requireGymOwner,
  requireActiveSubscription,
  validateBody(createTrainerSchema),
  async (req, res, next) => {
    const { name, phone, specialty, branch_id: branchId } = req.body;
    const gymId = req.user.gym_id;
    try {
      await assertBranchInGym(branchId, gymId);
      const result = await db.query(
        `
        INSERT INTO Trainers (gym_id, branch_id, name, phone, specialty)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, phone, specialty, branch_id, deleted_at, created_at
        `,
        [gymId, branchId, name.trim(), phone || null, specialty || null]
      );
      const row = result.rows[0];
      const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [branchId]);
      await recordAuditLog({
        req,
        action: ACTIONS.TRAINER_CREATED,
        entityType: 'trainer',
        entityId: row.id,
        entityLabel: row.name,
        details: { branch_id: branchId, phone: row.phone, specialty: row.specialty },
      });
      res.status(201).json({
        trainer: mapTrainerRow({ ...row, branch_name: branchRow.rows[0]?.name }),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id',
  requireGymOwner,
  requireActiveSubscription,
  validateParams(idParamSchema),
  validateBody(updateTrainerSchema),
  async (req, res, next) => {
    const gymId = req.user.gym_id;
    const { id } = req.params;
    try {
      const existing = await db.query(
        `${TRAINER_SELECT} WHERE t.id = $1 AND t.gym_id = $2 AND t.deleted_at IS NULL`,
        [id, gymId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Trainer not found.' });
      }
      const current = existing.rows[0];
      let branchId = current.branch_id;
      if (req.body.branch_id != null) {
        await assertBranchInGym(req.body.branch_id, gymId);
        branchId = req.body.branch_id;
      }
      const result = await db.query(
        `
        UPDATE Trainers
        SET name = COALESCE($1, name),
            phone = COALESCE($2, phone),
            specialty = COALESCE($3, specialty),
            branch_id = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5 AND gym_id = $6 AND deleted_at IS NULL
        RETURNING id, name, phone, specialty, branch_id, deleted_at, created_at
        `,
        [
          req.body.name,
          req.body.phone === undefined ? current.phone : req.body.phone,
          req.body.specialty === undefined ? current.specialty : req.body.specialty,
          branchId,
          id,
          gymId,
        ]
      );
      const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [branchId]);
      await recordAuditLog({
        req,
        action: ACTIONS.TRAINER_UPDATED,
        entityType: 'trainer',
        entityId: result.rows[0].id,
        entityLabel: result.rows[0].name,
        details: { branch_id: branchId },
      });
      res.json({ trainer: mapTrainerRow({ ...result.rows[0], branch_name: branchRow.rows[0]?.name }) });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id',
  requireGymOwner,
  requireActiveSubscription,
  validateParams(idParamSchema),
  async (req, res, next) => {
    const gymId = req.user.gym_id;
    const { id } = req.params;
    try {
      const result = await db.query(
        `
        UPDATE Trainers
        SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND gym_id = $2 AND deleted_at IS NULL
        RETURNING id, name
        `,
        [id, gymId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Trainer not found.' });
      }
      await recordAuditLog({
        req,
        action: ACTIONS.TRAINER_DELETED,
        entityType: 'trainer',
        entityId: result.rows[0].id,
        entityLabel: result.rows[0].name,
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/restore',
  requireGymOwner,
  requireActiveSubscription,
  validateParams(idParamSchema),
  async (req, res, next) => {
    const gymId = req.user.gym_id;
    const { id } = req.params;
    try {
      const result = await db.query(
        `
        UPDATE Trainers
        SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND gym_id = $2 AND deleted_at IS NOT NULL
        RETURNING id, name, phone, specialty, branch_id, deleted_at, created_at
        `,
        [id, gymId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Former trainer not found.' });
      }
      const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [result.rows[0].branch_id]);
      await recordAuditLog({
        req,
        action: ACTIONS.TRAINER_RESTORED,
        entityType: 'trainer',
        entityId: result.rows[0].id,
        entityLabel: result.rows[0].name,
      });
      res.json({ trainer: mapTrainerRow({ ...result.rows[0], branch_name: branchRow.rows[0]?.name }) });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
