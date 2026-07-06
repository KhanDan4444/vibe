/**
 * @file auditLog.js
 * @description Append-only gym activity audit trail (who changed what).
 */

const db = require('../config/db');

const ACTIONS = Object.freeze({
  MEMBER_CREATED: 'member.created',
  MEMBER_ENROLLED: 'member.enrolled',
  MEMBER_RENEWED: 'member.renewed',
  MEMBER_PLAN_CHANGED: 'member.plan_changed',
  MEMBER_UPDATED: 'member.updated',
  MEMBER_TRANSFERRED: 'member.transferred',
  MEMBER_DELETED: 'member.deleted',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_UPDATED: 'payment.updated',
  PAYMENT_DELETED: 'payment.deleted',
  PLAN_CREATED: 'plan.created',
  PLAN_UPDATED: 'plan.updated',
  PLAN_DELETED: 'plan.deleted',
  STAFF_CREATED: 'staff.created',
  STAFF_UPDATED: 'staff.updated',
});

/**
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {string} params.action
 * @param {string} params.entityType
 * @param {number|null} [params.entityId]
 * @param {string} [params.entityLabel]
 * @param {object} [params.details]
 * @param {import('pg').PoolClient} [params.client] - Optional transaction client.
 */
async function recordAuditLog({
  req,
  action,
  entityType,
  entityId = null,
  entityLabel = null,
  details = {},
  client = null,
  gymId = null,
}) {
  const user = req.user;
  const resolvedGymId = gymId ?? user?.gym_id;
  if (!resolvedGymId) return;

  const executor = client || db;
  const actorName = user?.name || user?.email || 'Unknown user';

  try {
    await executor.query(
      `
      INSERT INTO AuditLogs (
        gym_id, branch_id, actor_id, actor_name, actor_email, actor_role,
        action, entity_type, entity_id, entity_label, details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        resolvedGymId,
        details?.branch_id ?? user?.branch_id ?? null,
        user?.id ?? null,
        actorName,
        user?.email || null,
        user?.role || null,
        action,
        entityType,
        entityId,
        entityLabel,
        JSON.stringify(details || {}),
      ]
    );
  } catch (error) {
    console.error('[auditLog] Failed to record activity:', error.message);
  }
}

module.exports = {
  ACTIONS,
  recordAuditLog,
};
