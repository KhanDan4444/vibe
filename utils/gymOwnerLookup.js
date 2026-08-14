/**
 * @file gymOwnerLookup.js
 * @description Resolve gym-owner accounts by username or gym phone (normalized).
 */

const db = require('../config/db');
const { ROLES } = require('./roles');
const { normalizeEthiopianPhone } = require('./phone');

/**
 * @param {string} username
 * @returns {Promise<{ id: number, role: string, phone: string | null } | null>}
 */
async function findGymOwnerByUsername(username) {
  const result = await db.query(
    `
    SELECT u.id, u.role, g.phone
    FROM Users u
    JOIN Gyms g ON g.id = u.gym_id
    WHERE u.role = $1
      AND u.username IS NOT NULL
      AND LOWER(u.username) = LOWER($2)
    LIMIT 1
    `,
    [ROLES.GYM_OWNER, username]
  );
  return result.rows[0] || null;
}

/**
 * Owners whose gym phone normalizes to the same E.164 number.
 * @param {string} phoneInput
 * @returns {Promise<Array<{ id: number, role: string, phone: string }>>}
 */
async function findGymOwnersByPhone(phoneInput) {
  const normalized = normalizeEthiopianPhone(phoneInput);
  if (!normalized) return [];

  const result = await db.query(
    `
    SELECT u.id, u.role, g.phone
    FROM Users u
    JOIN Gyms g ON g.id = u.gym_id
    WHERE u.role = $1
      AND g.phone IS NOT NULL
      AND BTRIM(g.phone) <> ''
    `,
    [ROLES.GYM_OWNER]
  );

  return result.rows.filter((row) => normalizeEthiopianPhone(row.phone) === normalized);
}

/**
 * Login lookup: email, username, or unique gym-owner phone.
 * @param {string} identifier
 * @returns {Promise<object | null>} full Users row
 */
async function findUserForLogin(identifier) {
  const trimmed = String(identifier || '').trim();
  if (!trimmed) return null;

  const byAccount = await db.query(
    `
    SELECT * FROM Users
    WHERE LOWER(email) = LOWER($1)
       OR (username IS NOT NULL AND LOWER(username) = LOWER($1))
    LIMIT 1
    `,
    [trimmed]
  );
  if (byAccount.rows.length > 0) return byAccount.rows[0];

  const phone = normalizeEthiopianPhone(trimmed);
  if (!phone) return null;

  const owners = await findGymOwnersByPhone(phone);
  if (owners.length !== 1) return null;

  const full = await db.query('SELECT * FROM Users WHERE id = $1', [owners[0].id]);
  return full.rows[0] || null;
}

module.exports = {
  findGymOwnerByUsername,
  findGymOwnersByPhone,
  findUserForLogin,
};
