/**
 * @file smsProvider.js
 * @description SMS provider facade — Afro Message (cloud) or hahu.io (Android gateway).
 *
 * SMS_PROVIDER=hahu|afro  (optional; auto-detects from configured credentials)
 */

const crypto = require('crypto');
const afro = require('./afroMessage');
const hahu = require('./hahuMessage');

function resolveProvider() {
  const forced = String(process.env.SMS_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (forced === 'hahu' || forced === 'afro') return forced;
  if (hahu.isHahuConfigured()) return 'hahu';
  if (afro.isSmsConfigured()) return 'afro';
  return null;
}

function isSmsConfigured() {
  return resolveProvider() != null;
}

function otpTtlSeconds() {
  return afro.otpTtlSeconds();
}

function otpLength() {
  const n = Number(process.env.AFRO_MESSAGE_OTP_LENGTH || process.env.SMS_OTP_LENGTH || 6);
  return Number.isFinite(n) && n >= 4 && n <= 8 ? Math.floor(n) : 6;
}

function otpHmacSecret() {
  return (
    process.env.SMS_OTP_HMAC_SECRET?.trim() ||
    process.env.HAHU_API_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    'vibe-dev-otp'
  );
}

function hashOtpCode(code, phone) {
  return crypto
    .createHmac('sha256', otpHmacSecret())
    .update(`${String(code).trim()}|${String(phone || '').trim()}`)
    .digest('hex');
}

function generateOtpCode() {
  const len = otpLength();
  const max = 10 ** len;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(len, '0');
}

async function sendSms(to, message) {
  const provider = resolveProvider();
  if (provider === 'hahu') return hahu.sendSms(to, message);
  return afro.sendSms(to, message);
}

function buildOtpMessage(code, options = {}) {
  const prefix = options.prefix || 'Your verification code is';
  const postfix = options.postfix || '';
  return `${prefix} ${code}${postfix}`.trim();
}

/** Hahu / dev-local OTP: generate code + verification id without sending SMS yet. */
function createManagedOtp(to) {
  const provider = resolveProvider();
  if (provider === 'afro') return null;
  const code = generateOtpCode();
  const tag = provider === 'hahu' ? 'hahu' : 'local';
  return {
    code,
    verificationId: `${tag}:${hashOtpCode(code, to)}`,
    provider: tag,
  };
}

/** Send SMS for a managed OTP created with createManagedOtp. */
async function sendManagedOtp(to, managed, options = {}) {
  const message = buildOtpMessage(managed.code, options);
  if (managed.provider === 'hahu') {
    const result = await hahu.sendSms(to, message);
    return {
      code: managed.code,
      verificationId: managed.verificationId,
      message_id: result.message_id,
      to,
      status: result.status || 'queued',
    };
  }
  console.log(
    `[SMS] (no provider — dev OTP)\nTo: ${to}\nCode: ${managed.code}\nVerificationId: ${managed.verificationId}\n---`
  );
  return {
    code: managed.code,
    verificationId: managed.verificationId,
    message_id: managed.verificationId,
    to,
    status: 'dev-logged',
  };
}

/**
 * Send OTP. Afro uses /challenge; hahu generates a local code and sends SMS.
 * Prefer createManagedOtp + persist session + sendManagedOtp for hahu/dev to avoid SMS before DB write.
 */
async function sendOtp(to, options = {}) {
  const provider = resolveProvider();

  if (provider === 'hahu' || provider == null) {
    const managed = createManagedOtp(to);
    return sendManagedOtp(to, managed, options);
  }

  return afro.sendOtp(to, options);
}

/**
 * Verify OTP. Local/hahu codes are checked via HMAC; Afro uses /verify.
 */
async function verifyOtp({ verificationId, phone, code }) {
  const vc = String(verificationId || '');
  const trimmedCode = String(code || '').trim();

  if (vc.startsWith('hahu:') || vc.startsWith('local:')) {
    if (!trimmedCode || trimmedCode.length < 4) {
      const err = new Error('Invalid verification code.');
      err.statusCode = 400;
      throw err;
    }
    const expected = hashOtpCode(trimmedCode, phone);
    const actual = vc.slice(vc.indexOf(':') + 1);
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const err = new Error('Invalid verification code.');
      err.statusCode = 400;
      throw err;
    }
    return { phone: phone || '', code: trimmedCode, verificationId: vc };
  }

  if (!afro.isSmsConfigured()) {
    console.log(`[SMS] (dev) verifyOtp vc=${verificationId} code=${code}`);
    if (!trimmedCode || trimmedCode.length < 4) {
      const err = new Error('Invalid verification code.');
      err.statusCode = 400;
      throw err;
    }
    return { phone: phone || '', code: trimmedCode, verificationId: verificationId || 'dev' };
  }

  return afro.verifyOtp({ verificationId, phone, code: trimmedCode });
}

module.exports = {
  resolveProvider,
  isSmsConfigured,
  sendSms,
  sendOtp,
  createManagedOtp,
  sendManagedOtp,
  verifyOtp,
  otpTtlSeconds,
};
