/**
 * @file telegramLink.js
 * @description Member ↔ Telegram chat linking via one-time /start tokens.
 */

const crypto = require('crypto');
const db = require('../config/db');
const { botUsername, isTelegramConfigured } = require('./telegramBot');

const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomToken(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

function buildDeepLink(token) {
  const username = botUsername();
  if (!username || !token) return null;
  return `https://t.me/${username}?start=${encodeURIComponent(token)}`;
}

/**
 * Invalidate unused tokens for a member, then create a fresh link token.
 * @param {number} memberId
 */
async function createLinkToken(memberId) {
  await db.query(
    `
    UPDATE TelegramLinkTokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE member_id = $1 AND used_at IS NULL
    `,
    [memberId]
  );

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = randomToken(6);
    try {
      await db.query(
        `
        INSERT INTO TelegramLinkTokens (member_id, token, expires_at)
        VALUES ($1, $2, $3)
        `,
        [memberId, token, expiresAt.toISOString()]
      );
      return {
        token,
        link: buildDeepLink(token),
        expires_at: expiresAt.toISOString(),
        expires_in_seconds: Math.floor(TOKEN_TTL_MS / 1000),
      };
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }

  const err = new Error('Could not generate a unique Telegram link token.');
  err.statusCode = 500;
  throw err;
}

/**
 * Link a Telegram chat to a member using a /start token.
 * @param {string} token
 * @param {number|string} chatId
 */
async function consumeLinkToken(token, chatId) {
  const normalizedToken = String(token || '').trim().toUpperCase();
  const normalizedChatId = Number(chatId);
  if (!normalizedToken || !Number.isFinite(normalizedChatId)) {
    return { ok: false, error: 'invalid_token' };
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const tokenRow = await client.query(
      `
      SELECT t.id, t.member_id, t.expires_at, t.used_at,
             m.name AS member_name, m.end_date,
             g.name AS gym_name,
             p.name AS plan_name, p.duration AS plan_duration
      FROM TelegramLinkTokens t
      INNER JOIN Members m ON m.id = t.member_id
      INNER JOIN Gyms g ON g.id = m.gym_id
      LEFT JOIN Plans p ON p.id = m.plan_id
      WHERE t.token = $1
      FOR UPDATE OF t
      `,
      [normalizedToken]
    );

    const row = tokenRow.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'token_not_found' };
    }
    if (row.used_at) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'token_used' };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'token_expired' };
    }

    const existing = await client.query(
      `
      SELECT id, name FROM Members
      WHERE telegram_chat_id = $1 AND id <> $2 AND deleted_at IS NULL
      LIMIT 1
      `,
      [normalizedChatId, row.member_id]
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'chat_already_linked' };
    }

    await client.query(
      `
      UPDATE Members
      SET telegram_chat_id = $1,
          telegram_linked_at = CURRENT_TIMESTAMP,
          preferred_channel = 'telegram'
      WHERE id = $2
      `,
      [normalizedChatId, row.member_id]
    );

    await client.query(
      `
      UPDATE TelegramLinkTokens
      SET used_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.id]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      memberId: row.member_id,
      memberName: row.member_name,
      gymName: row.gym_name,
      planName: row.plan_name || null,
      planDuration: row.plan_duration != null ? Number(row.plan_duration) : null,
      endDate: row.end_date || null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unlink Telegram for the member owning this chat id.
 * @param {number|string} chatId
 */
async function unlinkTelegramChat(chatId) {
  const normalizedChatId = Number(chatId);
  if (!Number.isFinite(normalizedChatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const result = await db.query(
    `
    UPDATE Members
    SET telegram_chat_id = NULL,
        telegram_linked_at = NULL,
        preferred_channel = 'sms'
    WHERE telegram_chat_id = $1 AND deleted_at IS NULL
    RETURNING id, name
    `,
    [normalizedChatId]
  );

  if (!result.rows[0]) {
    return { ok: false, error: 'not_linked' };
  }

  return { ok: true, member: result.rows[0] };
}

module.exports = {
  TOKEN_TTL_MS,
  isTelegramConfigured,
  buildDeepLink,
  createLinkToken,
  consumeLinkToken,
  unlinkTelegramChat,
};
