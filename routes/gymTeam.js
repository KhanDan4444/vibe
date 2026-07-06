/**
 * @file routes/gymTeam.js
 * @description Gym team management — gym owners only.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const { STAFF_ROLES, DEFAULT_STAFF_ROLE } = require('../utils/roles');
const { validateBody, validateParams } = require('../middleware/validate');
const { idParamSchema, createStaffSchema, updateStaffSchema, adminSetPasswordSchema } = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');
const { assertBranchInGym } = require('../utils/branches');

router.use(auth, requireGymAccess, requireGymOwner, checkSubscription);

function mapStaffRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username ?? null,
    staff_role: row.role,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    is_active: row.is_active,
  };
}

async function findStaffInGym(staffId, gymId) {
  const result = await db.query(
    `
    SELECT u.id, u.name, u.email, u.username, u.role, u.is_active, u.branch_id, b.name AS branch_name
    FROM Users u
    LEFT JOIN Branches b ON b.id = u.branch_id
    WHERE u.id = $1 AND u.gym_id = $2 AND u.role = ANY($3::text[])
    `,
    [staffId, gymId, STAFF_ROLES]
  );
  return result.rows[0] || null;
}

/**
 * GET /api/gym/team
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `
      SELECT u.id, u.name, u.email, u.username, u.role, u.is_active, u.branch_id, b.name AS branch_name
      FROM Users u
      LEFT JOIN Branches b ON b.id = u.branch_id
      WHERE u.gym_id = $1 AND u.role = ANY($2::text[])
      ORDER BY u.name ASC
      `,
      [req.user.gym_id, STAFF_ROLES]
    );
    res.json({
      staff: result.rows.map(mapStaffRow),
      staff_roles: STAFF_ROLES,
      canManage: true,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireActiveSubscription, validateBody(createStaffSchema), async (req, res, next) => {
  const { name, email, username, password, staff_role: staffRole, branch_id: branchId } = req.body;
  const gymId = req.user.gym_id;
  const role = staffRole || DEFAULT_STAFF_ROLE;

  try {
    await assertBranchInGym(branchId, gymId);

    const existing = await db.query(
      `
      SELECT id FROM Users
      WHERE LOWER(username) = LOWER($1)
         OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
      `,
      [username, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email or username is already in use.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      `
      INSERT INTO Users (name, email, username, password, role, gym_id, branch_id, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
      RETURNING id, name, email, username, role, is_active, branch_id
      `,
      [name.trim(), email, username, hashedPassword, role, gymId, branchId]
    );

    const row = result.rows[0];
    const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [branchId]);
    await recordAuditLog({
      req,
      action: ACTIONS.STAFF_CREATED,
      entityType: 'staff',
      entityId: row.id,
      entityLabel: row.name,
      details: { email: row.email, username: row.username, staff_role: role, branch_id: branchId },
    });

    res.status(201).json({
      staff: mapStaffRow({ ...row, branch_name: branchRow.rows[0]?.name }),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireActiveSubscription, validateParams(idParamSchema), validateBody(updateStaffSchema), async (req, res, next) => {
  const staffId = req.params.id;
  const gymId = req.user.gym_id;
  const { name, email, username, password, staff_role: staffRole, branch_id: branchId, is_active: isActive } =
    req.body;

  try {
    const current = await findStaffInGym(staffId, gymId);
    if (!current) {
      return res.status(404).json({ error: 'Staff account not found.' });
    }

    if (branchId !== undefined) {
      await assertBranchInGym(branchId, gymId);
    }

    const nextBranchId = branchId !== undefined ? branchId : current.branch_id;

    const nextName = name !== undefined ? name.trim() : current.name;
    const nextEmail = email !== undefined ? email : current.email;
    const nextUsername = username !== undefined ? username : current.username;

    if (
      nextEmail !== current.email ||
      (nextUsername && nextUsername !== current.username)
    ) {
      const existing = await db.query(
        `
        SELECT id FROM Users
        WHERE id <> $1
          AND (
            LOWER(username) = LOWER($2)
            OR ($3::text IS NOT NULL AND LOWER(email) = LOWER($3))
          )
        `,
        [staffId, nextUsername, nextEmail]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email or username is already in use.' });
      }
    }
    const nextRole = staffRole !== undefined ? staffRole : current.role;
    const nextActive = isActive !== undefined ? isActive : current.is_active;

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    const result = await db.query(
      `
      UPDATE Users
      SET
        name = $1,
        email = $2,
        username = $3,
        role = $4,
        is_active = $5,
        branch_id = $6,
        password = COALESCE($7, password),
        password_changed_at = CASE WHEN $7 IS NOT NULL THEN CURRENT_TIMESTAMP ELSE password_changed_at END
      WHERE id = $8 AND gym_id = $9
      RETURNING id, name, email, username, role, is_active, branch_id
      `,
      [nextName, nextEmail, nextUsername, nextRole, nextActive, nextBranchId, hashedPassword, staffId, gymId]
    );

    const row = result.rows[0];
    const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [row.branch_id]);
    await recordAuditLog({
      req,
      action: ACTIONS.STAFF_UPDATED,
      entityType: 'staff',
      entityId: row.id,
      entityLabel: row.name,
      details: {
        staff_role: row.role,
        is_active: row.is_active,
        email: row.email,
        username: row.username,
        branch_id: row.branch_id,
        ...(password ? { password_reset: true } : {}),
      },
    });

    res.json({ staff: mapStaffRow({ ...row, branch_name: branchRow.rows[0]?.name }) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/gym/team/:id/reset-password
 * Gym owner sets a new password for a staff account.
 */
router.post(
  '/:id/reset-password',
  requireActiveSubscription,
  validateParams(idParamSchema),
  validateBody(adminSetPasswordSchema),
  async (req, res, next) => {
    const staffId = req.params.id;
    const gymId = req.user.gym_id;
    const { password } = req.body;

    try {
      const current = await findStaffInGym(staffId, gymId);
      if (!current) {
        return res.status(404).json({ error: 'Staff account not found.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await db.query(
        `
        UPDATE Users
        SET password = $1, password_changed_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND gym_id = $3
        RETURNING id, name, email, username, role, is_active, branch_id
        `,
        [hashedPassword, staffId, gymId]
      );

      const row = result.rows[0];
      const branchRow = await db.query('SELECT name FROM Branches WHERE id = $1', [row.branch_id]);
      await recordAuditLog({
        req,
        action: ACTIONS.STAFF_UPDATED,
        entityType: 'staff',
        entityId: row.id,
        entityLabel: row.name,
        details: { password_reset: true },
      });

      res.json({ staff: mapStaffRow({ ...row, branch_name: branchRow.rows[0]?.name }) });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
