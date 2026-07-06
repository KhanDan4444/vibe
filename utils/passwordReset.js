/**
 * @file passwordReset.js
 * @description Token generation and persistence for password reset flow.
 */

const crypto = require('crypto');
const db = require('../config/db');

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function generateResetToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createPasswordResetToken(userId) {
  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.query('DELETE FROM PasswordResetTokens WHERE user_id = $1', [userId]);
  await db.query(
    `INSERT INTO PasswordResetTokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { token, expiresAt };
}

async function findUserIdByResetToken(token) {
  const tokenHash = hashResetToken(token);
  const result = await db.query(
    `
    SELECT user_id
    FROM PasswordResetTokens
    WHERE token_hash = $1 AND expires_at > NOW()
  `,
    [tokenHash]
  );
  return result.rows[0]?.user_id ?? null;
}

async function consumeResetToken(token) {
  const tokenHash = hashResetToken(token);
  const result = await db.query(
    `
    DELETE FROM PasswordResetTokens
    WHERE token_hash = $1 AND expires_at > NOW()
    RETURNING user_id
  `,
    [tokenHash]
  );
  return result.rows[0]?.user_id ?? null;
}

module.exports = {
  generateResetToken,
  createPasswordResetToken,
  findUserIdByResetToken,
  consumeResetToken,
  TOKEN_TTL_MS,
};
