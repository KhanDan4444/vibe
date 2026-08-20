/**
 * @file routes/checkIns.js
 * @description Desk check-in — search + tap. Phase 2 (no QR yet).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const { validateBody, validateQuery } = require('../middleware/validate');
const { z } = require('zod');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');
const { resolveBranchScope } = require('../utils/branchScope');
const { MEMBER_LIST_SELECT, MEMBER_LIST_FROM } = require('../utils/memberListSql');
const {
  getGymAttendanceSettings,
  evaluateCheckInEligibility,
  countVisitsInRange,
  startOfWeek,
  endOfWeek,
  toDateString,
  mapCheckInRow,
} = require('../utils/checkIns');
const { isGymOwner } = require('../utils/roles');

router.use(auth, requireGymAccess, checkSubscription);

const createCheckInSchema = z.object({
  member_id: z.coerce.number().int().positive(),
  force: z.boolean().optional().default(false),
  notes: z.string().trim().max(500).optional(),
});

const listQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(30).optional().default(12),
});

const attendanceSettingsSchema = z.object({
  visits_per_week: z.union([z.coerce.number().int().min(1).max(7), z.null()]).optional(),
  week_starts_on: z.enum(['monday', 'sunday']).optional(),
  one_checkin_per_day: z.boolean().optional(),
  over_limit_policy: z.enum(['block', 'warn_allow']).optional(),
});

async function loadLiveMember(gymId, memberId, scope) {
  const params = [memberId, gymId, ...scope.params];
  const branchSql = scope.branchId ? ' AND m.branch_id = $3' : '';
  const result = await db.query(
    `
    SELECT m.*, p.name AS plan_name, b.name AS branch_name, tr.name AS trainer_name
    FROM Members m
    LEFT JOIN Plans p ON p.id = m.plan_id
    LEFT JOIN Branches b ON b.id = m.branch_id
    LEFT JOIN Trainers tr ON tr.id = m.trainer_id
    WHERE m.id = $1 AND m.gym_id = $2 AND m.deleted_at IS NULL${branchSql}
    `,
    params
  );
  return result.rows[0] || null;
}

async function visitSummaryForMember(member, gymId, settings) {
  const now = new Date();
  const weekStart = startOfWeek(now, settings.week_starts_on);
  const weekEnd = endOfWeek(weekStart);
  const visitsThisWeek = await countVisitsInRange(member.id, gymId, weekStart, weekEnd);
  return {
    visits_this_week: visitsThisWeek,
    visits_limit: settings.visits_per_week,
    week_start: toDateString(weekStart),
    week_end: toDateString(new Date(weekEnd.getTime() - 1)),
    week_starts_on: settings.week_starts_on,
    one_checkin_per_day: settings.one_checkin_per_day,
    over_limit_policy: settings.over_limit_policy,
  };
}

/** GET /api/check-ins/settings */
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getGymAttendanceSettings(req.user.gym_id);
    res.json({ settings, canManage: isGymOwner(req.user.role) });
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/check-ins/settings — owner only */
router.patch(
  '/settings',
  requireGymOwner,
  requireActiveSubscription,
  validateBody(attendanceSettingsSchema),
  async (req, res, next) => {
    try {
      const current = await getGymAttendanceSettings(req.user.gym_id);
      const visits =
        req.body.visits_per_week !== undefined ? req.body.visits_per_week : current.visits_per_week;
      const weekStarts =
        req.body.week_starts_on !== undefined ? req.body.week_starts_on : current.week_starts_on;
      const onePerDay =
        req.body.one_checkin_per_day !== undefined
          ? req.body.one_checkin_per_day
          : current.one_checkin_per_day;
      const overLimit =
        req.body.over_limit_policy !== undefined
          ? req.body.over_limit_policy
          : current.over_limit_policy;

      await db.query(
        `
        UPDATE Gyms
        SET visits_per_week = $1,
            week_starts_on = $2,
            one_checkin_per_day = $3,
            over_limit_policy = $4
        WHERE id = $5
        `,
        [visits, weekStarts, onePerDay, overLimit, req.user.gym_id]
      );
      const settings = await getGymAttendanceSettings(req.user.gym_id);
      res.json({ settings });
    } catch (error) {
      next(error);
    }
  }
);

/** GET /api/check-ins/search?q= — members with week visit summary */
router.get('/search', validateQuery(searchQuerySchema), async (req, res, next) => {
  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }
    const q = `%${req.query.q}%`;
    const limit = req.query.limit;
    const settings = await getGymAttendanceSettings(req.user.gym_id);
    const params = [req.user.gym_id, ...scope.params];
    const branchSql = scope.branchId ? ' AND m.branch_id = $2' : '';
    params.push(q);
    const qIdx = params.length;
    params.push(limit);
    const limitIdx = params.length;

    const result = await db.query(
      `
      SELECT ${MEMBER_LIST_SELECT}
      ${MEMBER_LIST_FROM}
      WHERE m.gym_id = $1
        AND m.deleted_at IS NULL
        ${branchSql}
        AND (m.name ILIKE $${qIdx} OR COALESCE(m.phone, '') ILIKE $${qIdx})
      ORDER BY m.name ASC
      LIMIT $${limitIdx}
      `,
      params
    );

    const members = [];
    for (const row of result.rows) {
      const visits = await visitSummaryForMember(row, req.user.gym_id, settings);
      members.push({
        id: row.id,
        name: row.name,
        phone: row.phone,
        photo_url: row.photo_url || null,
        plan_name: row.plan_name || null,
        branch_id: row.branch_id,
        branch_name: row.branch_name || null,
        status: row.status,
        end_date: row.end_date,
        is_unpaid: row.is_unpaid,
        trainer_name: row.trainer_name || null,
        ...visits,
      });
    }
    res.json({ members, settings });
  } catch (error) {
    next(error);
  }
});

