/**
 * @file memberPhone.js
 * @description Member phone lookup + per-gym uniqueness (last 9 digits).
 */

const db = require('../config/db');
const { normalizeEthiopianPhone } = require('./phone');

function phoneSuffix(phoneInput) {
  const normalized = normalizeEthiopianPhone(phoneInput);
  if (!normalized) return null;
  return normalized.replace(/\D/g, '').slice(-9);
}

/**
 * @param {number} gymId
 * @param {string} phoneInput
 * @param {{ excludeMemberId?: number, client?: import('pg').PoolClient }} [opts]
 */
async function findMembersByPhoneSuffix(gymId, phoneInput, opts = {}) {
  const suffix = phoneSuffix(phoneInput);
  if (!suffix) return [];

  const client = opts.client || db;
  const params = [gymId, suffix];
  let excludeSql = '';
  if (opts.excludeMemberId != null) {
    params.push(opts.excludeMemberId);
    excludeSql = ` AND m.id <> $${params.length}`;
  }

  const result = await client.query(
    `
    SELECT m.*, p.name AS plan_name, b.name AS branch_name
    FROM Members m
    LEFT JOIN Plans p ON p.id = m.plan_id
    LEFT JOIN Branches b ON b.id = m.branch_id
    WHERE m.gym_id = $1
      AND m.deleted_at IS NULL
      AND m.phone IS NOT NULL
      AND RIGHT(REGEXP_REPLACE(m.phone, '[^0-9]', '', 'g'), 9) = $2
      ${excludeSql}
    ORDER BY
      CASE WHEN m.telegram_chat_id IS NOT NULL THEN 0 ELSE 1 END,
      m.telegram_linked_at DESC NULLS LAST,
      m.id DESC
    `,
    params
  );

  return result.rows;
}

/**
 * Station check-in / desk flows — prefer Telegram-linked row when phones collide.
 */
async function findMemberByPhone(gymId, phoneInput, opts = {}) {
  const rows = await findMembersByPhoneSuffix(gymId, phoneInput, opts);
  if (!rows.length) return null;
  return rows.find((row) => row.telegram_chat_id) || rows[0];
}

/**
 * Enroll / edit — block if any other active member shares this number.
 */
async function assertMemberPhoneAvailable(gymId, phoneInput, excludeMemberId) {
  const rows = await findMembersByPhoneSuffix(gymId, phoneInput, { excludeMemberId });
  if (!rows.length) return { ok: true };
  const conflict = rows[0];
  return {
    ok: false,
    code: 'PHONE_ALREADY_USED',
    conflict: { id: conflict.id, name: conflict.name },
    error: `This phone number is already on file for ${conflict.name}.`,
  };
}

module.exports = {
  phoneSuffix,
  findMembersByPhoneSuffix,
  findMemberByPhone,
  assertMemberPhoneAvailable,
};
