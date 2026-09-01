/**
 * @file stationPass.js
 * @description Signed branch station QR tokens for member self check-in.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const db = require('../config/db');

const STATION_TYPE = 'checkin_station';

function stationSecret() {
  return process.env.MEMBER_PASS_SECRET || process.env.JWT_SECRET;
}

/**
 * @param {{ gymId: number, branchId: number, stationVersion: number }} args
 */
function signStationPass({ gymId, branchId, stationVersion }) {
  const secret = stationSecret();
  if (!secret) {
    throw new Error('MEMBER_PASS_SECRET / JWT_SECRET is not configured.');
  }
  return jwt.sign(
    {
      typ: STATION_TYPE,
      gid: Number(gymId),
      bid: Number(branchId),
      sv: Number(stationVersion) || 1,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '10y' }
  );
}

/**
 * @param {string} token
 */
function verifyStationPass(token) {
  const secret = stationSecret();
  if (!secret) {
    return { ok: false, error: 'Station verification is not configured.', code: 'STATION_CONFIG' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Invalid station code.', code: 'STATION_INVALID' };
  }

  try {
    const payload = jwt.verify(token.trim(), secret, { algorithms: ['HS256'] });
    if (payload.typ !== STATION_TYPE) {
      return { ok: false, error: 'Invalid station code.', code: 'STATION_INVALID' };
    }
    const gymId = Number(payload.gid);
    const branchId = Number(payload.bid);
    const stationVersion = Number(payload.sv);
    if (!Number.isFinite(gymId) || !Number.isFinite(branchId) || !Number.isFinite(stationVersion)) {
      return { ok: false, error: 'Invalid station code.', code: 'STATION_INVALID' };
    }
    return { ok: true, gymId, branchId, stationVersion };
  } catch {
    return { ok: false, error: 'Invalid station code.', code: 'STATION_INVALID' };
  }
}

function buildStationCheckInUrl(stationToken) {
  const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${frontendBase}/check-in?station=${encodeURIComponent(stationToken)}`;
}

async function loadBranchStationContext(branchId, gymId) {
  const result = await db.query(
    `
    SELECT b.id, b.name AS branch_name, b.station_version, b.is_active,
           g.id AS gym_id, g.name AS gym_name, g.station_self_checkin
    FROM Branches b
    JOIN Gyms g ON g.id = b.gym_id
    WHERE b.id = $1 AND b.gym_id = $2
    `,
    [branchId, gymId]
  );
  return result.rows[0] || null;
}

async function buildStationPassPayload(branchId, gymId) {
  const row = await loadBranchStationContext(branchId, gymId);
  if (!row || !row.is_active) {
    const err = new Error('Branch not found.');
    err.statusCode = 404;
    throw err;
  }

  const stationVersion = Number(row.station_version) || 1;
  const stationToken = signStationPass({
    gymId: row.gym_id,
    branchId: row.id,
    stationVersion,
  });
  const checkInUrl = buildStationCheckInUrl(stationToken);
  const qr_data_url = await QRCode.toDataURL(checkInUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#0f172a', light: '#ffffff' },
  });

  return {
    station_version: stationVersion,
    station_token: stationToken,
    check_in_url: checkInUrl,
    qr_data_url,
    gym_name: row.gym_name,
    branch_name: row.branch_name,
    station_self_checkin: Boolean(row.station_self_checkin),
  };
}

async function regenerateBranchStation(branchId, gymId) {
  const result = await db.query(
    `
    UPDATE Branches
    SET station_version = COALESCE(station_version, 1) + 1
    WHERE id = $1 AND gym_id = $2
    RETURNING station_version
    `,
    [branchId, gymId]
  );
  if (!result.rows[0]) {
    const err = new Error('Branch not found.');
    err.statusCode = 404;
    throw err;
  }
  return buildStationPassPayload(branchId, gymId);
}

module.exports = {
  STATION_TYPE,
  signStationPass,
  verifyStationPass,
  buildStationCheckInUrl,
  loadBranchStationContext,
  buildStationPassPayload,
  regenerateBranchStation,
};