/** GET /api/check-ins/members/:id/summary */
router.get('/members/:id/summary', async (req, res, next) => {
  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }
    const memberId = parseInt(req.params.id, 10);
    if (!Number.isFinite(memberId) || memberId <= 0) {
      return res.status(400).json({ error: 'Invalid member id.' });
    }
    const member = await loadLiveMember(req.user.gym_id, memberId, scope);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    const settings = await getGymAttendanceSettings(req.user.gym_id);
    const visits = await visitSummaryForMember(member, req.user.gym_id, settings);
    res.json(visits);
  } catch (error) {
    next(error);
  }
});

/** GET /api/check-ins — today's (or date) log */
router.get('/', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }
    const date = req.query.date || toDateString(new Date());
    const limit = req.query.limit;
    const branchSql = scope.branchId ? ' AND c.branch_id = $3' : '';
    const params = scope.branchId
      ? [req.user.gym_id, date, scope.branchId, limit]
      : [req.user.gym_id, date, limit];
    const limitIdx = scope.branchId ? 4 : 3;

    const result = await db.query(
      `
      SELECT c.*,
             m.name AS member_name,
             m.phone AS member_phone,
             m.photo_url AS member_photo_url,
             b.name AS branch_name,
             u.name AS checked_in_by_name
      FROM CheckIns c
      JOIN Members m ON m.id = c.member_id
      LEFT JOIN Branches b ON b.id = c.branch_id
      LEFT JOIN Users u ON u.id = c.checked_in_by_user_id
      WHERE c.gym_id = $1
        AND c.checked_in_at::date = $2::date
        ${branchSql}
      ORDER BY c.checked_in_at DESC
      LIMIT $${limitIdx}
      `,
      params
    );

    const countResult = await db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM CheckIns c
      WHERE c.gym_id = $1
        AND c.checked_in_at::date = $2::date
        ${branchSql}
      `,
      scope.branchId ? [req.user.gym_id, date, scope.branchId] : [req.user.gym_id, date]
    );

    res.json({
      date,
      total: countResult.rows[0].count,
      checkIns: result.rows.map(mapCheckInRow),
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/check-ins */
router.post(
  '/',
  requireActiveSubscription,
  validateBody(createCheckInSchema),
  async (req, res, next) => {
    try {
      const scope = await resolveBranchScope(req);
      if (scope.error) {
        return res.status(400).json({ error: scope.error });
      }

      const member = await loadLiveMember(req.user.gym_id, req.body.member_id, scope);
      if (!member) {
        return res.status(404).json({ error: 'Member not found.' });
      }

      const settings = await getGymAttendanceSettings(req.user.gym_id);
      const eligibility = await evaluateCheckInEligibility(member, req.user.gym_id, settings, {
        force: Boolean(req.body.force),
      });

      if (!eligibility.ok) {
        const status =
          eligibility.code === 'WEEKLY_LIMIT' && eligibility.canForce ? 409 : 400;
        return res.status(status).json({
          error: eligibility.error,
          code: eligibility.code,
          visits_this_week: eligibility.visitsThisWeek,
          visits_limit: eligibility.visitsLimit,
          week_start: eligibility.weekStart,
          week_end: eligibility.weekEnd,
          can_force: Boolean(eligibility.canForce),
        });
      }

      const insert = await db.query(
        `
        INSERT INTO CheckIns (gym_id, branch_id, member_id, checked_in_by_user_id, method, notes)
        VALUES ($1, $2, $3, $4, 'search', $5)
        RETURNING *
        `,
        [
          req.user.gym_id,
          member.branch_id,
          member.id,
          req.user.id,
          req.body.notes || null,
        ]
      );

      const visitsThisWeek = eligibility.visitsThisWeek + 1;
      await recordAuditLog({
        req,
        action: ACTIONS.CHECK_IN_RECORDED,
        entityType: 'check_in',
        entityId: insert.rows[0].id,
        entityLabel: member.name,
        details: {
          member_id: member.id,
          visits_this_week: visitsThisWeek,
          visits_limit: eligibility.visitsLimit,
          method: 'search',
        },
      });

      res.status(201).json({
        checkIn: mapCheckInRow({
          ...insert.rows[0],
          member_name: member.name,
          member_phone: member.phone,
          member_photo_url: member.photo_url,
          branch_name: member.branch_name,
        }),
        visits_this_week: visitsThisWeek,
        visits_limit: eligibility.visitsLimit,
        week_start: eligibility.weekStart,
        week_end: eligibility.weekEnd,
        member: {
          id: member.id,
          name: member.name,
          phone: member.phone,
          photo_url: member.photo_url || null,
          plan_name: member.plan_name || null,
          trainer_name: member.trainer_name || null,
          branch_name: member.branch_name || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
