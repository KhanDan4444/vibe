/**
 * @file notificationSms.js
 * @description Transactional SMS reminders (members + gym SaaS license) via Afro Message.
 */

const db = require('../config/db');
const { formatDisplayDateFromIso } = require('./localDate');
const { sendSms, isSmsConfigured } = require('./afroMessage');
const { normalizeEthiopianPhone } = require('./phone');
const { ROLES } = require('./roles');

const SMS_TYPES = Object.freeze({
  MEMBER_DUE_SOON: 'member_due_soon',
  MEMBER_EXPIRES_TODAY: 'member_expires_today',
  MEMBER_EXPIRED: 'member_expired',
  GYM_LICENSE_DUE_SOON: 'gym_license_due_soon',
  GYM_LICENSE_DUE_IN_3_DAYS: 'gym_license_due_in_3_days',
  GYM_LICENSE_EXPIRES_TODAY: 'gym_license_expires_today',
  GYM_LICENSE_EXPIRED: 'gym_license_expired',
  OTP_FORGOT_PASSWORD: 'otp_forgot_password',
  OTP_GYM_SIGNUP: 'otp_gym_signup',
});

const OTP_PURPOSE_TO_MESSAGE_TYPE = Object.freeze({
  forgot_password: SMS_TYPES.OTP_FORGOT_PASSWORD,
  gym_signup: SMS_TYPES.OTP_GYM_SIGNUP,
});

async function wasSmsSentToday(messageType, entityType, entityId) {
  const result = await db.query(
    `
    SELECT 1 FROM SmsLog
    WHERE message_type = $1
      AND entity_type = $2
      AND entity_id = $3
      AND (sent_at AT TIME ZONE 'UTC')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    LIMIT 1
    `,
    [messageType, entityType, entityId]
  );
  return result.rows.length > 0;
}

async function logSms({ recipientPhone, messageType, entityType, entityId, messageId, otpCode }) {
  await db.query(
    `
    INSERT INTO SmsLog (recipient_phone, message_type, entity_type, entity_id, message_id, otp_code)
    VALUES ($1, $2, $3, $4, $5, $6)
  `,
    [
      recipientPhone,
      messageType,
      entityType,
      entityId ?? null,
      messageId ?? null,
      otpCode ?? null,
    ]
  );
}

/** Audit log for OTP sends (entity_id stays null so repeat sends are all logged). */
async function logOtpSms({ purpose, phone, messageId, otpCode }) {
  const messageType = OTP_PURPOSE_TO_MESSAGE_TYPE[purpose];
  if (!messageType || !phone) return;
  await logSms({
    recipientPhone: phone,
    messageType,
    entityType: 'otp',
    entityId: null,
    messageId,
    otpCode: otpCode != null ? String(otpCode) : null,
  });
}

/** After gym self-signup, link the latest OTP row to the new gym for admin SMS log. */
async function linkSignupOtpToGym(gymId, phone) {
  const normalized = normalizeEthiopianPhone(phone);
  if (!normalized || !gymId) return;
  await db.query(
    `
    UPDATE SmsLog
    SET entity_type = 'gym', entity_id = $1
    WHERE id = (
      SELECT id FROM SmsLog
      WHERE message_type = $2
        AND recipient_phone = $3
        AND entity_type = 'otp'
      ORDER BY sent_at DESC, id DESC
      LIMIT 1
    )
    `,
    [gymId, SMS_TYPES.OTP_GYM_SIGNUP, normalized]
  );
}

async function deliverSms({ to, message, messageType, entityType, entityId }) {
  const phone = normalizeEthiopianPhone(to);
  if (!phone) {
    console.warn(
      `[SMS] Skipped ${messageType}: invalid or missing phone for ${entityType}:${entityId ?? 'n/a'}`
    );
    return false;
  }

  if (entityId != null && (await wasSmsSentToday(messageType, entityType, entityId))) {
    return false;
  }

  try {
    const result = await sendSms(phone, message);
    await logSms({
      recipientPhone: phone,
      messageType,
      entityType,
      entityId,
      messageId: result.message_id,
    });
    return true;
  } catch (err) {
    console.error(`[SMS] Failed ${messageType} entity=${entityType}:${entityId}:`, err.message);
    return false;
  }
}

