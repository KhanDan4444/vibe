#!/usr/bin/env node
/**
 * Post-deploy smoke: health, Telegram, station self check-in, phone uniqueness.
 *
 * Usage:
 *   API_BASE=https://vibe-api-production-5ab1.up.railway.app node scripts/smoke-production.js
 *
 * With Neon/Railway DATABASE_URL (full checks):
 *   API_BASE=... node scripts/smoke-production.js
 */
require('dotenv').config();

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { assertMemberPhoneAvailable } = require('../utils/memberPhone');

const API_BASE = (process.env.API_BASE || 'https://vibe-api-production-5ab1.up.railway.app').replace(
  /\/$/,
  ''
);
const API = `${API_BASE}/api`;
const HAS_REMOTE_DB = Boolean(process.env.DATABASE_URL);
const ABERA_PHONE = process.env.SMOKE_PHONE || '0964349075';
const GYM_ID = parseInt(process.env.SMOKE_GYM_ID || '2', 10);

let failed = 0;
let skipped = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function skip(label, reason = '') {
  skipped += 1;
  console.log(`  ○ ${label}${reason ? ` (${reason})` : ''}`);
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function stationSecret() {
  return process.env.MEMBER_PASS_SECRET || process.env.JWT_SECRET;
}

function signStationPass(gymId, branchId, stationVersion) {
  const secret = stationSecret();
  if (!secret) throw new Error('JWT_SECRET not set');
  return jwt.sign(
    { typ: 'checkin_station', gid: gymId, bid: branchId, sv: stationVersion },
    secret,
    { algorithm: 'HS256', expiresIn: '10y' }
  );
}

async function testApiHealth() {
  console.log('\n=== API health ===');
  const res = await api('GET', '/health');
  if (res.ok && res.data.ok) pass('GET /api/health');
  else fail('GET /api/health', `${res.status} ${JSON.stringify(res.data)}`);
}

async function testTelegramStatus() {
  console.log('\n=== Telegram ===');
  const res = await api('GET', '/telegram/status');
  if (!res.ok) {
    fail('GET /api/telegram/status', `${res.status}`);
    return;
  }
  pass('GET /api/telegram/status');
  if (res.data.configured) pass('Telegram configured');
  else fail('Telegram configured', 'configured=false');
  if (res.data.bot_username) pass(`Bot username @${res.data.bot_username}`);
  else fail('Bot username present');
}

async function testInvalidStation() {
  console.log('\n=== Station check-in (invalid token) ===');
  const bogus =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXAiOiJjaGVja2luX3N0YXRpb24ifQ.invalid';
  const res = await api('GET', `/public/station-check-in/session?station=${encodeURIComponent(bogus)}`);
  if (res.status === 400 && res.data.code === 'STATION_INVALID') pass('Invalid station rejected');
  else fail('Invalid station rejected', `${res.status} ${JSON.stringify(res.data)}`);
}

async function loadBranchForGym(gymId) {
  const result = await db.query(
    `
    SELECT b.id, b.station_version, b.is_active, g.name AS gym_name, g.station_self_checkin
    FROM Branches b
    JOIN Gyms g ON g.id = b.gym_id
    WHERE b.gym_id = $1 AND b.is_active = TRUE
    ORDER BY b.is_default DESC NULLS LAST, b.id ASC
    LIMIT 1
    `,
    [gymId]
  );
  return result.rows[0] || null;
}

async function testDbMigration() {
  console.log('\n=== Database ===');
  if (!HAS_REMOTE_DB) {
    skip('Unique phone index (026)', 'set DATABASE_URL (Neon) for DB checks');
    skip('Phone duplicates', 'set DATABASE_URL');
    return;
  }

  const index = await db.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_members_gym_phone_suffix_unique'`
  );
  if (index.rows.length) pass('Migration 026 unique index exists');
  else fail('Migration 026 unique index exists', 'run npm run db:migrate');

  const dupes = await db.query(
    `
    SELECT COUNT(*)::int AS groups
    FROM (
      SELECT gym_id, RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9) AS suffix
      FROM Members
      WHERE deleted_at IS NULL AND phone IS NOT NULL
      GROUP BY gym_id, suffix
      HAVING COUNT(*) > 1
    ) d
    `
  );
  const groups = dupes.rows[0]?.groups ?? -1;
  if (groups === 0) pass('No duplicate phones in DB');
  else fail('No duplicate phones in DB', `${groups} group(s) remain`);
}

