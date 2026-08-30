/**
 * @file phoneOtp.js
 * @description Server-side OTP session storage (links Afro verificationId to app flows).
 */

const crypto = require('crypto');
const db = require('../config/db');
const {
  sendOtp,
  createManagedOtp,
  sendManagedOtp,
  otpTtlSeconds,
  verifyOtp,
} = require('./smsProvider');
const { normalizeEthiopianPhone } = require('./phone');
const { logOtpSms } = require('./notificationSms');

const PURPOSE = Object.freeze({
  FORGOT_PASSWORD: 'forgot_password',
  GYM_SIGNUP: 'gym_signup',
});

const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);

function sessionTtlMs() {
  return otpTtlSeconds() * 1000;
}

function otpSmsOptions(purpose) {
  return {
    prefix:
      purpose === PURPOSE.GYM_SIGNUP
        ? 'Your registration code is'
        : 'Your password reset code is',
    postfix: '',
  };
}

function otpAdvisoryLockKeys(purpose, normalized, meta = {}) {
  const key = meta.userId ? `${purpose}:user:${meta.userId}` : `${purpose}:${normalized}`;
  const hash = crypto.createHash('sha256').update(key).digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

async function clearExistingSessions(client, purpose, normalized, meta = {}) {
  if (purpose === PURPOSE.FORGOT_PASSWORD && meta.userId) {
    await client.query('DELETE FROM PhoneOtpSessions WHERE purpose = $1 AND user_id = $2', [
      purpose,
      meta.userId,
    ]);
    return;
  }
  await client.query('DELETE FROM PhoneOtpSessions WHERE purpose = $1 AND phone = $2', [
    purpose,
    normalized,
  ]);
}

async function findRecentActiveSession(client, purpose, normalized, meta = {}) {
  const cooldown = Number.isFinite(OTP_RESEND_COOLDOWN_SECONDS)
    ? Math.max(0, Math.floor(OTP_RESEND_COOLDOWN_SECONDS))
    : 60;
  if (cooldown <= 0) return null;

  const params = [purpose, cooldown];
  let userClause = '';
  if (purpose === PURPOSE.FORGOT_PASSWORD && meta.userId) {
    userClause = 'AND user_id = $3';
    params.push(meta.userId);
  } else {
    userClause = 'AND phone = $3';
    params.push(normalized);
  }

  const result = await client.query(
    `
    SELECT id, expires_at
    FROM PhoneOtpSessions
    WHERE purpose = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
      AND created_at > NOW() - ($2::int * INTERVAL '1 second')
      ${userClause}
    ORDER BY created_at DESC
    LIMIT 1
    `,
    params
  );
  return result.rows[0] || null;
}

async function insertOtpSession(client, {
  sessionId,
  purpose,
  normalized,
  verificationId,
  userId,
  expiresAt,
}) {
  await client.query(
    `
    INSERT INTO PhoneOtpSessions (id, purpose, phone, verification_id, user_id, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [sessionId, purpose, normalized, verificationId, userId ?? null, expiresAt]
  );
}

async function logOtpDelivery(purpose, normalized, otpResult) {
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

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const [lockA, lockB] = otpAdvisoryLockKeys(purpose, normalized, meta);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lockA, lockB]);

    const recent = await findRecentActiveSession(client, purpose, normalized, meta);
    if (recent) {
      await client.query('COMMIT');
      return {
        sessionId: recent.id,
        expiresAt: recent.expires_at,
        phone: normalized,
        reused: true,
      };
    }

    const smsOptions = otpSmsOptions(purpose);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + sessionTtlMs());
    await clearExistingSessions(client, purpose, normalized, meta);

    const managed = createManagedOtp(normalized);
    if (managed) {
      await insertOtpSession(client, {
        sessionId,
        purpose,
        normalized,
        verificationId: managed.verificationId,
        userId: meta.userId,
        expiresAt,
      });

      const otpResult = await sendManagedOtp(normalized, managed, smsOptions);
      await client.query('COMMIT');
      await logOtpDelivery(purpose, normalized, otpResult);
      return { sessionId, expiresAt, phone: normalized };
    }

    const otpResult = await sendOtp(normalized, smsOptions);
    await insertOtpSession(client, {
      sessionId,
      purpose,
      normalized,
      verificationId: otpResult.verificationId,
      userId: meta.userId,
      expiresAt,
    });
    await client.query('COMMIT');
    await logOtpDelivery(purpose, normalized, otpResult);

    return { sessionId, expiresAt, phone: normalized };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getActiveSession(sessionId, purpose) {
  const result = await db.query(
    `
    SELECT id, purpose, phone, verification_id, user_id, expires_at, verified_at, consumed_at
    FROM PhoneOtpSessions
    WHERE id = $1 AND purpose = $2 AND expires_at > NOW() AND consumed_at IS NULL
    `,
    [sessionId, purpose]
  );
  return result.rows[0] || null;
}

async function markSessionVerified(sessionId) {
  await db.query(
    `UPDATE PhoneOtpSessions SET verified_at = CURRENT_TIMESTAMP WHERE id = $1 AND verified_at IS NULL`,
    [sessionId]
  );
}

/**
 * Verify OTP for an active session and mark it verified (for multi-step flows).
 */
async function verifyPhoneOtpSession({ sessionId, purpose, phone, code }) {
  const session = await getActiveSession(sessionId, purpose);
  if (!session) {
    const err = new Error('Verification session expired. Request a new code.');
    err.statusCode = 400;
    throw err;
  }
  const normalized = normalizeEthiopianPhone(phone);
  if (!normalized || session.phone !== normalized) {
    const err = new Error('Phone number does not match the verified session.');
    err.statusCode = 400;
    throw err;
  }
  if (session.verified_at) {
    return session;
  }
  await verifyOtp({
    verificationId: session.verification_id,
    phone: session.phone,
    code,
  });
  await markSessionVerified(sessionId);
  return session;
}

async function consumeSession(sessionId) {
  await db.query(
    `UPDATE PhoneOtpSessions SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sessionId]
  );
}

const GENERIC_OTP_SENT =
  'If an account exists for that username, a verification code has been sent to the registered phone.';

const OTP_ALREADY_SENT =
  'A verification code was already sent recently. Check your messages or wait a minute before requesting another.';

/** Same shape as a real OTP response — prevents account enumeration via missing sessionId. */
function createDecoyOtpSession() {
  return {
    sessionId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + sessionTtlMs()),
  };
}

function buildOtpRequestPayload(sessionId, expiresAt, reused = false) {
  return {
    message: reused ? OTP_ALREADY_SENT : GENERIC_OTP_SENT,
    sessionId,
    expiresAt,
    reused: Boolean(reused),
  };
}

function buildGymSignupOtpPayload(sessionId, expiresAt, reused = false) {
  return {
    message: reused
      ? OTP_ALREADY_SENT
      : 'Verification code sent to your phone.',
    sessionId,
    expiresAt,
    reused: Boolean(reused),
  };
}

module.exports = {
  PURPOSE,
  startPhoneOtpSession,
  getActiveSession,
  markSessionVerified,
  verifyPhoneOtpSession,
  consumeSession,
  createDecoyOtpSession,
  buildOtpRequestPayload,
  buildGymSignupOtpPayload,
  GENERIC_OTP_SENT,
  OTP_ALREADY_SENT,
  normalizeEthiopianPhone,
};
