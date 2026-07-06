/**
 * @file jobs/expiryCheck.js
 * @description Daily membership and gym SaaS license expiry checks with SMS alerts.
 */

const db = require('../config/db');
const { MEMBER_STATUS, MEMBER_STATUS_CASE_SQL, DUE_SOON_DAYS } = require('../utils/memberStatus');
const {
  smsMemberDueSoon,
  smsMemberExpiresToday,
  smsMemberExpired,
  smsGymLicenseDueIn3Days,
  smsGymLicenseExpiresToday,
  smsGymLicenseExpired,
  getGymOwnerContact,
} = require('../utils/notificationSms');

const GYM_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
};

function groupMembersByGym(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.gym_id)) map.set(row.gym_id, []);
    map.get(row.gym_id).push(row);
  });
  return map;
}

async function runGymSaasExpiryCheck() {
  console.log('[Notification Engine] Running gym SaaS license check...');

  const expireQuery = `
    UPDATE Gyms g
    SET subscription_status = $1
    FROM GymSubscriptions gs
    WHERE gs.gym_id = g.id
      AND gs.end_date < CURRENT_DATE
      AND LOWER(g.subscription_status) = $2
    RETURNING g.id, g.name, g.phone, gs.end_date;
  `;
  const expiredGyms = await db.query(expireQuery, [GYM_STATUS.EXPIRED, GYM_STATUS.ACTIVE]);

  if (expiredGyms.rows.length > 0) {
    await db.query(
      `
      UPDATE GymSubscriptions gs
      SET status = $1
      FROM Gyms g
      WHERE gs.gym_id = g.id
        AND gs.end_date < CURRENT_DATE
        AND LOWER(gs.status) = $2
      `,
      [GYM_STATUS.EXPIRED, GYM_STATUS.ACTIVE]
    );
    console.log(
      `[Notification Engine] Auto-expired ${expiredGyms.rows.length} gym SaaS license(s)`
    );

    for (const gym of expiredGyms.rows) {
      await smsGymLicenseExpired(gym, gym.end_date);
    }
  }

  const dueIn3DaysQuery = `
    SELECT g.id, g.name, g.phone, gs.end_date, gs.plan
    FROM Gyms g
    JOIN GymSubscriptions gs ON gs.gym_id = g.id
    WHERE LOWER(g.subscription_status) = $1
      AND gs.end_date = CURRENT_DATE + INTERVAL '3 days';
  `;
  const dueIn3Days = await db.query(dueIn3DaysQuery, [GYM_STATUS.ACTIVE]);
  for (const gym of dueIn3Days.rows) {
    console.log(
      `[Notification Engine] Gym SaaS license due in 3 days: ${gym.name} (#${gym.id})`
    );
    await smsGymLicenseDueIn3Days(gym, gym.end_date, gym.plan);
  }

  const expiringTodayQuery = `
    SELECT g.id, g.name, g.phone, gs.end_date
    FROM Gyms g
    JOIN GymSubscriptions gs ON gs.gym_id = g.id
    WHERE LOWER(g.subscription_status) = $1
      AND gs.end_date = CURRENT_DATE;
  `;
  const today = await db.query(expiringTodayQuery, [GYM_STATUS.ACTIVE]);
  for (const gym of today.rows) {
    console.log(`[Notification Engine] Gym SaaS license expires today: ${gym.name}`);
    await smsGymLicenseExpiresToday(gym);
  }
}

async function syncMemberStatuses() {
  const result = await db.query(
    `
    UPDATE Members
    SET status = ${MEMBER_STATUS_CASE_SQL}
    WHERE LOWER(status) IN ('active', 'due soon', 'expired')
    RETURNING id;
    `
  );
  if (result.rows.length > 0) {
    console.log(`[Notification Engine] Synced status for ${result.rows.length} member(s)`);
  }
  return result.rows.length;
}

async function smsMembersForGym(gymId, members, smsFn) {
  const contact = await getGymOwnerContact(gymId);
  const gymName = contact?.gym_name || 'your gym';
  for (const member of members) {
    await smsFn(member, gymName);
  }
}

async function runDailyExpiryCheck() {
  console.log('[Notification Engine] Running scheduled daily membership check...');

  try {
    await syncMemberStatuses();

    const autoExpireQuery = `
      UPDATE Members
      SET status = $1
      WHERE end_date < CURRENT_DATE AND LOWER(status) = $2
      RETURNING id, name, phone, gym_id, end_date;
    `;
    const expiredResult = await db.query(autoExpireQuery, [
      MEMBER_STATUS.EXPIRED,
      MEMBER_STATUS.ACTIVE,
    ]);
    if (expiredResult.rows.length > 0) {
      console.log(`[Notification Engine] Auto-expired ${expiredResult.rows.length} member(s)`);
      const byGym = groupMembersByGym(expiredResult.rows);
      for (const [gymId, members] of byGym) {
        await smsMembersForGym(gymId, members, smsMemberExpired);
      }
    }

    const expiringSoonQuery = `
      SELECT m.id, m.name, m.phone, m.gym_id, m.end_date
      FROM Members m
      WHERE m.end_date > CURRENT_DATE
        AND m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
        AND LOWER(m.status) IN ($1, $2)
        AND NOT EXISTS (
          SELECT 1 FROM SmsLog s
          WHERE s.message_type = 'member_due_soon'
            AND s.entity_type = 'member'
            AND s.entity_id = m.id
            AND (s.sent_at AT TIME ZONE 'UTC')::date >= m.end_date - INTERVAL '${DUE_SOON_DAYS} days'
        );
    `;
    const soonResult = await db.query(expiringSoonQuery, [
      MEMBER_STATUS.ACTIVE,
      MEMBER_STATUS.DUE_SOON,
    ]);
    const soonByGym = groupMembersByGym(soonResult.rows);
    for (const [gymId, members] of soonByGym) {
      console.log(`[Notification Engine] Due soon: ${members.length} member(s) at gym #${gymId}`);
      await smsMembersForGym(gymId, members, smsMemberDueSoon);
    }

    const expiringTodayQuery = `
      SELECT id, name, phone, gym_id, end_date
      FROM Members
      WHERE end_date = CURRENT_DATE
        AND LOWER(status) IN ($1, $2);
    `;
    const todayResult = await db.query(expiringTodayQuery, [
      MEMBER_STATUS.ACTIVE,
      MEMBER_STATUS.DUE_SOON,
    ]);
    const todayByGym = groupMembersByGym(todayResult.rows);
    for (const [gymId, members] of todayByGym) {
      console.log(`[Notification Engine] Expiring today: ${members.length} member(s) at gym #${gymId}`);
      await smsMembersForGym(gymId, members, smsMemberExpiresToday);
    }

    await runGymSaasExpiryCheck();
  } catch (error) {
    console.error('Error running daily membership check:', error);
  }
}

module.exports = { runDailyExpiryCheck, syncMemberStatuses };
