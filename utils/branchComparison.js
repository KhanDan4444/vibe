/**
 * @file branchComparison.js
 * @description Per-branch dashboard metrics for owner comparison view.
 */

const db = require('../config/db');
const { MEMBER_UNPAID_SQL } = require('./memberListSql');
const { computePercentChange } = require('./periodComparison');

async function fetchBranchComparisonMetrics(gymId) {
  const branchesRes = await db.query(
    `
    SELECT id, name, is_active, is_default
    FROM Branches
    WHERE gym_id = $1
    ORDER BY is_default DESC, is_active DESC, name ASC
    `,
    [gymId]
  );

  const branches = await Promise.all(
    branchesRes.rows.map(async (branch) => {
      const params = [gymId, branch.id];
      const memberFilter = ' AND branch_id = $2';
      const memberAliasFilter = ' AND m.branch_id = $2';
      const payJoin = ' JOIN Members m ON m.id = p.member_id AND m.gym_id = p.gym_id AND m.branch_id = $2';

      const [
        totalRes,
        activeRes,
        dueSoonRes,
        expiredRes,
        unpaidRes,
        incomeRes,
        prevIncomeRes,
        newMembersRes,
      ] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${memberFilter}`, params),
        db.query(
          `SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${memberFilter} AND LOWER(status) = 'active'`,
          params
        ),
        db.query(
          `SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${memberFilter} AND LOWER(status) = 'due soon'`,
          params
        ),
        db.query(
          `SELECT COUNT(*)::int AS count FROM Members WHERE gym_id = $1${memberFilter} AND LOWER(status) = 'expired'`,
          params
        ),
        db.query(
          `SELECT COUNT(*)::int AS count FROM Members m WHERE m.gym_id = $1${memberAliasFilter} AND (${MEMBER_UNPAID_SQL})`,
          params
        ),
        db.query(
          `
          SELECT COALESCE(SUM(p.amount), 0) AS amount
          FROM Payments p${payJoin}
          WHERE p.gym_id = $1
            AND date_trunc('month', p.date) = date_trunc('month', CURRENT_DATE)
          `,
          params
        ),
        db.query(
          `
          SELECT COALESCE(SUM(p.amount), 0) AS amount
          FROM Payments p${payJoin}
          WHERE p.gym_id = $1
            AND date_trunc('month', p.date) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
          `,
          params
        ),
        db.query(
          `
          SELECT COUNT(*)::int AS count
          FROM Members
          WHERE gym_id = $1${memberFilter}
            AND date_trunc('month', start_date) = date_trunc('month', CURRENT_DATE)
          `,
          params
        ),
      ]);

      const monthlyIncome = parseFloat(incomeRes.rows[0].amount);
      const previousMonthIncome = parseFloat(prevIncomeRes.rows[0].amount);

      return {
        branchId: branch.id,
        branchName: branch.name,
        isActive: branch.is_active,
        isDefault: branch.is_default,
        totalMembers: totalRes.rows[0].count,
        activeMembers: activeRes.rows[0].count,
        dueSoonMembers: dueSoonRes.rows[0].count,
        expiredMembers: expiredRes.rows[0].count,
        unpaidCount: unpaidRes.rows[0].count,
        monthlyIncome,
        previousMonthIncome,
        revenueTrendPercent: computePercentChange(monthlyIncome, previousMonthIncome),
        newMembersThisMonth: newMembersRes.rows[0].count,
      };
    })
  );

  return branches;
}

module.exports = { fetchBranchComparisonMetrics };
