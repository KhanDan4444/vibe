/**
 * @file stationSelfCheckIn.js
 * @description Member self check-in via station QR — Telegram OTP + trusted device.
 */

const crypto = require('crypto');
const db = require('../config/db');
const { normalizeEthiopianPhone } = require('./phone');
const { verifyStationPass, loadBranchStationContext } = require('./stationPass');
const {
  getGymAttendanceSettings,
  evaluateCheckInEligibility,
  mapCheckInRow,
} = require('./checkIns');
const { sendMessage: sendTelegramMessage, isTelegramConfigured } = require('./telegramBot');
const { ACTIONS, recordAuditLog } = require('./auditLog');

const STATION_DEVICE_COOKIE = 'vibe_station_trust';
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const DEVICE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function stationSecret() {
  return process.env.MEMBER_PASS_SECRET || process.env.JWT_SECRET;
}

function hashValue(value) {
  return crypto.createHmac('sha256', stationSecret()).update(String(value)).digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readDeviceToken(req) {
  const raw = req.cookies?.[STATION_DEVICE_COOKIE];
  return typeof raw === 'string' && raw.length >= 32 ? raw.trim() : null;
}

function setDeviceCookie(res, token) {
  res.cookie(STATION_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: DEVICE_MAX_AGE_MS,
    path: '/',
  });
}

