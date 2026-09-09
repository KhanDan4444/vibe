#!/usr/bin/env node
/**
 * End-to-end smoke: public gym signup (no free trial) + admin enroll with city/address.
 *
 * Prerequisites: API running with DB migrated + seed.dev.sql applied.
 * Usage:
 *   npm run smoke:gym-signup
 *   API_BASE=http://localhost:5000/api npm run smoke:gym-signup
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/db');

const BASE = (process.env.API_BASE || `http://localhost:${process.env.PORT || 5000}/api`).replace(
  /\/$/,
  ''
);

async function request(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function assert(label, condition, detail = '') {
  if (!condition) {
    throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`  ✓ ${label}`);
}

function uniqueSuffix() {
  return String(Date.now()).slice(-8);
}

async function latestOtpCode(phoneNormalized) {
  const result = await db.query(
    `
    SELECT otp_code
    FROM SmsLog
    WHERE message_type = 'otp_gym_signup'
      AND recipient_phone = $1
      AND otp_code IS NOT NULL
    ORDER BY sent_at DESC
    LIMIT 1
    `,
    [phoneNormalized]
  );
  return result.rows[0]?.otp_code || null;
}

async function loginAdmin() {
  const res = await request('POST', '/auth/login', {
    email: 'admin@saas.com',
    password: 'password',
  });
  assert('Admin login', res.ok, res.data.error);
  return res.data.token;
}

async function testPublicGymSignupNoTrial() {
  console.log('\nPublic gym signup (trial disabled)');
  if (process.env.PUBLIC_GYM_SIGNUP_ENABLED === '0') {
    console.log('  ⚠ Skipping (PUBLIC_GYM_SIGNUP_ENABLED=0)');
    return null;
  }

  const trialDaysEnv = process.env.GYM_SIGNUP_TRIAL_DAYS;
  const trialEnabled =
    trialDaysEnv != null &&
    String(trialDaysEnv).trim() !== '' &&
    parseInt(trialDaysEnv, 10) > 0;
  if (trialEnabled) {
    console.log(
      `  ⚠ GYM_SIGNUP_TRIAL_DAYS=${trialDaysEnv} — expecting trial off for v1; set to 0 to assert no-trial`
    );
  }

  const suffix = uniqueSuffix();
  const phone = `091${suffix.slice(-7)}`;
  const username = `sg_${suffix}`;
  const city = 'Addis Ababa';
  const address = 'Bole Road 12';

  const otpReq = await request('POST', '/auth/gym-signup/request-otp', { phone });
  assert('Request signup OTP', otpReq.ok, otpReq.data.error);
  const sessionId = otpReq.data.sessionId;
  assert('OTP session id returned', Boolean(sessionId));

  const { normalizeEthiopianPhone } = require('../utils/phone');
  const normalized = normalizeEthiopianPhone(phone);
  const code = await latestOtpCode(normalized);
  assert('OTP code readable from SmsLog (local/dev SMS)', Boolean(code), 'no otp_code in SmsLog');

  const verify = await request('POST', '/auth/gym-signup/verify-otp', {
    sessionId,
    code,
    phone: normalized,
  });
  assert('Verify signup OTP', verify.ok, verify.data.error);

  const complete = await request('POST', '/auth/gym-signup/complete', {
    sessionId,
    code,
    gym_name: `Smoke Signup Gym ${suffix}`,
    city,
    address,
    owner_name: 'Smoke Signup Owner',
    username,
    password: 'password12',
    phone: normalized,
  });
  assert('Complete gym signup', complete.ok, complete.data.error);
  assert('Signup returns gym city', complete.data.gym?.city === city, JSON.stringify(complete.data.gym));
  assert(
    'Signup returns gym address',
    complete.data.gym?.address === address,
    JSON.stringify(complete.data.gym)
  );

  const sub = complete.data.subscription || {};
  if (trialEnabled) {
    assert('Trial mode still on (env)', sub.is_trial === true);
  } else {
    assert('Signup is not free trial', sub.is_trial !== true, JSON.stringify(sub));
    assert('Signup assigned a plan name', Boolean(sub.plan_name), JSON.stringify(sub));
    assert(
      'Signup plan is not Free Trial label',
      String(sub.plan_name).toLowerCase() !== 'free trial',
      sub.plan_name
    );
  }

  const ownerLogin = await request('POST', '/auth/login', {
    email: username,
    password: 'password12',
  });
  assert('Owner can sign in after signup', ownerLogin.ok, ownerLogin.data.error);

  const dash = await request('GET', '/dashboard', null, ownerLogin.data.token);
  assert('Owner dashboard after signup', dash.ok, dash.data.error);
  if (!trialEnabled) {
    assert('Dashboard isTrial is false', dash.data.isTrial !== true, JSON.stringify({
      isTrial: dash.data.isTrial,
      trialDaysLeft: dash.data.trialDaysLeft,
    }));
  }

  return { username, gymId: complete.data.gym?.id, token: ownerLogin.data.token };
}

async function testAdminEnrollWithLocation(adminToken) {
  console.log('\nAdmin enroll gym (city + address)');
  const suffix = uniqueSuffix();
  const username = `ae_${suffix}`;
  const phone = `092${suffix.slice(-7)}`;
  const city = 'Adama';
  const address = 'Main Ave 5';

  const plans = await request('GET', '/admin/saas-plans', null, adminToken);
  const planList = Array.isArray(plans.data)
    ? plans.data
    : plans.data?.plans || plans.data?.items || [];
  assert('Admin SaaS plans list', plans.ok && planList.length > 0, plans.data.error || JSON.stringify(plans.data));
  const planId = planList[0].id;

  const enroll = await request(
    'POST',
    '/admin/gyms/enroll',
    {
      gym_name: `Smoke Admin Gym ${suffix}`,
      city,
      address,
      owner_name: 'Smoke Admin Owner',
      username,
      password: 'password12',
      phone,
      saas_plan_id: planId,
      skip_payment: true,
    },
    adminToken
  );
  assert('Admin enroll gym', enroll.ok, enroll.data.error);

  const gymId = enroll.data.gym?.id || enroll.data.id;
  assert('Enroll returns gym id', Boolean(gymId), JSON.stringify(enroll.data));
  assert('Enroll response has city', enroll.data.gym?.city === city, JSON.stringify(enroll.data.gym));
  assert(
    'Enroll response has address',
    enroll.data.gym?.address === address,
    JSON.stringify(enroll.data.gym)
  );

  const detail = await request('GET', `/admin/gyms/${gymId}`, null, adminToken);
  assert('Admin gym detail', detail.ok, detail.data.error);
  assert('Detail gym has city', detail.data.city === city, JSON.stringify(detail.data));
  assert('Detail gym has address', detail.data.address === address, JSON.stringify(detail.data));

  const ownerLogin = await request('POST', '/auth/login', {
    email: username,
    password: 'password12',
  });
  assert('Enrolled owner can sign in', ownerLogin.ok, ownerLogin.data.error);

  return { gymId, username };
}

async function main() {
  console.log('Gym signup / enroll smoke →', BASE);

  const health = await request('GET', '/health');
  assert('Health endpoint', health.ok, `${health.status}`);
  assert('Health DB connected', health.data.db === 'connected', JSON.stringify(health.data));

  const adminToken = await loginAdmin();
  await testPublicGymSignupNoTrial();
  await testAdminEnrollWithLocation(adminToken);

  console.log('\nGym signup / enroll smoke passed.');
}

main()
  .catch((err) => {
    console.error('\n' + err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch {
      // ignore
    }
  });
