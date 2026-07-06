/**
 * @file branchScope.js
 * @description Resolve branch filters for list/dashboard queries.
 */

const db = require('../config/db');
const { isGymOwner, isGymStaff } = require('./roles');

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ error?: string, branchId: number|null, params: number[], memberSql: string, memberBareSql: string, paymentSql: string }>}
 */
async function resolveBranchScope(req) {
  const gymId = req.user.gym_id;

  if (isGymStaff(req.user.role)) {
    if (!req.user.branch_id) {
      return { error: 'Your account is not assigned to a branch. Contact your gym owner.' };
    }
    const branchId = req.user.branch_id;
    const ok = await db.query(
      `SELECT id FROM Branches WHERE id = $1 AND gym_id = $2 AND is_active = true`,
      [branchId, gymId]
    );
    if (ok.rows.length === 0) {
      return { error: 'Your assigned branch is no longer active.' };
    }
    return {
      branchId,
      params: [branchId],
      memberSql: ' AND m.branch_id = $2',
      memberBareSql: ' AND branch_id = $2',
      paymentSql: ' AND m.branch_id = $2',
    };
  }

  if (!isGymOwner(req.user.role)) {
    return { branchId: null, params: [], memberSql: '', memberBareSql: '', paymentSql: '' };
  }

  const raw = req.query.branch_id;
  if (raw === undefined || raw === null || raw === '' || raw === 'all') {
    return { branchId: null, params: [], memberSql: '', memberBareSql: '', paymentSql: '' };
  }

  const branchId = parseInt(raw, 10);
  if (Number.isNaN(branchId) || branchId <= 0) {
    return { error: 'Invalid branch_id.' };
  }

  const ok = await db.query(
    `SELECT id FROM Branches WHERE id = $1 AND gym_id = $2`,
    [branchId, gymId]
  );
  if (ok.rows.length === 0) {
    return { error: 'Branch not found.' };
  }

  return {
    branchId,
    params: [branchId],
    memberSql: ' AND m.branch_id = $2',
    memberBareSql: ' AND branch_id = $2',
    paymentSql: ' AND m.branch_id = $2',
  };
}

/** @param {number} gymId @param {{ params: number[] }} scope */
function gymBranchParams(gymId, scope) {
  return [gymId, ...scope.params];
}

module.exports = { resolveBranchScope, gymBranchParams };
