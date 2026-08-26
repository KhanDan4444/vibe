/**
 * @file hahuMessage.js
 * @description hahu.io Android-device SMS gateway client.
 * @see https://hahu.io/dashboard/docs (login required)
 * @see https://hahu.io/api/send/sms
 */

const BASE_URL = (process.env.HAHU_API_BASE || 'https://hahu.io').replace(/\/$/, '');

function isHahuConfigured() {
  return Boolean(process.env.HAHU_API_SECRET?.trim() && process.env.HAHU_DEVICE_ID?.trim());
}

function hahuSim() {
  const n = Number(process.env.HAHU_SIM || 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function hahuPriority() {
  const n = Number(process.env.HAHU_PRIORITY || 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Send a transactional SMS via the connected Android device.
 * @param {string} to E.164 phone (+251…)
 * @param {string} message
 */
async function sendSms(to, message) {
  if (!isHahuConfigured()) {
    console.log(`[SMS] (hahu not configured — logging only)\nTo: ${to}\n---\n${message}\n---`);
    return { message_id: `dev-${Date.now()}`, to, status: 'dev-logged' };
  }

  const text = String(message || '').trim();
  if (!text) {
    const err = new Error('SMS message is empty.');
    err.statusCode = 400;
    throw err;
  }

  const params = new URLSearchParams({
    secret: process.env.HAHU_API_SECRET.trim(),
    mode: 'devices',
    device: process.env.HAHU_DEVICE_ID.trim(),
    sim: String(hahuSim()),
    priority: String(hahuPriority()),
    phone: to,
    message: text,
  });

  const res = await fetch(`${BASE_URL}/api/send/sms?${params.toString()}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });

  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const msg =
      (body && (body.message || body.error || body.status)) ||
      `hahu.io SMS error (HTTP ${res.status})`;
    const err = new Error(typeof msg === 'string' ? msg : `hahu.io SMS error (HTTP ${res.status})`);
    err.statusCode = res.status >= 500 ? 502 : 400;
    throw err;
  }

  const data = body && typeof body === 'object' ? body.data || body : null;
  return {
    message_id: data?.id || data?.message_id || body?.id || `hahu-${Date.now()}`,
    to,
    status: data?.status || body?.status || 'queued',
    raw: body,
  };
}

module.exports = {
  isHahuConfigured,
  sendSms,
};
