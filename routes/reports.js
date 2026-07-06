/**
 * @file routes/reports.js
 * Gym-owner report data for charts and PDF/CSV exports (no pagination).
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

router.use(auth, checkSubscription, requireGymAccess);

/**
 * GET /api/reports/members
 * Full member list for owner reports / exports.
 */
router.get('/members', async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const memberOrderBy = parseMemberListSortOrder(req.query.sort || DEFAULT_REPORT_MEMBER_SORT);

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const filterStartIdx = 2 + scope.params.length;
    const { whereExtra, params } = buildMemberListFilters(req.query, filterStartIdx);

    const result = await db.query(
      `
      SELECT m.*, p.name AS plan_name, b.name AS branch_name, ${MEMBER_IS_UNPAID_SELECT}
      FROM Members m
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.gym_id = $1${scope.memberSql}${whereExtra}
      ORDER BY ${memberOrderBy}
      `,
      [gym_id, ...scope.params, ...params]
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
 */
router.get('/revenue', async (req, res, next) => {
  const gym_id = req.user.gym_id;
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