async function getGymOwnerContact(gymId) {
  const result = await db.query(
    `
    SELECT g.name AS gym_name, g.phone, u.name AS owner_name
    FROM Gyms g
    LEFT JOIN Users u ON u.gym_id = g.id AND u.role = $2
    WHERE g.id = $1
    LIMIT 1
    `,
    [gymId, ROLES.GYM_OWNER]
  );
  return result.rows[0] || null;
}

/**
 * @param {{ id: number, name: string, phone?: string, gym_id: number, end_date?: string }} member
 * @param {string} gymName
 */
async function smsMemberDueSoon(member, gymName) {
  if (!member.phone) return false;
  const endDate = formatDisplayDateFromIso(member.end_date) || 'soon';
  const message = `Hi ${member.name}, your membership at ${gymName} ends on ${endDate}. Please visit the gym to renew.`;
  return deliverSms({
    to: member.phone,
    message,
    messageType: SMS_TYPES.MEMBER_DUE_SOON,
    entityType: 'member',
    entityId: member.id,
  });
}

async function smsMemberExpiresToday(member, gymName) {
  if (!member.phone) return false;
  const message = `Hi ${member.name}, your membership at ${gymName} expires today. Renew at the front desk to stay active.`;
  return deliverSms({
    to: member.phone,
    message,
    messageType: SMS_TYPES.MEMBER_EXPIRES_TODAY,
    entityType: 'member',
    entityId: member.id,
  });
}

async function smsMemberExpired(member, gymName) {
  if (!member.phone) return false;
  const message = `Hi ${member.name}, your membership at ${gymName} has expired. Contact the gym to renew.`;
  return deliverSms({
    to: member.phone,
    message,
    messageType: SMS_TYPES.MEMBER_EXPIRED,
    entityType: 'member',
    entityId: member.id,
  });
}

async function smsGymLicenseDueIn3Days(gym, endDate, planName) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return false;
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const message = `VibeSaaS: Your platform license for ${gymName} (${planName || 'plan'}) ends in 3 days (${formatDisplayDateFromIso(endDate)}). Contact your administrator to renew.`;
  return deliverSms({
    to: phone,
    message,
    messageType: SMS_TYPES.GYM_LICENSE_DUE_IN_3_DAYS,
    entityType: 'gym',
    entityId: gym.id,
  });
}

async function smsGymLicenseExpiresToday(gym) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return false;
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const message = `VibeSaaS: Your platform license for ${gymName} expires today. Renew now to avoid interruption.`;
  return deliverSms({
    to: phone,
    message,
    messageType: SMS_TYPES.GYM_LICENSE_EXPIRES_TODAY,
    entityType: 'gym',
    entityId: gym.id,
  });
}

async function smsGymLicenseExpired(gym, endDate) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return false;
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const message = `VibeSaaS: Your platform license for ${gymName} expired on ${formatDisplayDateFromIso(endDate)}. Contact your administrator to restore access.`;
  return deliverSms({
    to: phone,
    message,
    messageType: SMS_TYPES.GYM_LICENSE_EXPIRED,
    entityType: 'gym',
    entityId: gym.id,
  });
}

module.exports = {
  SMS_TYPES,
  isSmsConfigured,
  logOtpSms,
  linkSignupOtpToGym,
  smsMemberDueSoon,
  smsMemberExpiresToday,
  smsMemberExpired,
  smsGymLicenseDueIn3Days,
  smsGymLicenseExpiresToday,
  smsGymLicenseExpired,
  getGymOwnerContact,
};
