/**
 * @file expiryCheck.js
 * @description Daily membership and gym SaaS license expiry checks with SMS + email alerts.
 */

const db = require('../config/db');
const { MEMBER_STATUS, MEMBER_STATUS_CASE_SQL, ATTENTION_DUE_SOON_DAYS } = require('../utils/memberStatus');
const {
  smsMemberDueSoon,
  smsMemberExpiresToday,
  smsMemberExpired,
  smsGymLicenseDueIn3Days,
  smsGymLicenseExpiresToday,
  smsGymLicenseExpired,
  getGymOwnerContact,
  logSms,
} = require('../utils/notificationSms');
const {
  emailGymOwnerLicenseAlert,
  emailPlatformAdminsTrialsEndingAlert,
} = require('../utils/notificationEmail');
const { isTrialSubscription, GS_IS_TRIAL_SQL } = require('../utils/gymTrial');
const { formatDisplayDateFromIso } = require('../utils/localDate');

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

async function wasPlatformDigestSentToday(messageType) {
  const result = await db.query(
    `
    SELECT 1 FROM SmsLog
    WHERE message_type = $1
      AND entity_type = 'platform'
      AND entity_id = 0
      AND (sent_at AT TIME ZONE 'UTC')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    LIMIT 1
    `,
    [messageType]
  );
  return result.rows.length > 0;
}

async function logPlatformDigest(messageType) {
  await logSms({
    recipientPhone: 'platform-digest',
    messageType,
    entityType: 'platform',
    entityId: 0,
    messageId: 'email',
  });
}

async function notifyGymLicenseDueIn3Days(gym) {
  await smsGymLicenseDueIn3Days(gym, gym.end_date, gym.plan);
  const isTrial = isTrialSubscription(gym);
  const endDisplay = formatDisplayDateFromIso(gym.end_date);
  await emailGymOwnerLicenseAlert(
    gym,
    isTrial ? 'Free trial ending in 3 days' : 'Platform license ending in 3 days',
    isTrial
      ? [
          `Your free trial ends in 3 days (${endDisplay}).`,
          'Subscribe through your platform admin before the trial ends to keep full access.',
        ]
      : [
          `Your platform license (${gym.plan || 'plan'}) ends in 3 days (${endDisplay}).`,
          'Renew with your platform administrator to avoid interruption.',
        ],
    { isTrial }
  );
}

async function notifyGymLicenseExpiresToday(gym) {
  await smsGymLicenseExpiresToday(gym);
  const isTrial = isTrialSubscription(gym);
  await emailGymOwnerLicenseAlert(
    gym,
    isTrial ? 'Free trial ends today' : 'Platform license expires today',
    isTrial
      ? [
          'Your free trial ends today.',
          'Contact your platform admin to subscribe before your portal access is paused.',
        ]
      : [
          'Your platform license expires today.',
          'Renew now to avoid interruption to your gym portal.',
        ],
    { isTrial }
  );
}

async function notifyGymLicenseExpired(gym) {
  const endDisplay = formatDisplayDateFromIso(gym.end_date);
  await smsGymLicenseExpired(gym, gym.end_date);
  const isTrial = isTrialSubscription(gym);
  await emailGymOwnerLicenseAlert(
    gym,
    isTrial ? 'Free trial ended' : 'Platform license expired',
    isTrial
      ? [
          `Your free trial ended on ${endDisplay}.`,
          'Subscribe through your platform admin to restore access to the portal.',
        ]
      : [
          `Your platform license expired on ${endDisplay}.`,
          'Contact your platform administrator to renew and restore access.',
        ],
    { isTrial }
  );
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
      AND g.deleted_at IS NULL
    RETURNING g.id, g.name, g.phone, gs.end_date, gs.plan, gs.saas_plan_id;
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
      await notifyGymLicenseExpired(gym);
    }
  }

  const dueIn3DaysQuery = `
    SELECT g.id, g.name, g.phone, gs.end_date, gs.plan, gs.saas_plan_id
    FROM Gyms g
    JOIN GymSubscriptions gs ON gs.gym_id = g.id
    WHERE LOWER(g.subscription_status) = $1
      AND g.deleted_at IS NULL
      AND gs.end_date = CURRENT_DATE + INTERVAL '3 days';
  `;
  const dueIn3Days = await db.query(dueIn3DaysQuery, [GYM_STATUS.ACTIVE]);
  for (const gym of dueIn3Days.rows) {
    console.log(
      `[Notification Engine] Gym SaaS license due in 3 days: ${gym.name} (#${gym.id})`
    );
    await notifyGymLicenseDueIn3Days(gym);
  }

  const expiringTodayQuery = `
    SELECT g.id, g.name, g.phone, gs.end_date, gs.plan, gs.saas_plan_id
    FROM Gyms g
    JOIN GymSubscriptions gs ON gs.gym_id = g.id
    WHERE LOWER(g.subscription_status) = $1
      AND g.deleted_at IS NULL
      AND gs.end_date = CURRENT_DATE;
  `;
  const today = await db.query(expiringTodayQuery, [GYM_STATUS.ACTIVE]);
  for (const gym of today.rows) {
    console.log(`[Notification Engine] Gym SaaS license expires today: ${gym.name}`);
    await notifyGymLicenseExpiresToday(gym);
  }

  const trialsEndingQuery = `
    SELECT g.id, g.name, g.owner_name, g.city, gs.end_date
    FROM Gyms g
    JOIN GymSubscriptions gs ON gs.gym_id = g.id
    WHERE LOWER(g.subscription_status) = $1
      AND g.deleted_at IS NULL
      AND ${GS_IS_TRIAL_SQL}
      AND gs.end_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
    ORDER BY gs.end_date ASC, g.name ASC;
  `;
  const trialsEnding = await db.query(trialsEndingQuery, [GYM_STATUS.ACTIVE]);
  if (
    trialsEnding.rows.length > 0 &&
    !(await wasPlatformDigestSentToday('gym_trial_admin_digest'))
  ) {
    try {
      await emailPlatformAdminsTrialsEndingAlert(
        trialsEnding.rows.map((row) => ({
          ...row,
          end_date: formatDisplayDateFromIso(row.end_date),
        }))
      );
      await logPlatformDigest('gym_trial_admin_digest');
      console.log(
        `[Notification Engine] Admin digest: ${trialsEnding.rows.length} trial(s) ending within 7 days`
      );
    } catch (err) {
      console.error('[Notification Engine] Admin trial digest email failed:', err.message);
    }
  }
}

async function syncMemberStatuses() {
  const result = await db.query(
    `
    UPDATE Members
    SET status = ${MEMBER_STATUS_CASE_SQL}
    WHERE LOWER(status) IN ('active', 'due soon', 'expired')
      AND deleted_at IS NULL
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
      WHERE end_date < CURRENT_DATE AND LOWER(status) = $2 AND deleted_at IS NULL
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
      WHERE m.deleted_at IS NULL
        AND m.end_date > CURRENT_DATE
        AND m.end_date <= CURRENT_DATE + INTERVAL '${ATTENTION_DUE_SOON_DAYS} days'
        AND LOWER(m.status) IN ($1, $2)
        AND NOT EXISTS (
          SELECT 1 FROM SmsLog s
          WHERE s.message_type = 'member_due_soon'
            AND s.entity_type = 'member'
            AND s.entity_id = m.id
            AND (s.sent_at AT TIME ZONE 'UTC')::date >= m.end_date - INTERVAL '${ATTENTION_DUE_SOON_DAYS} days'
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
      WHERE deleted_at IS NULL
        AND end_date = CURRENT_DATE
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
