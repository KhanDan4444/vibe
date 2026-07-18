/**
 * @file routes/branches.js
 * @description Gym branches (locations) — Phase 1 multi-branch.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const { isGymStaff, STAFF_ROLES } = require('../utils/roles');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  idParamSchema,
  createBranchSchema,
  updateBranchSchema,
  reassignBranchStaffSchema,
} = require('../validation/schemas');
const { assertBranchInGym } = require('../utils/branches');

router.use(auth, requireGymAccess, checkSubscription);

const BRANCH_LIST_SQL = `
  SELECT
    b.*,
    COUNT(DISTINCT m.id)::int AS member_count,
    COUNT(DISTINCT u.id) FILTER (WHERE u.is_active = true)::int AS staff_count
  FROM Branches b
  LEFT JOIN Members m ON m.branch_id = b.id
  LEFT JOIN Users u ON u.branch_id = b.id AND u.gym_id = b.gym_id AND u.role = ANY($2::text[])
`;

function mapBranch(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    is_default: row.is_default,
    is_active: row.is_active,
    member_count: row.member_count != null ? parseInt(row.member_count, 10) : undefined,
    staff_count: row.staff_count != null ? parseInt(row.staff_count, 10) : undefined,
  };
}

async function branchWithCounts(branchId, gymId) {
  const result = await db.query(
    `
    ${BRANCH_LIST_SQL}
    WHERE b.id = $1 AND b.gym_id = $3
    GROUP BY b.id
    `,
    [branchId, STAFF_ROLES, gymId]
  );
  return result.rows[0] ? mapBranch(result.rows[0]) : null;
}

/**
 * GET /api/gym/branches
 * Owner: all branches. Staff: assigned branch only.
 */
router.get('/', async (req, res, next) => {
  try {
    if (isGymStaff(req.user.role)) {
      if (!req.user.branch_id) {
        return res.json({ branches: [] });
      }
      const result = await db.query(
        `
        ${BRANCH_LIST_SQL}
        WHERE b.id = $1 AND b.gym_id = $3
        GROUP BY b.id
        `,
        [req.user.branch_id, STAFF_ROLES, req.user.gym_id]
      );
      return res.json({ branches: result.rows.map(mapBranch) });
    }

    const result = await db.query(
      `
      ${BRANCH_LIST_SQL}
      WHERE b.gym_id = $1
      GROUP BY b.id
      ORDER BY b.is_default DESC, b.name ASC
      `,
      [req.user.gym_id, STAFF_ROLES]
    );
    res.json({ branches: result.rows.map(mapBranch) });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireGymOwner, requireActiveSubscription, validateBody(createBranchSchema), async (req, res, next) => {
  const { name, phone, address } = req.body;
  try {
    const result = await db.query(
      `
      INSERT INTO Branches (gym_id, name, phone, address, is_default, is_active)
      VALUES ($1, $2, $3, $4, false, true)
      RETURNING *
      `,
      [req.user.gym_id, name.trim(), phone?.trim() || null, address?.trim() || null]
    );
    res.status(201).json({ branch: mapBranch({ ...result.rows[0], member_count: 0, staff_count: 0 }) });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:id/reassign-staff',
  requireGymOwner,
  requireActiveSubscription,
  validateParams(idParamSchema),
  validateBody(reassignBranchStaffSchema),
  async (req, res, next) => {
    const branchId = parseInt(req.params.id, 10);
    const { target_branch_id: targetBranchId } = req.body;
    const gymId = req.user.gym_id;

    try {
      const source = await db.query(`SELECT id, name FROM Branches WHERE id = $1 AND gym_id = $2`, [
        branchId,
        gymId,
      ]);
      if (source.rows.length === 0) {
        return res.status(404).json({ error: 'Branch not found.' });
      }

      const targetBranch = await assertBranchInGym(targetBranchId, gymId);
      if (branchId === targetBranchId) {
        return res.status(400).json({ error: 'Choose a different branch to reassign staff to.' });
      }

      const result = await db.query(
        `
        UPDATE Users
        SET branch_id = $1
        WHERE gym_id = $2 AND branch_id = $3 AND role = ANY($4::text[]) AND is_active = true
        RETURNING id, name, email, role
        `,
        [targetBranchId, gymId, branchId, STAFF_ROLES]
      );

      res.json({
        moved: result.rows.length,
        staff: result.rows,
        target_branch: { id: targetBranch.id, name: targetBranch.name },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), validateBody(updateBranchSchema), async (req, res, next) => {
  const branchId = req.params.id;
  const { name, phone, address, is_active: isActive, is_default: isDefault } = req.body;
  const gymId = req.user.gym_id;

  try {
    const current = await db.query(`SELECT * FROM Branches WHERE id = $1 AND gym_id = $2`, [
      branchId,
      gymId,
    ]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Branch not found.' });
    }
    const branch = current.rows[0];

    if (branch.is_default && isActive === false) {
      return res.status(400).json({ error: 'Cannot deactivate the default branch.' });
    }

    if (isDefault === true) {
      if (isActive === false || (isActive === undefined && !branch.is_active)) {
        return res.status(400).json({ error: 'Cannot set an inactive branch as default.' });
      }
      await db.query(`UPDATE Branches SET is_default = false WHERE gym_id = $1`, [gymId]);
    }

    const result = await db.query(
      `
      UPDATE Branches
      SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        address = COALESCE($3, address),
        is_active = COALESCE($4, is_active),
        is_default = CASE WHEN $5 = true THEN true WHEN $5 = false THEN false ELSE is_default END
      WHERE id = $6 AND gym_id = $7
      RETURNING *
      `,
      [
        name !== undefined ? name.trim() : null,
        phone !== undefined ? (phone?.trim() || null) : null,
        address !== undefined ? (address?.trim() || null) : null,
        isActive,
        isDefault === true ? true : isDefault === false ? false : null,
        branchId,
        gymId,
      ]
    );

    const mapped = await branchWithCounts(branchId, gymId);
    res.json({ branch: mapped || mapBranch(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
