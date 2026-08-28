#!/usr/bin/env node
/**
 * Smoke test — core owner + admin flows and multi-branch features.
 * Usage: npm run smoke:test  (backend must be running on PORT from .env)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/db');
const { runOtpDedupSmoke } = require('./otpDedupSmoke');

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;

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

async function login(email, password) {
  const res = await request('POST', '/auth/login', { email, password });
  assert(`Login ${email}`, res.ok, res.data.error);
  return { token: res.data.token, user: res.data.user };
}

async function tryLogin(email, password) {
  const res = await request('POST', '/auth/login', { email, password });
  if (!res.ok) return null;
  return { token: res.data.token, user: res.data.user };
}

async function ensureGymOwner(adminToken) {
  const existing = await tryLogin('owner@gym.com', 'password');
  if (existing) {
    console.log('  ✓ Login owner@gym.com');
    return existing;
  }
  const suffix = String(Date.now()).slice(-8);
  const username = `smoke_ow_${suffix}`;
  const created = await request(
    'POST',
    '/auth/register-gym',
    {
      gym_name: `Smoke Gym ${suffix}`,
      owner_name: 'Smoke Owner',
      username,
      password: 'password12',
      phone: `09${suffix}`,
      saas_plan_id: 1,
    },
    adminToken
  );
  assert('Register gym for smoke owner (seed owner login missing)', created.ok, created.data.error);
  const loggedIn = await tryLogin(username, 'password12');
  assert('Login newly registered smoke owner', Boolean(loggedIn), loggedIn ? '' : 'login failed');
  return loggedIn;
}

function dayAfter(dateStr) {
  const base = String(dateStr).split('T')[0];
  const d = new Date(`${base}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

async function testGymSignupOtpDedup() {
  console.log('\nGym signup OTP dedup');
  if (process.env.PUBLIC_GYM_SIGNUP_ENABLED === '0') {
    console.log('  ⚠ Skipping gym signup OTP dedup test (PUBLIC_GYM_SIGNUP_ENABLED=0)');
    return;
  }
  await runOtpDedupSmoke({ assert, db });
}

async function main() {
  console.log('Smoke test →', BASE);

  const adminToken = (await login('admin@saas.com', 'password')).token;
  const ownerSession = await ensureGymOwner(adminToken);
  const ownerToken = ownerSession.token;
  const helpdesk = await tryLogin('helpdesk@gym.com', 'password');
  const helpdeskToken = helpdesk?.token || null;
  if (helpdesk) console.log('  ✓ Login helpdesk@gym.com');
  else console.log('  ⚠ Skipping Front Desk checks (helpdesk@gym.com not available)');

  const health = await request('GET', '/health');
  assert('Health endpoint', health.ok);
  assert('Health reports DB connected', health.data.db === 'connected');

  await testGymSignupOtpDedup();

  const adminDash = await request('GET', '/admin/dashboard', null, adminToken);
  assert('Admin dashboard', adminDash.ok);
  assert('Admin dashboard has MRR', adminDash.data.estimatedMonthlyRevenue != null);

  const gyms = await request('GET', '/admin/gyms', null, adminToken);
  assert('Admin gyms list', gyms.ok && Array.isArray(gyms.data.items));

  const ownerDash = await request('GET', '/dashboard', null, ownerToken);
  assert('Owner dashboard', ownerDash.ok);
  assert('Owner dashboard has unpaidCount', ownerDash.data.unpaidCount != null);

  const members = await request('GET', '/members', null, ownerToken);
  assert('Owner members list', members.ok && Array.isArray(members.data.items));
  if (members.data.items.length > 0) {
    assert('Members include branch_name', members.data.items[0].branch_name != null);
  }

  const payments = await request('GET', '/payments', null, ownerToken);
  assert('Owner payments list', payments.ok && Array.isArray(payments.data.items));
  if (payments.data.items.length > 0) {
    assert('Payments include branch_name', payments.data.items[0].branch_name != null);
  }

  const branchList = await request('GET', '/gym/branches', null, ownerToken);
  assert('Owner branches list', branchList.ok && Array.isArray(branchList.data.branches));
  assert('Branches include staff_count', branchList.data.branches[0]?.staff_count != null);

  const comparison = await request('GET', '/dashboard/branch-comparison', null, ownerToken);
  assert('Branch comparison (owner)', comparison.ok);
  assert('Branch comparison returns branches array', Array.isArray(comparison.data.branches));

  const ownerTeam = await request('GET', '/gym/team', null, ownerToken);
  assert('Owner team list', ownerTeam.ok);
  assert('Owner team canManage', ownerTeam.data.canManage === true);

  if (helpdeskToken) {
    const helpdeskTeam = await request('GET', '/gym/team', null, helpdeskToken);
    assert('Front Desk cannot access team API', !helpdeskTeam.ok && helpdeskTeam.status === 403);

    const helpdeskActivity = await request('GET', '/gym/activity', null, helpdeskToken);
    assert('Front Desk cannot access activity API', !helpdeskActivity.ok && helpdeskActivity.status === 403);
  }

  const activeBranches = (branchList.data.branches || []).filter((b) => b.is_active !== false);
  const memberId = members.data.items[0]?.id;
  if (memberId && activeBranches.length >= 2) {
    const fromBranch = members.data.items[0].branch_id;
    const target = activeBranches.find((b) => b.id !== fromBranch) || activeBranches[1];
    const transfer = await request(
      'POST',
      `/members/${memberId}/transfer`,
      { branch_id: target.id },
      ownerToken
    );
    assert('Member transfer', transfer.ok, transfer.data.error);
    assert('Transfer returns branch_name', transfer.data.branch_name === target.name);

    const transferBack = await request(
      'POST',
      `/members/${memberId}/transfer`,
      { branch_id: fromBranch },
      ownerToken
    );
    assert('Member transfer back', transferBack.ok, transferBack.data.error);
  } else {
    console.log('  ⚠ Skipping member transfer test (need member + 2 active branches)');
  }

  const registerBlocked = await request('POST', '/auth/register-gym', {
    gym_name: 'Should Fail',
    owner_name: 'X',
    email: 'x@test.com',
    password: 'password',
    saas_plan_id: 1,
  });
  assert('Public register-gym blocked without admin token', !registerBlocked.ok);

  if (memberId && helpdeskToken) {
    const staffDeleteMember = await request('DELETE', `/members/${memberId}`, null, helpdeskToken);
    assert('Front Desk cannot delete members', !staffDeleteMember.ok && staffDeleteMember.status === 403);
  }

  const helpdeskBranchId = helpdesk?.user?.branch_id;
  if (helpdeskBranchId) {
    const branchMembers = await request(
      'GET',
      `/members?branch_id=${helpdeskBranchId}&limit=1`,
      null,
      ownerToken
    );
    const branchMember = branchMembers.data.items?.[0];
    if (branchMember) {
      const branchPayments = await request(
        'GET',
        `/members/${branchMember.id}/payments`,
        null,
        ownerToken
      );
      const ownBranchPayment = Array.isArray(branchPayments.data) ? branchPayments.data[0] : null;
      if (ownBranchPayment?.id) {
        const termStart = branchMember.start_date
          ? String(branchMember.start_date).split('T')[0]
          : null;
        const today = new Date().toISOString().split('T')[0];
        const editDate = termStart && today >= termStart ? today : termStart || today;
        const staffDeleteOwn = await request(
          'DELETE',
          `/payments/${ownBranchPayment.id}`,
          null,
          helpdeskToken
        );
        assert(
          'Front Desk cannot delete payments (even in their branch)',
          !staffDeleteOwn.ok && staffDeleteOwn.status === 403
        );
        const staffUpdateOwn = await request(
          'PUT',
          `/payments/${ownBranchPayment.id}`,
          {
            amount: ownBranchPayment.amount,
            date: editDate,
            method: ownBranchPayment.method || 'Cash',
          },
          helpdeskToken
        );
        assert(
          'Front Desk cannot edit payments',
          !staffUpdateOwn.ok && staffUpdateOwn.status === 403
        );
      }
    }
  }

  const otherBranch = (branchList.data.branches || []).find(
    (b) => b.is_active !== false && b.id !== helpdeskBranchId
  );
  if (helpdeskBranchId && otherBranch) {
    const otherMembers = await request(
      'GET',
      `/members?branch_id=${otherBranch.id}&limit=1`,
      null,
      ownerToken
    );
    const otherMember = otherMembers.data.items?.[0];
    if (otherMember) {
      const otherPayments = await request(
        'GET',
        `/members/${otherMember.id}/payments`,
        null,
        ownerToken
      );
      const payment = Array.isArray(otherPayments.data) ? otherPayments.data[0] : null;
      if (payment?.id) {
        const crossDelete = await request(
          'DELETE',
          `/payments/${payment.id}`,
          null,
          helpdeskToken
        );
        assert(
          'Front Desk cannot delete payment outside their branch',
          !crossDelete.ok && crossDelete.status === 403
        );
      }
    }
  }

  const unpaidMembers = await request('GET', '/members?filter=unpaid&limit=5', null, ownerToken);
  if (unpaidMembers.ok && unpaidMembers.data.items?.length > 0) {
    const unpaid = unpaidMembers.data.items[0];
    assert('Unpaid filter includes is_unpaid flag', unpaid.is_unpaid === true);
    const renewUnpaid = await request(
      'POST',
      `/members/${unpaid.id}/renew`,
      { amount: 50, date: '2026-06-01', method: 'Cash' },
      ownerToken
    );
    assert(
      'Renew blocked when current term unpaid',
      !renewUnpaid.ok && renewUnpaid.status === 409
    );
  } else {
    console.log('  ⚠ Skipping unpaid renew guard test (no unpaid members in seed)');
  }

  const paidRenewCandidate = (members.data.items || []).find(
    (m) => m.is_unpaid === false && ['due soon', 'expired'].includes(String(m.status).toLowerCase())
  );
  if (paidRenewCandidate) {
    const endDate = String(paidRenewCandidate.end_date).split('T')[0];
    const renewStart = dayAfter(endDate);
    const renewOnce = await request(
      'POST',
      `/members/${paidRenewCandidate.id}/renew`,
      {
        plan_id: paidRenewCandidate.plan_id,
        start_date: renewStart,
        amount: 50,
        date: renewStart,
        method: 'Cash',
      },
      ownerToken
    );
    if (renewOnce.ok) {
      const renewTwice = await request(
        'POST',
        `/members/${paidRenewCandidate.id}/renew`,
        {
          plan_id: paidRenewCandidate.plan_id,
          start_date: renewStart,
          amount: 50,
          date: renewStart,
          method: 'Cash',
        },
        ownerToken
      );
      assert(
        'Duplicate renew blocked for same term',
        !renewTwice.ok && renewTwice.status === 409
      );
    } else {
      console.log('  ⚠ Skipping duplicate renew test (renew rejected:', renewOnce.data.error, ')');
    }
  } else {
    console.log('  ⚠ Skipping duplicate renew test (no paid due soon/expired member)');
  }

  if (memberId) {
    const editPlanBlocked = await request(
      'PUT',
      `/members/${memberId}`,
      { plan_id: 1, start_date: '2026-01-01' },
      ownerToken
    );
    assert(
      'Member plan/start edit blocked (use Renew)',
      !editPlanBlocked.ok && editPlanBlocked.status === 400
    );
  }

  const plansRes = await request('GET', '/plans', null, ownerToken);
  let planList = Array.isArray(plansRes.data) ? plansRes.data : plansRes.data?.items || [];
  if (planList.length === 0) {
    const createdPlan = await request(
      'POST',
      '/plans',
      { name: 'Smoke Monthly', duration: 1, price: 500 },
      ownerToken
    );
    assert('Create plan for trainer smoke', createdPlan.ok, createdPlan.data.error);
    planList = [createdPlan.data.plan || createdPlan.data].filter(Boolean);
  }

  const trainerList = await request('GET', '/gym/trainers', null, ownerToken);
  assert('Owner trainers list', trainerList.ok && Array.isArray(trainerList.data.trainers));
  assert('Owner can manage trainers', trainerList.data.canManage === true);

  if (helpdeskToken) {
    const staffTrainers = await request('GET', '/gym/trainers', null, helpdeskToken);
    assert('Front Desk can list trainers', staffTrainers.ok);
    const staffCreateTrainer = await request(
      'POST',
      '/gym/trainers',
      {
        name: 'Should Fail',
        phone: '0911111111',
        branch_id: activeBranches[0]?.id,
      },
      helpdeskToken
    );
    assert('Front Desk cannot create trainers', !staffCreateTrainer.ok && staffCreateTrainer.status === 403);
  }

  const branchForTrainer = activeBranches[0];
  if (branchForTrainer && planList[0]) {
    const trainerName = `Smoke Trainer ${Date.now()}`;
    const trainerPhoneSuffix = String(Date.now()).slice(-7);
    const createdTrainer = await request(
      'POST',
      '/gym/trainers',
      {
        name: trainerName,
        phone: `092${trainerPhoneSuffix}`,
        branch_id: branchForTrainer.id,
        specialty: 'PT',
      },
      ownerToken
    );
    assert('Create trainer', createdTrainer.ok, createdTrainer.data.error);
    const trainerId = createdTrainer.data.trainer?.id;
    const phoneSuffix = String(Date.now()).slice(-8);
    const enrollWithTrainer = await request(
      'POST',
      '/members/enroll',
      {
        name: `Smoke PT ${phoneSuffix}`,
        phone: `09${phoneSuffix}`,
        plan_id: planList[0].id,
        start_date: new Date().toISOString().split('T')[0],
        skip_payment: true,
        branch_id: branchForTrainer.id,
        trainer_id: trainerId,
        trainer_fee: 150,
        trainer_fee_method: 'Cash',
      },
      ownerToken
    );
    assert('Enroll with trainer fee and skip membership pay', enrollWithTrainer.ok, enrollWithTrainer.data.error);
    assert(
      'Trainer fee does not mark membership paid',
      enrollWithTrainer.data.member?.is_unpaid === true,
      JSON.stringify(enrollWithTrainer.data.member)
    );
    assert('Enroll returns trainer_payment', enrollWithTrainer.data.trainer_payment?.source === 'trainer');

    const archive = await request('DELETE', `/gym/trainers/${trainerId}`, null, ownerToken);
    assert('Archive trainer', archive.ok, archive.data.error);
    const former = await request('GET', '/gym/trainers?archived=1', null, ownerToken);
    assert(
      'Former trainers list includes archived',
      former.ok && (former.data.trainers || []).some((row) => row.id === trainerId)
    );
    const restored = await request('POST', `/gym/trainers/${trainerId}/restore`, null, ownerToken);
    assert('Restore trainer', restored.ok, restored.data.error);
  } else {
    console.log('  ⚠ Skipping trainer enroll test (need branch + plan)');
  }

  const activePaid = (members.data.items || []).find(
    (m) => !m.is_unpaid && String(m.status).toLowerCase() === 'active' && m.plan_id
  );
  if (activePaid && planList.length >= 2) {
    const otherPlan = planList.find((p) => p.id !== activePaid.plan_id);
    if (otherPlan) {
      const today = new Date().toISOString().split('T')[0];
      const termStart = String(activePaid.start_date).split('T')[0];
      const changePlan = await request(
        'POST',
        `/members/${activePaid.id}/change-plan`,
        {
          plan_id: otherPlan.id,
          start_date: termStart,
          amount: parseFloat(otherPlan.price) || 50,
          date: today,
          method: 'Cash',
        },
        ownerToken
      );
      assert('Change plan for active paid member', changePlan.ok, changePlan.data.error);

      const thirdPlan = planList.find(
        (p) => p.id !== activePaid.plan_id && p.id !== otherPlan.id
      );
      if (thirdPlan && changePlan.ok) {
        const dupPayment = await request(
          'POST',
          `/members/${activePaid.id}/change-plan`,
          {
            plan_id: thirdPlan.id,
            start_date: termStart,
            amount: 10,
            date: today,
            method: 'Cash',
          },
          ownerToken
        );
        assert(
          'Change plan blocked when payment already recorded on date',
          !dupPayment.ok && dupPayment.status === 409,
          dupPayment.data.error
        );
      }

      const changeSame = await request(
        'POST',
        `/members/${activePaid.id}/change-plan`,
        { plan_id: otherPlan.id, start_date: termStart, amount: 50, date: today, method: 'Cash' },
        ownerToken
      );
      assert(
        'Change plan blocked when repeating same plan',
        !changeSame.ok && changeSame.status === 409
      );

      const originalPlan = planList.find((p) => p.id === activePaid.plan_id);
      if (originalPlan) {
        const sameTermCorrection = await request(
          'POST',
          `/members/${activePaid.id}/change-plan`,
          {
            plan_id: originalPlan.id,
            start_date: termStart,
            amount: 0,
            date: today,
            method: 'Cash',
          },
          ownerToken
        );
        assert(
          'Change plan on same term start without extra payment',
          sameTermCorrection.ok,
          sameTermCorrection.data.error
        );
      }
    }
  } else {
    console.log('  ⚠ Skipping change-plan success test (need active paid member + 2 plans)');
  }

  if (unpaidMembers.ok && unpaidMembers.data.items?.length > 0) {
    const unpaid = unpaidMembers.data.items[0];
    const otherPlan = planList.find((p) => p.id !== unpaid.plan_id);
    if (otherPlan) {
      const termStart = unpaid.start_date ? String(unpaid.start_date).split('T')[0] : '2026-06-01';
      const prePayChange = await request(
        'POST',
        `/members/${unpaid.id}/change-plan`,
        {
          plan_id: otherPlan.id,
          start_date: termStart,
          amount: 0,
          date: new Date().toISOString().split('T')[0],
          method: 'Cash',
        },
        ownerToken
      );
      assert(
        'Pre-payment plan switch allowed for unpaid member',
        prePayChange.ok,
        prePayChange.data?.error
      );
    }

    const planForUnpaid = planList.find((p) => p.id === unpaid.plan_id) || planList[0];
    if (planForUnpaid) {
      const excessiveCollect = await request(
        'POST',
        '/payments',
        {
          member_id: unpaid.id,
          amount: parseFloat(planForUnpaid.price) * 10,
          date: new Date().toISOString().split('T')[0],
          method: 'Cash',
        },
        ownerToken
      );
      assert(
        'Collect allows custom amount above plan price',
        excessiveCollect.ok,
        excessiveCollect.data?.error
      );
    }
  }

  const ownerPayments = await request('GET', '/payments?limit=1', null, ownerToken);
  const samplePayment = ownerPayments.data?.items?.[0];
  if (samplePayment?.id) {
    const badEdit = await request(
      'PUT',
      `/payments/${samplePayment.id}`,
      {
        amount: parseFloat(samplePayment.amount),
        date: '2000-01-01',
        method: samplePayment.method || 'Cash',
      },
      ownerToken
    );
    assert(
      'Payment edit blocked when date before member term start',
      !badEdit.ok && badEdit.status === 400,
      badEdit.data.error
    );
  }

  const adminPayments = await request('GET', '/admin/payments?limit=1', null, adminToken);
  const saasPayment = adminPayments.data?.items?.[0];
  if (saasPayment?.id) {
    const gymDetail = await request('GET', `/admin/gyms/${saasPayment.gym_id}`, null, adminToken);
    const termStart = gymDetail.data?.saas_subscription?.start_date
      ? String(gymDetail.data.saas_subscription.start_date).split('T')[0]
      : null;
    const today = new Date().toISOString().split('T')[0];
    const editDate = termStart && today >= termStart ? today : termStart || today;
    const adminEdit = await request(
      'PUT',
      `/admin/payments/${saasPayment.id}`,
      {
        amount: parseFloat(saasPayment.amount),
        date: editDate,
        method: saasPayment.method || 'Bank Transfer',
        notes: saasPayment.notes || '',
      },
      adminToken
    );
    assert('Admin can edit SaaS payment', adminEdit.ok, adminEdit.data.error);
  }

  console.log('\nAll smoke checks passed.');
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