async function testAberaInDb() {
  if (!HAS_REMOTE_DB) {
    skip('Abera member lookup', 'set DATABASE_URL');
    return null;
  }

  const result = await db.query(
    `
    SELECT id, name, phone, telegram_chat_id IS NOT NULL AS telegram
    FROM Members
    WHERE gym_id = $1
      AND deleted_at IS NULL
      AND name ILIKE '%abera%'
    ORDER BY id DESC
    LIMIT 1
    `,
    [GYM_ID]
  );
  const row = result.rows[0];
  if (!row) {
    fail('Abera member exists in gym', `gym_id=${GYM_ID}`);
    return null;
  }
  pass(`Abera found: #${row.id} ${row.name}`);
  if (row.telegram) pass('Abera has Telegram linked');
  else fail('Abera has Telegram linked');
  return row;
}

async function testPhoneUniqueness(abera) {
  console.log('\n=== Phone uniqueness ===');
  if (!abera?.phone) {
    skip('Duplicate phone blocked (assertMemberPhoneAvailable)', 'no Abera phone');
    return;
  }

  const check = await assertMemberPhoneAvailable(GYM_ID, abera.phone);
  if (!check.ok && check.code === 'PHONE_ALREADY_USED') {
    pass(`Duplicate blocked for ${abera.phone} (conflict: ${check.conflict?.name})`);
  } else {
    fail('Duplicate phone blocked', JSON.stringify(check));
  }
}

async function testStationFlow(branch) {
  console.log('\n=== Station self check-in (Iron Fist) ===');
  if (!HAS_REMOTE_DB) {
    skip('Station session', 'set DATABASE_URL');
    return;
  }

  if (!branch) {
    fail('Load Iron Fist branch', 'no active branch');
    return;
  }

  if (!branch.station_self_checkin) {
    fail('Self check-in enabled on gym', 'station_self_checkin=false');
    return;
  }
  pass(`Self check-in enabled (${branch.gym_name})`);

  let token;
  try {
    token = signStationPass(GYM_ID, branch.id, branch.station_version || 1);
  } catch (err) {
    fail('Sign station JWT', err.message);
    return;
  }

  const session = await api(
    'GET',
    `/public/station-check-in/session?station=${encodeURIComponent(token)}`
  );
  if (!session.ok) {
    fail('GET station session', `${session.status} ${JSON.stringify(session.data)}`);
    return;
  }
  pass('GET station session');
  if (session.data.telegram_configured) pass('Session reports Telegram configured');
  else fail('Session reports Telegram configured');

  const otp = await api('POST', '/public/station-check-in/request-otp', {
    station: token,
    phone: ABERA_PHONE,
  });

  if (otp.status === 429 && otp.data.code === 'OTP_COOLDOWN') {
    pass('Request OTP for Abera (cooldown — Telegram path works, wait 60s to resend)');
    return;
  }

  if (otp.ok && otp.data.session_id) {
    pass('Request OTP for Abera (OTP sent to Telegram)');
    console.log(`    session_id: ${otp.data.session_id} (check Telegram for code — not verifying here)`);
    return;
  }

  if (otp.data.code === 'TELEGRAM_NOT_LINKED') {
    fail('Request OTP for Abera', 'Telegram not linked on member row');
    return;
  }

  if (otp.data.code === 'WRONG_BRANCH') {
    fail('Request OTP for Abera', 'member branch mismatch');
    return;
  }

  fail('Request OTP for Abera', `${otp.status} ${JSON.stringify(otp.data)}`);
}

async function main() {
  console.log(`API: ${API_BASE}`);
  console.log(`Gym: ${GYM_ID} | Phone: ${ABERA_PHONE}`);

  await testApiHealth();
  await testTelegramStatus();
  await testInvalidStation();
  await testDbMigration();

  const abera = await testAberaInDb();
  await testPhoneUniqueness(abera);

  let branch = null;
  if (HAS_REMOTE_DB) {
    branch = await loadBranchForGym(GYM_ID);
    if (branch) pass(`Branch #${branch.id} station_version=${branch.station_version}`);
    else fail('Load Iron Fist branch', 'no active branch');
  }

  await testStationFlow(branch);

  console.log('\n=== Summary ===');
  console.log(`Passed checks above | Failed: ${failed} | Skipped: ${skipped}`);

  if (failed > 0) process.exit(1);
  if (skipped > 0) {
    console.log('\nFor full DB + station tests, run on Railway (has DATABASE_URL):');
    console.log('  API_BASE=https://vibe-api-production-5ab1.up.railway.app node scripts/smoke-production.js');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch {
      /* ignore */
    }
  });
