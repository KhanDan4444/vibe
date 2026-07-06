/**
 * @file routes/auditLogs.js
 * @description Gym owner activity feed — who changed what (staff + owner actions).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymOwner = require('../middleware/requireGymOwner');
const { parsePaginationQuery, paginatedResponse } = require('../utils/pagination');
const { STAFF_ROLES } = require('../utils/roles');
const { resolveBranchScope } = require('../utils/branchScope');

router.use(auth, requireGymOwner);

/**
 * GET /api/gym/activity
 * Paginated audit log for the owner's gym.
 * @queryparam {number} [page=1]
 * @queryparam {number} [limit=10]
 * @queryparam {string} [actor] - owner | staff | all (default all)
 * @queryparam {number|string} [branch_id] - filter by branch or all
 */
router.get('/', async (req, res, next) => {
  const gymId = req.user.gym_id;
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const actorFilter = String(req.query.actor || 'all').toLowerCase();

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const conditions = ['a.gym_id = $1'];
    const params = [gymId];

    if (scope.branchId) {
      conditions.push(`a.branch_id = $${params.length + 1}`);
      params.push(scope.branchId);
    }

    if (actorFilter === 'owner') {
      conditions.push(`a.actor_role = $${params.length + 1}`);
      params.push('Gym Owner');
    } else if (actorFilter === 'staff') {
      conditions.push(`a.actor_role = ANY($${params.length + 1}::text[])`);
      params.push(STAFF_ROLES);
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM AuditLogs a WHERE ${whereClause}`,
      params
    );
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const result = await db.query(
      `
      SELECT
        a.id,
        a.branch_id,
        b.name AS branch_name,
        a.actor_id,
        a.actor_name,
        a.actor_email,
        a.actor_role,
        a.action,
        a.entity_type,
        a.entity_id,
        a.entity_label,
        a.details,
        a.created_at
      FROM AuditLogs a
      LEFT JOIN Branches b ON b.id = a.branch_id
      WHERE ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    res.json(
      paginatedResponse(
        result.rows.map((row) => ({
          ...row,
          details: row.details || {},
        })),
        total,
        page,
        limit
      )
    );
  } catch (error) {
    next(error);
  }
});

module.exports = router;
