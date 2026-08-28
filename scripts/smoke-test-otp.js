#!/usr/bin/env node
/**
 * OTP dedup smoke test — parallel startPhoneOtpSession burst (local SMS, no Afro API).
 * Usage: npm run smoke:test:otp
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/db');
const { runOtpDedupSmoke } = require('./otpDedupSmoke');

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;

function assert(label, condition, detail = '') {
  if (!condition) {
    throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log('OTP dedup smoke test →', BASE);

  const health = await fetch(`${BASE}/health`);
  assert('Health endpoint', health.ok);

  console.log('\nOTP session dedup (direct, local SMS)');
  await runOtpDedupSmoke({ assert, db });

  console.log('\nOTP dedup smoke checks passed.');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('\n' + err.message);
  try {
    await db.pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
