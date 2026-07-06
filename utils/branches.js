/**
 * @file branches.js
 * @description Branch helpers for multi-location gyms (Phase 1).
 */

const db = require('../config/db');

/**
 * Create the default "Main" branch for a new gym.
 * @param {import('pg').PoolClient|typeof db} executor
 * @param {number} gymId
 * @param {string} [name]
 */
async function createDefaultBranch(executor, gymId, name = 'Main') {
  const result = await executor.query(
    `
    INSERT INTO Branches (gym_id, name, is_default, is_active)
    VALUES ($1, $2, true, true)
    RETURNING id, name, is_default, is_active
    `,
    [gymId, name]
  );
  return result.rows[0];
}

async function getDefaultBranchId(gymId, executor = db) {
  const result = await executor.query(
    `SELECT id FROM Branches WHERE gym_id = $1 AND is_default = true AND is_active = true LIMIT 1`,
    [gymId]
  );
  if (result.rows.length > 0) return result.rows[0].id;

  const fallback = await executor.query(
    `SELECT id FROM Branches WHERE gym_id = $1 AND is_active = true ORDER BY is_default DESC, id ASC LIMIT 1`,
    [gymId]
  );
  if (fallback.rows.length > 0) return fallback.rows[0].id;

  const created = await createDefaultBranch(executor, gymId);
  return created.id;
}

async function getBranchById(branchId, gymId, executor = db) {
  const result = await executor.query(
    `SELECT id, name, is_active, is_default FROM Branches WHERE id = $1 AND gym_id = $2`,
    [branchId, gymId]
  );
  return result.rows[0] || null;
}

async function assertMemberBranchWritable(memberId, gymId, executor = db) {
  const result = await executor.query(
    `
    SELECT m.id, b.is_active, b.name AS branch_name
    FROM Members m
    JOIN Branches b ON b.id = m.branch_id
    WHERE m.id = $1 AND m.gym_id = $2
    `,
    [memberId, gymId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Member not found or unauthorized.');
    err.statusCode = 404;
    throw err;
  }
  if (!result.rows[0].is_active) {
    const err = new Error(
      `This member belongs to inactive branch "${result.rows[0].branch_name}". Reactivate the branch or move the member before making changes.`
    );
    err.statusCode = 403;
    err.code = 'BRANCH_INACTIVE';
    throw err;
  }
  return result.rows[0];
}

async function assertBranchInGym(branchId, gymId, executor = db) {
  const result = await executor.query(
    `SELECT id, name FROM Branches WHERE id = $1 AND gym_id = $2 AND is_active = true`,
    [branchId, gymId]
  );
  if (result.rows.length === 0) {
    const err = new Error('Branch not found or inactive.');
    err.statusCode = 404;
    throw err;
  }
  return result.rows[0];
}

/**
 * Resolve which branch a new/updated member belongs to.
 */
async function resolveMemberBranchId(req, bodyBranchId, executor = db) {
  const { isGymOwner, isGymStaff } = require('./roles');
  const gymId = req.user.gym_id;

  if (isGymStaff(req.user.role)) {
    if (!req.user.branch_id) {
      const err = new Error('Your account is not assigned to a branch.');
      err.statusCode = 403;
      throw err;
    }
    return req.user.branch_id;
  }

  if (bodyBranchId != null) {
    const id = parseInt(bodyBranchId, 10);
    if (!Number.isNaN(id) && id > 0) {
      await assertBranchInGym(id, gymId, executor);
      return id;
    }
  }

  const queryBranch = req.query?.branch_id;
  if (queryBranch && queryBranch !== 'all') {
    const id = parseInt(queryBranch, 10);
    if (!Number.isNaN(id) && id > 0) {
      await assertBranchInGym(id, gymId, executor);
      return id;
    }
  }

  return getDefaultBranchId(gymId, executor);
}

module.exports = {
  createDefaultBranch,
  getDefaultBranchId,
  getBranchById,
  assertBranchInGym,
  assertMemberBranchWritable,
  resolveMemberBranchId,
};
