/**
 * @file routes/reports.js
 * Gym-owner report data for charts and PDF/CSV exports.
 * Use ?summary=1 for lightweight aggregates (no full row payload).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireGymAccess = require('../middleware/requireGymAccess');
const { parsePeriodQuery } = require('../utils/paymentPeriodSql');
const {
  parseOwnerPaymentSortOrder,
  DEFAULT_REPORT_MEMBER_SORT,
  DEFAULT_REPORT_OWNER_REVENUE_SORT,
  parseMemberListSortOrder,
} = require('../utils/listSortSql');
const { summarizePaymentRows } = require('../utils/paymentSummary');
const { buildOwnerPaymentWhere } = require('../utils/paymentQuerySql');
const { buildMemberListFilters, MEMBER_IS_UNPAID_SELECT } = require('../utils/memberListSql');
const { resolveBranchScope } = require('../utils/branchScope');
const { MEMBER_STATUS_CASE_SQL } = require('../utils/memberStatus');

router.use(auth, checkSubscription, requireGymAccess);

/** Boolean unpaid predicate (without SELECT alias) for COUNT FILTER. */
const MEMBER_IS_UNPAID = `
  NOT EXISTS (
    SELECT 1 FROM Payments pay
    WHERE pay.member_id = m.id AND pay.gym_id = m.gym_id AND pay.date >= m.start_date
  )
`;

const MEMBER_STATUS_EXPR = MEMBER_STATUS_CASE_SQL.replace(/end_date/g, 'm.end_date');

function wantsSummary(query) {
  const v = query.summary;
  return v === '1' || v === 'true' || v === true;
}

/**
 * GET /api/reports/members
 * Full member list for owner reports / exports.
 * ?summary=1 → counts only (no members array).
 */
router.get('/members', async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const summaryOnly = wantsSummary(req.query);
  const memberOrderBy = parseMemberListSortOrder(req.query.sort || DEFAULT_REPORT_MEMBER_SORT);

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const filterStartIdx = 2 + scope.params.length;
    const { whereExtra, params } = buildMemberListFilters(req.query, filterStartIdx);
    const sqlParams = [gym_id, ...scope.params, ...params];

    if (summaryOnly) {
      const result = await db.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE (${MEMBER_STATUS_EXPR}) = 'active' AND NOT (${MEMBER_IS_UNPAID})
          )::int AS active,
          COUNT(*) FILTER (WHERE (${MEMBER_STATUS_EXPR}) = 'due soon')::int AS "dueSoon",
          COUNT(*) FILTER (WHERE (${MEMBER_STATUS_EXPR}) = 'expired')::int AS expired,
          COUNT(*) FILTER (WHERE ${MEMBER_IS_UNPAID})::int AS unpaid,
          COUNT(*) FILTER (WHERE (${MEMBER_STATUS_EXPR}) = 'expired')::int AS "barExpired",
          COUNT(*) FILTER (
            WHERE (${MEMBER_STATUS_EXPR}) = 'due soon'
          )::int AS "barDueSoon",
          COUNT(*) FILTER (
            WHERE (${MEMBER_STATUS_EXPR}) NOT IN ('expired', 'due soon')
              AND (${MEMBER_IS_UNPAID})
          )::int AS "barUnpaid",
          COUNT(*) FILTER (
            WHERE (${MEMBER_STATUS_EXPR}) = 'active'
              AND NOT (${MEMBER_IS_UNPAID})
          )::int AS "barActive"
        FROM Members m
        LEFT JOIN Plans p ON p.id = m.plan_id
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE m.gym_id = $1${scope.memberSql}${whereExtra}
        `,
        sqlParams
      );

      const row = result.rows[0] || {};
      return res.json({
        generatedAt: new Date().toISOString(),
        count: row.total || 0,
        branchId: scope.branchId,
        summary: true,
        counts: {
          total: row.total || 0,
          active: row.active || 0,
          dueSoon: row.dueSoon || 0,
          expired: row.expired || 0,
          unpaid: row.unpaid || 0,
        },
        barCounts: {
          total: row.total || 0,
          active: row.barActive || 0,
          dueSoon: row.barDueSoon || 0,
          expired: row.barExpired || 0,
          unpaid: row.barUnpaid || 0,
        },
        members: [],
      });
    }

    const result = await db.query(
      `
      SELECT m.*, p.name AS plan_name, b.name AS branch_name, ${MEMBER_IS_UNPAID_SELECT}
      FROM Members m
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.gym_id = $1${scope.memberSql}${whereExtra}
      ORDER BY ${memberOrderBy}
      `,
      sqlParams
    );

    res.json({
      generatedAt: new Date().toISOString(),
      count: result.rows.length,
      branchId: scope.branchId,
      members: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/revenue
 * Payment lines + summary for owner reports / exports.
 * ?summary=1 → summary + daily chart points (no payments array).
 */
router.get('/revenue', async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const summaryOnly = wantsSummary(req.query);
  const period = parsePeriodQuery(req.query);
  const paymentOrderBy = parseOwnerPaymentSortOrder(
    req.query.sort || DEFAULT_REPORT_OWNER_REVENUE_SORT
  );

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const { whereClause, params } = buildOwnerPaymentWhere(
      req.query,
      period,
      gym_id,
      scope.branchId
    );

    if (summaryOnly) {
      const [summaryRes, chartRes] = await Promise.all([
        db.query(
          `
          SELECT
            COALESCE(SUM(p.amount), 0)::float AS total,
            COUNT(*)::int AS count,
            COALESCE(AVG(p.amount), 0)::float AS average
          FROM Payments p
          JOIN Members m ON m.id = p.member_id
          LEFT JOIN Branches b ON b.id = m.branch_id
          LEFT JOIN Plans pl ON pl.id = m.plan_id
          WHERE ${whereClause}
          `,
          params
        ),
        db.query(
          `
          SELECT
            TO_CHAR(p.date::date, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(p.amount), 0)::float AS amount
          FROM Payments p
          JOIN Members m ON m.id = p.member_id
          LEFT JOIN Branches b ON b.id = m.branch_id
          LEFT JOIN Plans pl ON pl.id = m.plan_id
          WHERE ${whereClause}
          GROUP BY p.date::date
          ORDER BY p.date::date ASC
          `,
          params
        ),
      ]);

      const s = summaryRes.rows[0] || { total: 0, count: 0, average: 0 };
      return res.json({
        generatedAt: new Date().toISOString(),
        count: s.count || 0,
        branchId: scope.branchId,
        summary: {
          total: Number(s.total) || 0,
          count: s.count || 0,
          average: Number(s.average) || 0,
        },
        chart: chartRes.rows.map((r) => ({ date: r.date, amount: Number(r.amount) || 0 })),
        payments: [],
      });
    }

    const result = await db.query(
      `
      SELECT
        p.id,
        p.amount,
        p.date,
        p.method,
        p.member_id,
        m.name AS member_name,
        b.name AS branch_name,
        pl.name AS plan_name
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      LEFT JOIN Plans pl ON pl.id = m.plan_id
      WHERE ${whereClause}
      ORDER BY ${paymentOrderBy}
      `,
      params
    );

    const summary = summarizePaymentRows(result.rows);

    res.json({
      generatedAt: new Date().toISOString(),
      count: result.rows.length,
      branchId: scope.branchId,
      summary,
      payments: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
