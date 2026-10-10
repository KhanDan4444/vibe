/**
 * @file telegramLink.js
 * @description Member/gym ↔ Telegram chat linking via one-time /start tokens.
 */

const crypto = require('crypto');
const db = require('../config/db');
const { botUsername, isTelegramConfigured } = require('./telegramBot');
const { clearStationDevicesForMember } = require('./stationSelfCheckIn');

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

async function insertLinkToken({ memberId = null, gymId = null }) {
  if ((memberId == null) === (gymId == null)) {
    const err = new Error('Link token requires exactly one of memberId or gymId.');
    err.statusCode = 500;
    throw err;
  }

  const targetCol = memberId != null ? 'member_id' : 'gym_id';
  const targetId = memberId != null ? memberId : gymId;

  await db.query(
    `
    UPDATE TelegramLinkTokens
    SET used_at = CURRENT_TIMESTAMP
    WHERE ${targetCol} = $1 AND used_at IS NULL
    `,
    [targetId]
  );

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = randomToken(6);
    try {
      await db.query(
        `
        INSERT INTO TelegramLinkTokens (member_id, gym_id, token, expires_at)
        VALUES ($1, $2, $3, $4)
        `,
        [memberId, gymId, token, expiresAt.toISOString()]
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
 * Invalidate unused tokens for a member, then create a fresh link token.
 * @param {number} memberId
 */
async function createLinkToken(memberId) {
  return insertLinkToken({ memberId });
}

/**
 * Invalidate unused tokens for a gym, then create a fresh owner link token.
 * @param {number} gymId
 */
async function createGymLinkToken(gymId) {
  return insertLinkToken({ gymId });
}

/**
 * Link a Telegram chat using a /start token (member or gym).
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
      SELECT t.id, t.member_id, t.gym_id, t.expires_at, t.used_at,
             m.name AS member_name, m.end_date,
             g_member.name AS member_gym_name,
             p.name AS plan_name, p.duration AS plan_duration,
             g_direct.name AS gym_name
      FROM TelegramLinkTokens t
      LEFT JOIN Members m ON m.id = t.member_id
      LEFT JOIN Gyms g_member ON g_member.id = m.gym_id
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Gyms g_direct ON g_direct.id = t.gym_id
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

    const memberConflict = await client.query(
      `
      SELECT id, name FROM Members
      WHERE telegram_chat_id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR id <> $2)
      LIMIT 1
      `,
      [normalizedChatId, row.member_id]
    );
    if (memberConflict.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'chat_already_linked' };
    }

    const gymConflict = await client.query(
      `
      SELECT id, name FROM Gyms
      WHERE telegram_chat_id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR id <> $2)
      LIMIT 1
      `,
      [normalizedChatId, row.gym_id]
    );
    if (gymConflict.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'chat_already_linked' };
    }

    if (row.member_id != null) {
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
    } else if (row.gym_id != null) {
      await client.query(
        `
        UPDATE Gyms
        SET telegram_chat_id = $1,
            telegram_linked_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND deleted_at IS NULL
        `,
        [normalizedChatId, row.gym_id]
      );
    } else {
      await client.query('ROLLBACK');
      return { ok: false, error: 'invalid_token' };
    }

    await client.query(
      `
      UPDATE TelegramLinkTokens
      SET used_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [row.id]
    );

    await client.query('COMMIT');

    if (row.member_id != null) {
      return {
        ok: true,
        kind: 'member',
        memberId: row.member_id,
        memberName: row.member_name,
        gymName: row.member_gym_name,
        planName: row.plan_name || null,
        planDuration: row.plan_duration != null ? Number(row.plan_duration) : null,
        endDate: row.end_date || null,
      };
    }

    return {
      ok: true,
      kind: 'gym',
      gymId: row.gym_id,
      gymName: row.gym_name,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unlink Telegram for the member or gym owning this chat id.
 * Prefer member unlink when both somehow exist (should not).
 * @param {number|string} chatId
 */
async function unlinkTelegramChat(chatId) {
  const normalizedChatId = Number(chatId);
  if (!Number.isFinite(normalizedChatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const memberResult = await db.query(
    `
    UPDATE Members
    SET telegram_chat_id = NULL,
        telegram_linked_at = NULL,
        preferred_channel = NULL
    WHERE telegram_chat_id = $1 AND deleted_at IS NULL
    RETURNING id, name
    `,
    [normalizedChatId]
  );

  if (memberResult.rows[0]) {
    await clearStationDevicesForMember(memberResult.rows[0].id);
    return { ok: true, kind: 'member', member: memberResult.rows[0] };
  }

  const gymResult = await db.query(
    `
    UPDATE Gyms
    SET telegram_chat_id = NULL,
        telegram_linked_at = NULL
    WHERE telegram_chat_id = $1 AND deleted_at IS NULL
    RETURNING id, name
    `,
    [normalizedChatId]
  );

  if (gymResult.rows[0]) {
    return { ok: true, kind: 'gym', gym: gymResult.rows[0] };
  }

  return { ok: false, error: 'not_linked' };
}

/**
 * Staff-initiated unlink for a member by id.
 * @param {number} memberId
 */
async function unlinkTelegramMember(memberId) {
  const id = Number(memberId);
  if (!Number.isFinite(id)) {
    return { ok: false, error: 'invalid_member_id' };
  }

  const result = await db.query(
    `
    UPDATE Members
    SET telegram_chat_id = NULL,
        telegram_linked_at = NULL,
        preferred_channel = NULL
    WHERE id = $1 AND deleted_at IS NULL AND telegram_chat_id IS NOT NULL
    RETURNING id, name
    `,
    [id]
  );

  if (!result.rows[0]) {
    const exists = await db.query(`SELECT id FROM Members WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists.rows[0]) {
      return { ok: false, error: 'member_not_found' };
    }
    return { ok: false, error: 'not_linked' };
  }

  await clearStationDevicesForMember(id);

  return { ok: true, member: result.rows[0] };
}

/**
 * Owner-initiated unlink for their gym.
 * @param {number} gymId
 */
async function unlinkTelegramGym(gymId) {
  const id = Number(gymId);
  if (!Number.isFinite(id)) {
    return { ok: false, error: 'invalid_gym_id' };
  }

  const result = await db.query(
    `
    UPDATE Gyms
    SET telegram_chat_id = NULL,
        telegram_linked_at = NULL
    WHERE id = $1 AND deleted_at IS NULL AND telegram_chat_id IS NOT NULL
    RETURNING id, name
    `,
    [id]
  );

  if (!result.rows[0]) {
    const exists = await db.query(`SELECT id FROM Gyms WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists.rows[0]) {
      return { ok: false, error: 'gym_not_found' };
    }
    return { ok: false, error: 'not_linked' };
  }

  return { ok: true, gym: result.rows[0] };
}

module.exports = {
  TOKEN_TTL_MS,
  isTelegramConfigured,
  buildDeepLink,
  createLinkToken,
  createGymLinkToken,
  consumeLinkToken,
  unlinkTelegramChat,
  unlinkTelegramMember,
  unlinkTelegramGym,
};
