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
const {
  parseCertificationDataUrl,
  saveTrainerCertification,
  removeTrainerCertificationFiles,
  resolveTrainerCertificationOnDisk,
} = require('../utils/trainerCertifications');

router.use(auth, requireGymAccess, checkSubscription);

const listQuerySchema = z.object({
  archived: z.enum(['1', 'true']).optional(),
});

const TRAINER_SELECT = `
  SELECT t.id, t.name, t.phone, t.specialty, t.certification_url, t.branch_id, t.deleted_at, t.created_at,
    b.name AS branch_name,
    (
      SELECT COUNT(*)::int FROM Members m
      WHERE m.trainer_id = t.id AND m.gym_id = t.gym_id AND m.deleted_at IS NULL
    ) AS member_count
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

router.get('/:id/certification', validateParams(idParamSchema), async (req, res, next) => {
  const gymId = req.user.gym_id;
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT certification_url FROM Trainers WHERE id = $1 AND gym_id = $2`,
      [id, gymId]
    );
    if (result.rows.length === 0 || !result.rows[0].certification_url) {
      return res.status(404).json({ error: 'Certification not found.' });
    }
    const file = resolveTrainerCertificationOnDisk(result.rows[0].certification_url);
    if (!file) {
      return res.status(404).json({ error: 'Certification not found.' });
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(file.absolute);
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
    const { name, phone, specialty, branch_id: branchId, certification } = req.body;
    const gymId = req.user.gym_id;
    try {
      await assertBranchInGym(branchId, gymId);

      let certCheck = { ok: true };
      if (certification) {
        certCheck = parseCertificationDataUrl(certification);
        if (!certCheck.ok) {
          return res.status(400).json({ error: certCheck.error });
        }
      }

      const result = await db.query(
        `
        INSERT INTO Trainers (gym_id, branch_id, name, phone, specialty)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, phone, specialty, certification_url, branch_id, deleted_at, created_at
        `,
        [gymId, branchId, name.trim(), phone || null, specialty || null]
      );
      let row = result.rows[0];

      if (certification && certCheck.buffer) {
        const saved = await saveTrainerCertification(gymId, row.id, certification);
        if (!saved.ok) {
          await db.query('DELETE FROM Trainers WHERE id = $1 AND gym_id = $2', [row.id, gymId]);
          return res.status(400).json({ error: saved.error });
        }
        const updated = await db.query(
          `UPDATE Trainers SET certification_url = $1 WHERE id = $2 AND gym_id = $3
           RETURNING id, name, phone, specialty, certification_url, branch_id, deleted_at, created_at`,
          [saved.certificationUrl, row.id, gymId]
        );
        row = updated.rows[0];
      }

      const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [branchId]);
      await recordAuditLog({
        req,
        action: ACTIONS.TRAINER_CREATED,
        entityType: 'trainer',
        entityId: row.id,
        entityLabel: row.name,
        details: {
          branch_id: branchId,
          phone: row.phone,
          specialty: row.specialty,
          has_certification: Boolean(row.certification_url),
        },
      });
      res.status(201).json({
        trainer: mapTrainerRow({ ...row, branch_name: branchRow.rows[0]?.name, member_count: 0 }),
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

      let certificationUrl = current.certification_url;
      if (req.body.certification !== undefined) {
        if (req.body.certification === null || req.body.certification === '') {
          if (current.certification_url) {
            await removeTrainerCertificationFiles(gymId, id);
          }
          certificationUrl = null;
        } else {
          const certCheck = parseCertificationDataUrl(req.body.certification);
          if (!certCheck.ok) {
            return res.status(400).json({ error: certCheck.error });
          }
          const saved = await saveTrainerCertification(gymId, id, req.body.certification);
          if (!saved.ok) {
            return res.status(400).json({ error: saved.error });
          }
          certificationUrl = saved.certificationUrl;
        }
      }

      const result = await db.query(
        `
        UPDATE Trainers
        SET name = COALESCE($1, name),
            phone = COALESCE($2, phone),
            specialty = COALESCE($3, specialty),
            branch_id = $4,
            certification_url = $5,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $6 AND gym_id = $7 AND deleted_at IS NULL
        RETURNING id, name, phone, specialty, certification_url, branch_id, deleted_at, created_at
        `,
        [
          req.body.name,
          req.body.phone === undefined ? current.phone : req.body.phone,
          req.body.specialty === undefined ? current.specialty : req.body.specialty,
          branchId,
          certificationUrl,
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
        details: {
          branch_id: branchId,
          has_certification: Boolean(result.rows[0].certification_url),
        },
      });
      res.json({
        trainer: mapTrainerRow({
          ...result.rows[0],
          branch_name: branchRow.rows[0]?.name,
          member_count: current.member_count,
        }),
      });
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
        RETURNING id, name, phone, specialty, certification_url, branch_id, deleted_at, created_at
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
