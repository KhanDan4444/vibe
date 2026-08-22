/**
 * @file utils/memberPass.js
 * @description Signed member QR tokens for staff-scan check-in + short public SMS links.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const PASS_TYPE = 'member_pass';
const PUBLIC_CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const PUBLIC_CODE_LENGTH = 8;

function passSecret() {
  return process.env.MEMBER_PASS_SECRET || process.env.JWT_SECRET;
}

/**
 * @param {{ gymId: number, memberId: number, passVersion: number }} args
 * @returns {string}
 */
function signMemberPass({ gymId, memberId, passVersion }) {
  const secret = passSecret();
  if (!secret) {
    throw new Error('MEMBER_PASS_SECRET / JWT_SECRET is not configured.');
  }
  return jwt.sign(
    {
      typ: PASS_TYPE,
      gid: Number(gymId),
      mid: Number(memberId),
      pv: Number(passVersion) || 1,
    },
    secret,
    {
      algorithm: 'HS256',
      // Long-lived: identity pass, not a session. Invalidate via pass_version.
      expiresIn: '10y',
    }
  );
}

/**
 * @param {string} token
 * @returns {{ ok: true, gymId: number, memberId: number, passVersion: number } | { ok: false, error: string, code: string }}
 */
function verifyMemberPass(token) {
  const secret = passSecret();
  if (!secret) {
    return { ok: false, error: 'Pass verification is not configured.', code: 'PASS_CONFIG' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Invalid member pass.', code: 'PASS_INVALID' };
  }

  try {
    const payload = jwt.verify(token.trim(), secret, { algorithms: ['HS256'] });
    if (payload.typ !== PASS_TYPE) {
      return { ok: false, error: 'Invalid member pass.', code: 'PASS_INVALID' };
    }
    const gymId = Number(payload.gid);
    const memberId = Number(payload.mid);
    const passVersion = Number(payload.pv);
    if (!Number.isFinite(gymId) || !Number.isFinite(memberId) || !Number.isFinite(passVersion)) {
      return { ok: false, error: 'Invalid member pass.', code: 'PASS_INVALID' };
    }
    return { ok: true, gymId, memberId, passVersion };
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      return { ok: false, error: 'Member pass expired. Regenerate the QR.', code: 'PASS_EXPIRED' };
    }
    return { ok: false, error: 'Invalid member pass.', code: 'PASS_INVALID' };
  }
}

/** Stable fingerprint for logging without storing the raw token. */
function passFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}

function generatePassPublicCode() {
  const bytes = crypto.randomBytes(PUBLIC_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PUBLIC_CODE_LENGTH; i += 1) {
    out += PUBLIC_CODE_ALPHABET[bytes[i] % PUBLIC_CODE_ALPHABET.length];
  }
  return out;
}

function normalizePassPublicCode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Ensure the member has a stable short public code for SMS links.
 * @param {number} memberId
 * @returns {Promise<string>}
 */
async function ensurePassPublicCode(memberId) {
  const id = Number(memberId);
  if (!Number.isFinite(id)) {
    throw new Error('Invalid member id for pass public code.');
  }

  const existing = await db.query(
    `SELECT pass_public_code FROM Members WHERE id = $1`,
    [id]
  );
  if (existing.rows[0]?.pass_public_code) {
    return existing.rows[0].pass_public_code;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generatePassPublicCode();
    try {
      const updated = await db.query(
        `
        UPDATE Members
        SET pass_public_code = $1
        WHERE id = $2
          AND pass_public_code IS NULL
        RETURNING pass_public_code
        `,
        [code, id]
      );
      if (updated.rows[0]?.pass_public_code) {
        return updated.rows[0].pass_public_code;
      }
      const again = await db.query(`SELECT pass_public_code FROM Members WHERE id = $1`, [id]);
      if (again.rows[0]?.pass_public_code) {
        return again.rows[0].pass_public_code;
      }
    } catch (err) {
      if (err?.code === '23505') continue;
      throw err;
    }
  }

  throw new Error('Could not allocate a public pass code.');
}

/**
 * Rotate the short SMS link when the QR pass is regenerated.
 * @param {number} memberId
 * @returns {Promise<string>}
 */
async function rotatePassPublicCode(memberId) {
  const id = Number(memberId);
  if (!Number.isFinite(id)) {
    throw new Error('Invalid member id for pass public code.');
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generatePassPublicCode();
    try {
      const updated = await db.query(
        `
        UPDATE Members
        SET pass_public_code = $1
        WHERE id = $2
        RETURNING pass_public_code
        `,
        [code, id]
      );
      if (updated.rows[0]?.pass_public_code) {
        return updated.rows[0].pass_public_code;
      }
    } catch (err) {
      if (err?.code === '23505') continue;
      throw err;
    }
  }

  throw new Error('Could not rotate public pass code.');
}

/**
 * Public web URL for the member’s check-in pass page (SMS / share).
 * Uses a short /p/:code path — JWT stays only in the QR payload.
 * @param {{ memberId: number, gymId?: number, passVersion?: number }} args
 * @returns {Promise<string|null>}
 */
async function buildPublicPassUrl({ memberId }) {
  try {
    const code = await ensurePassPublicCode(memberId);
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${frontendBase}/p/${code}`;
  } catch (err) {
    console.error('[memberPass] Could not build public pass URL:', err.message);
    return null;
  }
}

module.exports = {
  PASS_TYPE,
  signMemberPass,
  verifyMemberPass,
  passFingerprint,
  generatePassPublicCode,
  normalizePassPublicCode,
  ensurePassPublicCode,
  rotatePassPublicCode,
  buildPublicPassUrl,
};