function clearDeviceCookie(res) {
  res.clearCookie(STATION_DEVICE_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * @param {string} stationToken
 */
async function resolveStation(stationToken) {
  const verified = verifyStationPass(stationToken);
  if (!verified.ok) {
    return { ok: false, error: verified.error, code: verified.code };
  }

  const ctx = await loadBranchStationContext(verified.branchId, verified.gymId);
  if (!ctx || !ctx.is_active) {
    return { ok: false, error: 'This check-in station is not available.', code: 'STATION_UNAVAILABLE' };
  }
  if (Number(ctx.station_version) !== Number(verified.stationVersion)) {
    return {
      ok: false,
      error: 'This QR code was replaced. Scan the new poster at the gym.',
      code: 'STATION_STALE',
    };
  }
  if (!ctx.station_self_checkin) {
    return {
      ok: false,
      error: 'Self check-in is not enabled at this gym.',
      code: 'SELF_CHECKIN_DISABLED',
    };
  }

  return {
    ok: true,
    gymId: ctx.gym_id,
    branchId: ctx.id,
    gymName: ctx.gym_name,
    branchName: ctx.branch_name,
    stationVersion: Number(ctx.station_version) || 1,
  };
}

const { findMemberByPhone } = require('./memberPhone');

async function loadTrustedMember(station, deviceToken) {
  if (!deviceToken) return null;
  const tokenHash = hashValue(deviceToken);

  const result = await db.query(
    `
    SELECT d.id AS device_id, d.telegram_linked_at,
           m.id, m.name, m.phone, m.branch_id, m.end_date, m.deleted_at,
           m.telegram_chat_id, m.telegram_linked_at AS member_telegram_linked_at,
           p.name AS plan_name, b.name AS branch_name
    FROM StationCheckInDevices d
    INNER JOIN Members m ON m.id = d.member_id
    LEFT JOIN Plans p ON p.id = m.plan_id
    LEFT JOIN Branches b ON b.id = m.branch_id
    WHERE d.token_hash = $1
      AND m.gym_id = $2
      AND m.deleted_at IS NULL
      AND m.telegram_chat_id IS NOT NULL
    LIMIT 1
    `,
    [tokenHash, station.gymId]
  );

  const row = result.rows[0];
  if (!row) return null;

  if (row.member_telegram_linked_at && row.telegram_linked_at) {
    const memberLinkedAt = new Date(row.member_telegram_linked_at).getTime();
    const deviceLinkedAt = new Date(row.telegram_linked_at).getTime();
    if (memberLinkedAt > deviceLinkedAt) {
      return null;
    }
  }

  if (row.branch_id && Number(row.branch_id) !== Number(station.branchId)) {
    return null;
  }

  await db.query(`UPDATE StationCheckInDevices SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`, [
    row.device_id,
  ]);

  return row;
}

async function clearStationDevicesForMember(memberId) {
  await db.query(`DELETE FROM StationCheckInDevices WHERE member_id = $1`, [memberId]);
}

async function issueDeviceTrust(memberId, res) {
  const memberRow = await db.query(
    `SELECT telegram_linked_at FROM Members WHERE id = $1 AND deleted_at IS NULL`,
    [memberId]
  );
  const linkedAt = memberRow.rows[0]?.telegram_linked_at;
  if (!linkedAt) return null;

  const token = generateDeviceToken();
  const tokenHash = hashValue(token);

  await db.query(`DELETE FROM StationCheckInDevices WHERE member_id = $1`, [memberId]);
  await db.query(
    `
    INSERT INTO StationCheckInDevices (member_id, token_hash, telegram_linked_at)
    VALUES ($1, $2, $3)
    `,
    [memberId, tokenHash, linkedAt]
  );

  setDeviceCookie(res, token);
  return token;
}

async function getStationSession(stationToken, req) {
  const station = await resolveStation(stationToken);
  if (!station.ok) {
    return {
      ok: false,
      error: station.error,
      code: station.code,
      status: station.code === 'SELF_CHECKIN_DISABLED' ? 403 : 400,
    };
  }

  const deviceToken = readDeviceToken(req);
  const trustedMember = await loadTrustedMember(station, deviceToken);

  return {
    ok: true,
    gym_name: station.gymName,
    branch_name: station.branchName,
    telegram_configured: isTelegramConfigured(),
    trusted: trustedMember
      ? {
          member_id: trustedMember.id,
          member_name: trustedMember.name,
          phone_masked: trustedMember.phone,
        }
      : null,
  };
}

async function requestStationOtp(stationToken, phoneInput) {
  const station = await resolveStation(stationToken);
  if (!station.ok) {
    return { ok: false, error: station.error, code: station.code, status: 400 };
  }

  if (!isTelegramConfigured()) {
    return {
      ok: false,
      error: 'Telegram check-in is not available right now. Ask staff at the desk.',
      code: 'TELEGRAM_NOT_CONFIGURED',
      status: 503,
    };
  }

  const normalized = normalizeEthiopianPhone(phoneInput);
  if (!normalized) {
    return { ok: false, error: 'Enter a valid Ethiopian mobile number.', code: 'PHONE_INVALID', status: 400 };
  }

  const member = await findMemberByPhone(station.gymId, phoneInput);
  if (!member) {
    return {
      ok: true,
      session_id: null,
      message: 'If this number is on file, a code was sent to Telegram.',
      generic: true,
    };
  }

  if (!member.telegram_chat_id) {
    return {
      ok: false,
      error: 'Link Telegram at the front desk before using self check-in.',
      code: 'TELEGRAM_NOT_LINKED',
      status: 400,
    };
  }

  if (member.branch_id && Number(member.branch_id) !== Number(station.branchId)) {
    return {
      ok: false,
      error: 'Your membership is registered at another branch. Check in at that location.',
      code: 'WRONG_BRANCH',
      status: 400,
    };
  }

  const recent = await db.query(
    `
    SELECT created_at
    FROM StationCheckInOtpSessions
    WHERE member_id = $1
      AND consumed_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [member.id]
  );
  if (recent.rows[0]) {
    const elapsed = Date.now() - new Date(recent.rows[0].created_at).getTime();
    if (elapsed < OTP_COOLDOWN_MS) {
      return {
        ok: false,
        error: 'Please wait a moment before requesting another code.',
        code: 'OTP_COOLDOWN',
        status: 429,
      };
    }
  }

  const otp = generateOtpCode();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.query(
    `
    INSERT INTO StationCheckInOtpSessions
      (id, member_id, branch_id, gym_id, phone, otp_code_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [sessionId, member.id, station.branchId, station.gymId, normalized, hashValue(otp), expiresAt.toISOString()]
  );

  const message = `Your ${station.gymName} check-in code: ${otp}\n\nValid for 10 minutes.`;
  try {
    await sendTelegramMessage(member.telegram_chat_id, message);
  } catch {
    return {
      ok: false,
      error: 'Could not send the code to Telegram. Try again or ask staff at the desk.',
      code: 'TELEGRAM_SEND_FAILED',
      status: 502,
    };
  }

  return {
    ok: true,
    session_id: sessionId,
    phone_masked: normalized,
    expires_in_seconds: Math.floor(OTP_TTL_MS / 1000),
    message: 'We sent a 6-digit code to your Telegram.',
  };
}

async function verifyStationOtp(stationToken, { sessionId, otp, phone }, res) {
  const station = await resolveStation(stationToken);
  if (!station.ok) {
    return { ok: false, error: station.error, code: station.code, status: 400 };
  }

  const code = String(otp || '').replace(/\D/g, '');
  if (code.length !== 6) {
    return { ok: false, error: 'Enter the 6-digit code.', code: 'OTP_INVALID', status: 400 };
  }
  if (!sessionId) {
    return { ok: false, error: 'Verification session expired. Request a new code.', code: 'SESSION_MISSING', status: 400 };
  }

  const sessionRow = await db.query(
    `
    SELECT s.*, m.name AS member_name, m.telegram_chat_id, m.branch_id, m.deleted_at
    FROM StationCheckInOtpSessions s
    INNER JOIN Members m ON m.id = s.member_id
    WHERE s.id = $1 AND s.gym_id = $2 AND s.branch_id = $3
    `,
    [sessionId, station.gymId, station.branchId]
  );
  const session = sessionRow.rows[0];
  if (!session || session.consumed_at) {
    return { ok: false, error: 'Verification session expired. Request a new code.', code: 'SESSION_EXPIRED', status: 400 };
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Code expired. Request a new one.', code: 'OTP_EXPIRED', status: 400 };
  }

  const normalized = normalizeEthiopianPhone(phone);
  if (!normalized || normalized !== session.phone) {
    return { ok: false, error: 'Phone number does not match.', code: 'PHONE_MISMATCH', status: 400 };
  }

  if (hashValue(code) !== session.otp_code_hash) {
    return { ok: false, error: 'Incorrect code. Try again.', code: 'OTP_WRONG', status: 400 };
  }

  await db.query(
    `
    UPDATE StationCheckInOtpSessions
    SET verified_at = CURRENT_TIMESTAMP, consumed_at = CURRENT_TIMESTAMP
    WHERE id = $1
    `,
    [sessionId]
  );

  await issueDeviceTrust(session.member_id, res);

  const checkIn = await performStationCheckIn(station, session.member_id, { viaOtp: true });
  if (!checkIn.ok) {
    return checkIn;
  }

  return {
    ok: true,
    ...checkIn,
    member_name: session.member_name,
    trusted: true,
  };
}

async function performStationCheckIn(station, memberId, { viaOtp = false, req = null } = {}) {
  const memberRow = await db.query(
    `
    SELECT m.*, p.name AS plan_name, b.name AS branch_name
    FROM Members m
    LEFT JOIN Plans p ON p.id = m.plan_id
    LEFT JOIN Branches b ON b.id = m.branch_id
    WHERE m.id = $1 AND m.gym_id = $2 AND m.deleted_at IS NULL
    `,
    [memberId, station.gymId]
  );
  const member = memberRow.rows[0];
  if (!member) {
    return { ok: false, error: 'Member not found.', code: 'MEMBER_NOT_FOUND', status: 404 };
  }

  if (member.branch_id && Number(member.branch_id) !== Number(station.branchId)) {
    return {
      ok: false,
      error: 'Your membership is registered at another branch.',
      code: 'WRONG_BRANCH',
      status: 400,
    };
  }

  const settings = await getGymAttendanceSettings(station.gymId);
  const eligibility = await evaluateCheckInEligibility(member, station.gymId, settings);
  if (!eligibility.ok) {
    return {
      ok: false,
      error: eligibility.error,
      code: eligibility.code,
      status: eligibility.code === 'WEEKLY_LIMIT' ? 409 : 400,
      visits_this_week: eligibility.visitsThisWeek,
      visits_limit: eligibility.visitsLimit,
    };
  }

  const insert = await db.query(
    `
    INSERT INTO CheckIns (gym_id, branch_id, member_id, checked_in_by_user_id, method, notes)
    VALUES ($1, $2, $3, NULL, 'station_qr', $4)
    RETURNING *
    `,
    [station.gymId, station.branchId, member.id, viaOtp ? 'Self check-in (verified)' : 'Self check-in (trusted device)']
  );

  if (req) {
    await recordAuditLog({
      req,
      action: ACTIONS.CHECK_IN_RECORDED,
      entityType: 'check_in',
      entityId: insert.rows[0].id,
      entityLabel: member.name,
      details: {
        member_id: member.id,
        method: 'station_qr',
        branch_id: station.branchId,
        self_checkin: true,
      },
    });
  }

  const visitsThisWeek = eligibility.visitsThisWeek + 1;
  return {
    ok: true,
    status: 201,
    check_in: mapCheckInRow({
      ...insert.rows[0],
      member_name: member.name,
      member_phone: member.phone,
      member_photo_url: member.photo_url,
      branch_name: station.branchName || member.branch_name,
    }),
    visits_this_week: visitsThisWeek,
    visits_limit: eligibility.visitsLimit,
    member: {
      id: member.id,
      name: member.name,
    },
  };
}

async function trustedStationCheckIn(stationToken, req, res) {
  const station = await resolveStation(stationToken);
  if (!station.ok) {
    return { ok: false, error: station.error, code: station.code, status: 400 };
  }

  const deviceToken = readDeviceToken(req);
  const member = await loadTrustedMember(station, deviceToken);
  if (!member) {
    clearDeviceCookie(res);
    return {
      ok: false,
      error: 'Verify your phone to check in.',
      code: 'DEVICE_NOT_TRUSTED',
      status: 401,
    };
  }

  return performStationCheckIn(station, member.id, { req });
}

module.exports = {
  STATION_DEVICE_COOKIE,
  clearDeviceCookie,
  clearStationDevicesForMember,
  getStationSession,
  requestStationOtp,
  verifyStationOtp,
  trustedStationCheckIn,
  resolveStation,
};
