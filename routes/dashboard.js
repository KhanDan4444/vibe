/**
 * @file routes/dashboard.js
 * @description Gym Owner Dashboard Metrics Router.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const { MEMBER_UNPAID_SQL } = require('../utils/memberListSql');
const { DUE_SOON_DAYS } = require('../utils/memberStatus');
const { computePercentChange, computeCountDelta } = require('../utils/periodComparison');
const { resolveBranchScope, gymBranchParams } = require('../utils/branchScope');
const { fetchBranchComparisonMetrics } = require('../utils/branchComparison');
const { isGymOwner } = require('../utils/roles');

router.use(auth, checkSubscription, requireGymAccess);

function branchLabel(prefix, name) {
  return prefix && name ? `[${name}] ` : '';
}

router.get('/branch-comparison', async (req, res, next) => {
  if (!isGymOwner(req.user.role)) {
    return res.status(403).json({ error: 'Access denied. Gym owners only.' });
  }

  try {
    const branches = await fetchBranchComparisonMetrics(req.user.gym_id);
    res.json({ branches });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  const gym_id = req.user.gym_id;

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const qp = gymBranchParams(gym_id, scope);
    const mb = scope.memberBareSql;
    const ma = scope.memberSql;
    const showBranchLabels = !scope.branchId;
    const payBranch = scope.branchId
      ? ' JOIN Members m ON m.id = p.member_id AND m.gym_id = p.gym_id AND m.branch_id = $2'
      : '';

    const [
      totalMembersRes,
      activeMembersRes,
      expiredMembersRes,
      dueSoonMembersRes,
      unpaidRes,
      incomeRes,
      previousIncomeRes,
      newMembersThisMonthRes,
      newMembersLastMonthRes,
      alertMembersRes,
      revenueChartRes,
      unpaidAlertsRes,
      dueSoonAlertsRes,
      expiredAlertsRes,
      recentPaymentsRes,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${mb}`, qp),
      db.query(
        `SELECT COUNT(*)::int AS count FROM Members m WHERE m.gym_id = $1${ma}
          AND m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})`,
        qp
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${mb} AND end_date < CURRENT_DATE`,
        qp
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${mb} AND end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'`,
        qp
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM Members m WHERE m.gym_id = $1${ma} AND (${MEMBER_UNPAID_SQL})`,
        qp
      ),
      db.query(
        `
        SELECT COALESCE(SUM(p.amount), 0) AS monthly_income
        FROM Payments p${payBranch}
        WHERE p.gym_id = $1
          AND date_trunc('month', p.date) = date_trunc('month', CURRENT_DATE)
        `,
        qp
      ),
      db.query(
        `
        SELECT COALESCE(SUM(p.amount), 0) AS monthly_income
        FROM Payments p${payBranch}
        WHERE p.gym_id = $1
          AND date_trunc('month', p.date) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
        `,
        qp
      ),
      db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM Members
        WHERE gym_id = $1${mb}
          AND date_trunc('month', start_date) = date_trunc('month', CURRENT_DATE)
        `,
        qp
      ),
      db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM Members
        WHERE gym_id = $1${mb}
          AND date_trunc('month', start_date) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
        `,
        qp
      ),
      db.query(
        `
        SELECT
          m.id,
          m.name,
          m.plan_id,
          m.end_date,
          CASE
            WHEN m.end_date < CURRENT_DATE THEN 'expired'
            WHEN m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days' THEN 'due soon'
            ELSE 'active'
          END AS status,
          p.name AS plan_name
        FROM Members m
        LEFT JOIN Plans p ON p.id = m.plan_id
        WHERE m.gym_id = $1${ma}
          AND m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})
        ORDER BY m.end_date ASC
        LIMIT 5
        `,
        qp
      ),
      db.query(
        `
        SELECT date_trunc('day', p.date)::date AS day, COALESCE(SUM(p.amount), 0) AS amount
        FROM Payments p${payBranch}
        WHERE p.gym_id = $1
          AND date_trunc('month', p.date) = date_trunc('month', CURRENT_DATE)
        GROUP BY day
        ORDER BY day ASC
        `,
        qp
      ),
      db.query(
        `
        SELECT m.id, m.name, m.end_date, m.status, m.branch_id, b.name AS branch_name
        FROM Members m
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE m.gym_id = $1${ma} AND (${MEMBER_UNPAID_SQL})
        ORDER BY m.name ASC
        LIMIT 10
        `,
        qp
      ),
      db.query(
        `
        SELECT
          m.id,
          m.name,
          m.end_date,
          CASE
            WHEN m.end_date < CURRENT_DATE THEN 'expired'
            WHEN m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days' THEN 'due soon'
            ELSE 'active'
          END AS status,
          p.name AS plan_name,
          m.branch_id,
          b.name AS branch_name
        FROM Members m
        LEFT JOIN Plans p ON p.id = m.plan_id
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE m.gym_id = $1${ma}
          AND m.end_date >= CURRENT_DATE
          AND m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})
        ORDER BY m.end_date ASC
        LIMIT 10
        `,
        qp
      ),
      db.query(
        `
        SELECT
          m.id,
          m.name,
          m.end_date,
          CASE
            WHEN m.end_date < CURRENT_DATE THEN 'expired'
            WHEN m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days' THEN 'due soon'
            ELSE 'active'
          END AS status,
          p.name AS plan_name,
          m.branch_id,
          b.name AS branch_name
        FROM Members m
        LEFT JOIN Plans p ON p.id = m.plan_id
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE m.gym_id = $1${ma} AND m.end_date < CURRENT_DATE
          AND NOT (${MEMBER_UNPAID_SQL})
        ORDER BY m.end_date ASC
        LIMIT 10
        `,
        qp
      ),
      db.query(
        `
        SELECT p.id, p.member_id, p.amount, p.date, p.method, m.name AS member_name, m.branch_id, b.name AS branch_name
        FROM Payments p
        JOIN Members m ON m.id = p.member_id
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE p.gym_id = $1${scope.paymentSql}
        ORDER BY p.date DESC, p.id DESC
        LIMIT 5
        `,
        qp
      ),
    ]);

    const notifications = [];

    unpaidAlertsRes.rows.forEach((member) => {
      const prefix = branchLabel(showBranchLabels, member.branch_name);
      notifications.push({
        id: `unpaid-${member.id}`,
        kind: 'unpaid',
        memberId: member.id,
        memberName: member.name,
        branchId: member.branch_id,
        branchName: member.branch_name,
        type: 'warning',
        title: 'Payment Not Collected',
        message: `${prefix}${member.name} was enrolled but has no payment on file for this term.`,
        date: 'Action needed',
        suggestedAction: 'payment',
      });
    });

    dueSoonAlertsRes.rows.forEach((member) => {
      const planName = member.plan_name || 'Membership';
      const prefix = branchLabel(showBranchLabels, member.branch_name);
      notifications.push({
        id: `due-${member.id}`,
        kind: 'due_soon',
        memberId: member.id,
        memberName: member.name,
        planName,
        endDate: member.end_date,
        branchId: member.branch_id,
        branchName: member.branch_name,
        type: 'warning',
        title: 'Expiring Soon',
        message: `${prefix}${member.name}'s ${planName} expires in less than 3 days (on ${member.end_date}).`,
        date: 'System Alert',
        suggestedAction: 'renew',
      });
    });

    expiredAlertsRes.rows.forEach((member) => {
      const planName = member.plan_name || 'Membership';
      const prefix = branchLabel(showBranchLabels, member.branch_name);
      notifications.push({
        id: `exp-${member.id}`,
        kind: 'expired',
        memberId: member.id,
        memberName: member.name,
        planName,
        endDate: member.end_date,
        branchId: member.branch_id,
        branchName: member.branch_name,
        type: 'danger',
        title: 'Membership Expired',
        message: `${prefix}${member.name}'s ${planName} expired on ${member.end_date}.`,
        date: 'System Alert',
        suggestedAction: 'renew',
      });
    });

    recentPaymentsRes.rows.forEach((payment) => {
      const prefix = branchLabel(showBranchLabels, payment.branch_name);
      notifications.push({
        id: `pay-${payment.id}`,
        kind: 'payment_recorded',
        memberId: payment.member_id,
        memberName: payment.member_name,
        amount: parseFloat(payment.amount),
        branchId: payment.branch_id,
        branchName: payment.branch_name,
        type: 'info',
        title: 'Payment Recorded',
        message: `${prefix}Successfully recorded manual payment of $${parseFloat(payment.amount).toFixed(2)} from ${payment.member_name}.`,
        date: payment.date,
      });
    });

    const monthlyIncome = parseFloat(incomeRes.rows[0].monthly_income);
    const previousMonthIncome = parseFloat(previousIncomeRes.rows[0].monthly_income);
    const newMembersThisMonth = newMembersThisMonthRes.rows[0].count;
    const newMembersLastMonth = newMembersLastMonthRes.rows[0].count;

    res.json({
      totalMembers: totalMembersRes.rows[0].count,
      activeMembers: activeMembersRes.rows[0].count,
      expiredMembers: expiredMembersRes.rows[0].count,
      dueSoonMembers: dueSoonMembersRes.rows[0].count,
      unpaidCount: unpaidRes.rows[0].count,
      monthlyIncome,
      previousMonthIncome,
      revenueTrendPercent: computePercentChange(monthlyIncome, previousMonthIncome),
      newMembersThisMonth,
      newMembersLastMonth,
      newMembersTrendPercent: computePercentChange(newMembersThisMonth, newMembersLastMonth),
      newMembersDeltaLabel: computeCountDelta(newMembersThisMonth, newMembersLastMonth),
      alertMembers: alertMembersRes.rows,
      revenueChart: revenueChartRes.rows.map((r) => ({
        date: r.day,
        amount: parseFloat(r.amount),
      })),
      notifications,
      branchId: scope.branchId,
      subscriptionStatus: req.gymSubscriptionStatus,
      readOnly: req.gymSubscriptionStatus === 'suspended',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
