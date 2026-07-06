/**
 * @file routes/memberSms.js
 * @description Member SMS delivery log for gym owners (reminder messages sent to members).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const { parsePaginationQuery, paginatedResponse } = require('../utils/pagination');
const { resolveBranchScope } = require('../utils/branchScope');
const { validateQuery } = require('../middleware/validate');
const { memberSmsQuerySchema } = require('../validation/querySchemas');

const MEMBER_SMS_TYPES = [
  'member_due_soon',
  'member_expires_today',
  'member_expired',
];

router.use(auth, checkSubscription, requireGymAccess, requireGymOwner);

/**
 * GET /api/gym/member-sms
 * Paginated SMS log for members in the owner's gym.
 * @queryparam {number} [page=1]
 * @queryparam {number} [limit=10]
 * @queryparam {string} [type] - member_due_soon | member_expires_today | member_expired | all
 * @queryparam {number|string} [branch_id]
 */
router.get('/', validateQuery(memberSmsQuerySchema), async (req, res, next) => {
  const gymId = req.user.gym_id;
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const typeFilter = String(req.query.type || 'all').toLowerCase();

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const conditions = [
      "s.entity_type = 'member'",
      'm.gym_id = $1',
      's.message_type = ANY($2::text[])',
    ];
    const params = [gymId, MEMBER_SMS_TYPES];

    if (scope.branchId) {
      conditions.push(`m.branch_id = $${params.length + 1}`);
      params.push(scope.branchId);
    }

    if (typeFilter !== 'all' && MEMBER_SMS_TYPES.includes(typeFilter)) {
      conditions.push(`s.message_type = $${params.length + 1}`);
      params.push(typeFilter);
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM SmsLog s
      INNER JOIN Members m ON m.id = s.entity_id
      WHERE ${whereClause}
      `,
      params
    );
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const result = await db.query(
      `
      SELECT
        s.id,
        s.recipient_phone,
        s.message_type,
        s.entity_id AS member_id,
        s.message_id,
        s.sent_at,
        m.name AS member_name,
        m.phone AS member_phone,
        m.branch_id,
        b.name AS branch_name
      FROM SmsLog s
      INNER JOIN Members m ON m.id = s.entity_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE ${whereClause}
      ORDER BY s.sent_at DESC, s.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    res.json(paginatedResponse(result.rows, total, page, limit));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
