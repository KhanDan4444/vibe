/**
 * @file afroMessage.js
 * @description Afro Message SMS API client (OTP + transactional SMS).
 * @see https://www.afromessage.com/developers
 */

const BASE_URL = 'https://api.afromessage.com/api';

function isSmsConfigured() {
  return Boolean(process.env.AFRO_MESSAGE_TOKEN?.trim());
}

function authHeaders() {
  const token = process.env.AFRO_MESSAGE_TOKEN?.trim();
  if (!token) {
    const err = new Error('SMS is not configured on this server.');
    err.statusCode = 503;
    throw err;
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function otpTtlSeconds() {
  const n = Number(process.env.AFRO_MESSAGE_OTP_TTL || 600);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

function otpLength() {
  const n = Number(process.env.AFRO_MESSAGE_OTP_LENGTH || 6);
  return Number.isFinite(n) && n >= 4 && n <= 8 ? Math.floor(n) : 6;
}

function optionalAfroField(envValue) {
  const trimmed = envValue?.trim();
  return trimmed || null;
}

function appendOptionalAfroParams(params, { senderKey = 'sender', fromKey = 'from' } = {}) {
  const sender = optionalAfroField(process.env.AFRO_MESSAGE_SENDER);
  const from = optionalAfroField(process.env.AFRO_MESSAGE_FROM);
  if (sender) params.set(senderKey, sender);
  if (from) params.set(fromKey, from);
}

function optionalAfroBodyFields() {
  const body = {};
  const sender = optionalAfroField(process.env.AFRO_MESSAGE_SENDER);
  const from = optionalAfroField(process.env.AFRO_MESSAGE_FROM);
  if (sender) body.sender = sender;
  if (from) body.from = from;
  return body;
}

/**
 * @param {import('node-fetch').Response} res
 */
async function parseAfroJson(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    const err = new Error('Invalid response from SMS provider.');
    err.statusCode = 502;
    throw err;
  }

  if (!res.ok || body.acknowledge !== 'success') {
    const msg =
      body.response?.errors?.join?.(' ') ||
      body.response?.status ||
      `SMS provider error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.statusCode = res.ok ? 400 : res.status >= 500 ? 502 : 400;
    throw err;
  }

  return body.response;
}

/**
 * Send OTP via Afro /challenge.
 * @param {string} to E.164 phone (+251…)
 * @param {{ prefix?: string, postfix?: string }} [options]
 */
async function sendOtp(to, options = {}) {
  if (!isSmsConfigured()) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const verificationId = `dev-${Date.now()}`;
    console.log(
      `[SMS] (Afro not configured — dev OTP)\nTo: ${to}\nCode: ${code}\nVerificationId: ${verificationId}\n---`
    );
    return {
      code,
      verificationId,
      message_id: verificationId,
      to,
      status: 'dev-logged',
    };
  }

  const params = new URLSearchParams({
    to,
    len: String(otpLength()),
    t: '0',
    ttl: String(otpTtlSeconds()),
    pr: options.prefix || 'Your VibeSaaS verification code is',
    ps: options.postfix || '',
    sb: '1',
    sa: '1',
  });
  appendOptionalAfroParams(params);

  const res = await fetch(`${BASE_URL}/challenge?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  const response = await parseAfroJson(res);
  return {
    code: response.code,
    verificationId: response.verificationId,
    message_id: response.message_id,
    to: response.to,
    status: response.status,
  };
}

/**
 * Verify OTP via Afro /verify.
 * @param {{ verificationId?: string, phone?: string, code: string }} params
 */
async function verifyOtp({ verificationId, phone, code }) {
  if (!isSmsConfigured()) {
    console.log(`[SMS] (dev) verifyOtp vc=${verificationId} code=${code}`);
    if (!code || code.length < 4) {
      const err = new Error('Invalid verification code.');
      err.statusCode = 400;
      throw err;
    }
    return { phone: phone || '', code, verificationId: verificationId || 'dev' };
  }

  const params = new URLSearchParams({ code: String(code).trim() });
  if (verificationId) params.set('vc', verificationId);
  else if (phone) params.set('to', phone);
  else {
    const err = new Error('Verification session is invalid.');
    err.statusCode = 400;
    throw err;
  }

  const res = await fetch(`${BASE_URL}/verify?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  return parseAfroJson(res);
}

/**
 * Send a transactional SMS via POST /send.
 * @param {string} to
 * @param {string} message
 */
async function sendSms(to, message) {
  if (!isSmsConfigured()) {
    console.log(`[SMS] (Afro not configured — logging only)\nTo: ${to}\n---\n${message}\n---`);
    return { message_id: `dev-${Date.now()}`, to, status: 'dev-logged' };
  }

  const body = {
    to,
    message,
    ...optionalAfroBodyFields(),
  };

  const res = await fetch(`${BASE_URL}/send`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  return parseAfroJson(res);
}

module.exports = {
  isSmsConfigured,
  sendOtp,
  verifyOtp,
  sendSms,
  otpTtlSeconds,
};
