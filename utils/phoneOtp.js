/**
 * @file phoneOtp.js
 * @description Server-side OTP session storage (links Afro verificationId to app flows).
 */

const crypto = require('crypto');
const db = require('../config/db');
const { sendOtp, otpTtlSeconds } = require('./afroMessage');
const { normalizeEthiopianPhone } = require('./phone');
const { logOtpSms } = require('./notificationSms');

const PURPOSE = Object.freeze({
  FORGOT_PASSWORD: 'forgot_password',
  GYM_SIGNUP: 'gym_signup',
});

function sessionTtlMs() {
  return otpTtlSeconds() * 1000;
}

/**
 * @param {'forgot_password'|'gym_signup'} purpose
 * @param {string} phone E.164
 * @param {{ userId?: number }} [meta]
 */
async function startPhoneOtpSession(purpose, phone, meta = {}) {
  const normalized = normalizeEthiopianPhone(phone);
  if (!normalized) {
    const err = new Error('Enter a valid Ethiopian mobile number.');
    err.statusCode = 400;
    throw err;
  }

  const otpResult = await sendOtp(normalized, {
    prefix: purpose === PURPOSE.GYM_SIGNUP
      ? 'Your VibeSaaS registration code is'
      : 'Your VibeSaaS password reset code is',
    postfix: '',
  });

  try {
    await logOtpSms({
      purpose,
      phone: normalized,
      messageId: otpResult.message_id || otpResult.verificationId,
      otpCode: otpResult.code ?? null,
    });
  } catch (logErr) {
    console.error('[SMS] OTP audit log failed:', logErr.message);
  }

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + sessionTtlMs());

  if (purpose === PURPOSE.FORGOT_PASSWORD && meta.userId) {
    await db.query('DELETE FROM PhoneOtpSessions WHERE purpose = $1 AND user_id = $2', [
      purpose,
      meta.userId,
    ]);
  } else {
    await db.query('DELETE FROM PhoneOtpSessions WHERE purpose = $1 AND phone = $2', [
      purpose,
      normalized,
    ]);
  }

  await db.query(
    `
    INSERT INTO PhoneOtpSessions (id, purpose, phone, verification_id, user_id, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [sessionId, purpose, normalized, otpResult.verificationId, meta.userId ?? null, expiresAt]
  );

  return { sessionId, expiresAt, phone: normalized };
}

async function getActiveSession(sessionId, purpose) {
  const result = await db.query(
    `
    SELECT id, purpose, phone, verification_id, user_id, expires_at, consumed_at
    FROM PhoneOtpSessions
    WHERE id = $1 AND purpose = $2 AND expires_at > NOW() AND consumed_at IS NULL
    `,
    [sessionId, purpose]
  );
  return result.rows[0] || null;
}

async function consumeSession(sessionId) {
  await db.query(
    `UPDATE PhoneOtpSessions SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sessionId]
  );
}

const GENERIC_OTP_SENT =
  'If an account exists for that username, a verification code has been sent to the registered phone.';

module.exports = {
  PURPOSE,
  startPhoneOtpSession,
  getActiveSession,
  consumeSession,
  GENERIC_OTP_SENT,
  normalizeEthiopianPhone,
};
