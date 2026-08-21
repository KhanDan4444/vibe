/**
 * @file utils/memberPass.js
 * @description Signed member QR tokens for staff-scan check-in (Phase 3).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PASS_TYPE = 'member_pass';

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

/**
 * Public web URL for the member’s check-in pass page (SMS / share).
 * @param {{ gymId: number, memberId: number, passVersion?: number }} args
 * @returns {string|null}
 */
function buildPublicPassUrl({ gymId, memberId, passVersion }) {
  try {
    const token = signMemberPass({ gymId, memberId, passVersion });
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${frontendBase}/pass?t=${encodeURIComponent(token)}`;
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
  buildPublicPassUrl,
};
