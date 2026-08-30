/**
 * @file notificationSms.js
 * @description Transactional SMS reminders (members + gym SaaS license) via Afro Message.
 */

const db = require('../config/db');
const { formatDisplayDateFromIso } = require('./localDate');
const { sendSms, isSmsConfigured } = require('./smsProvider');
const { sendMessage: sendTelegramMessage, isTelegramConfigured } = require('./telegramBot');
const { normalizeEthiopianPhone } = require('./phone');
const { ROLES } = require('./roles');
const { SMS_BRAND } = require('./brand');
const { isTrialSubscription } = require('./gymTrial');

const MESSAGE_CHANNELS = Object.freeze({
  SMS: 'sms',
  TELEGRAM: 'telegram',
});

const SMS_TYPES = Object.freeze({
  MEMBER_DUE_SOON: 'member_due_soon',
  MEMBER_EXPIRES_TODAY: 'member_expires_today',
  MEMBER_EXPIRED: 'member_expired',
  MEMBER_RENEWED: 'member_renewed',
  MEMBER_ENROLLED: 'member_enrolled',
  MEMBER_PASS_LINK: 'member_pass_link',
  GYM_LICENSE_DUE_SOON: 'gym_license_due_soon',
  GYM_LICENSE_DUE_IN_3_DAYS: 'gym_license_due_in_3_days',
  GYM_LICENSE_EXPIRES_TODAY: 'gym_license_expires_today',
  GYM_LICENSE_EXPIRED: 'gym_license_expired',
  GYM_LICENSE_RENEWED: 'gym_license_renewed',
  GYM_TRIAL_DUE_IN_3_DAYS: 'gym_trial_due_in_3_days',
  GYM_TRIAL_EXPIRES_TODAY: 'gym_trial_expires_today',
  GYM_TRIAL_EXPIRED: 'gym_trial_expired',
  OTP_FORGOT_PASSWORD: 'otp_forgot_password',
  OTP_GYM_SIGNUP: 'otp_gym_signup',
});

const OTP_PURPOSE_TO_MESSAGE_TYPE = Object.freeze({
  forgot_password: SMS_TYPES.OTP_FORGOT_PASSWORD,
  gym_signup: SMS_TYPES.OTP_GYM_SIGNUP,
});

async function wasMessageSentToday(messageType, entityType, entityId) {
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

async function logMessage({
  channel = MESSAGE_CHANNELS.SMS,
  recipientPhone = null,
  recipientAddress = null,
  messageType,
  entityType,
  entityId,
  messageId,
  otpCode,
}) {
  await db.query(
    `
    INSERT INTO SmsLog (
      recipient_phone,
      recipient_address,
      channel,
      message_type,
      entity_type,
      entity_id,
      message_id,
      otp_code
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,
    [
      recipientPhone,
      recipientAddress,
      channel,
      messageType,
      entityType,
      entityId ?? null,
      messageId ?? null,
      otpCode ?? null,
    ]
  );
}

/** @deprecated Use logMessage */
async function logSms({ recipientPhone, messageType, entityType, entityId, messageId, otpCode }) {
  return logMessage({
    channel: MESSAGE_CHANNELS.SMS,
    recipientPhone,
    messageType,
    entityType,
    entityId,
    messageId,
    otpCode,
  });
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

async function deliverTelegram({
  to,
  message,
  messageType,
  entityType,
  entityId,
  skipDailyDedupe = false,
  memberPhone = null,
}) {
  const chatId = String(to ?? '').trim();
  if (!chatId || !/^-?\d+$/.test(chatId)) {
    console.warn(
      `[Telegram] Skipped ${messageType}: invalid chat id for ${entityType}:${entityId ?? 'n/a'}`
    );
    return { ok: false, error: 'invalid_chat_id' };
  }

  if (
    !skipDailyDedupe &&
    entityId != null &&
    (await wasMessageSentToday(messageType, entityType, entityId))
  ) {
    return { ok: false, error: 'already_sent_today' };
  }

  try {
    const result = await sendTelegramMessage(chatId, message);
    await logMessage({
      channel: MESSAGE_CHANNELS.TELEGRAM,
      recipientPhone: memberPhone,
      recipientAddress: chatId,
      messageType,
      entityType,
      entityId,
      messageId: result.message_id,
    });
    return { ok: true, channel: MESSAGE_CHANNELS.TELEGRAM };
  } catch (err) {
    console.error(
      `[Telegram] Failed ${messageType} entity=${entityType}:${entityId}:`,
      err.message
    );
    return { ok: false, error: err.message || 'send_failed' };
  }
}

async function deliverSms({ to, message, messageType, entityType, entityId, skipDailyDedupe = false }) {
  const phone = normalizeEthiopianPhone(to);
  if (!phone) {
    console.warn(
      `[SMS] Skipped ${messageType}: invalid or missing phone for ${entityType}:${entityId ?? 'n/a'}`
    );
    return { ok: false, error: 'invalid_phone' };
  }

  if (
    !skipDailyDedupe &&
    entityId != null &&
    (await wasMessageSentToday(messageType, entityType, entityId))
  ) {
    return { ok: false, error: 'already_sent_today' };
  }

  try {
    const result = await sendSms(phone, message);
    await logMessage({
      channel: MESSAGE_CHANNELS.SMS,
      recipientPhone: phone,
      recipientAddress: phone,
      messageType,
      entityType,
      entityId,
      messageId: result.message_id,
    });
    return { ok: true, channel: MESSAGE_CHANNELS.SMS };
  } catch (err) {
    console.error(`[SMS] Failed ${messageType} entity=${entityType}:${entityId}:`, err.message);
    return { ok: false, error: err.message || 'send_failed' };
  }
}

/**
 * Route an outbound member/gym message to SMS or Telegram.
 * Phase 3 will call resolveMemberChannel() before most member sends.
 */
async function deliverMessage({
  channel = MESSAGE_CHANNELS.SMS,
  to,
  message,
  messageType,
  entityType,
  entityId,
  skipDailyDedupe = false,
  memberPhone = null,
}) {
  if (channel === MESSAGE_CHANNELS.TELEGRAM) {
    return deliverTelegram({
      to,
      message,
      messageType,
      entityType,
      entityId,
      skipDailyDedupe,
      memberPhone,
    });
  }
  return deliverSms({
    to,
    message,
    messageType,
    entityType,
    entityId,
    skipDailyDedupe,
  });
}

/**
 * Pick Telegram when linked and preferred; otherwise SMS.
 * @param {{ telegram_chat_id?: number|null, preferred_channel?: string|null, phone?: string|null }} member
 */
function resolveMemberChannel(member) {
  const chatId = member?.telegram_chat_id;
  const pref = String(member?.preferred_channel || MESSAGE_CHANNELS.SMS).toLowerCase();
  if (chatId && pref !== MESSAGE_CHANNELS.SMS && isTelegramConfigured()) {
    return {
      channel: MESSAGE_CHANNELS.TELEGRAM,
      to: String(chatId),
    };
  }
  return {
    channel: MESSAGE_CHANNELS.SMS,
    to: member?.phone || null,
  };
}

/**
 * True when member can receive via Telegram or SMS.
 * @param {{ phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 */
function memberReachable(member) {
  const route = resolveMemberChannel(member);
  if (route.channel === MESSAGE_CHANNELS.TELEGRAM && route.to) return true;
  return Boolean(normalizeEthiopianPhone(member?.phone));
}

/**
 * Whether the resolved delivery channel is configured on this server.
 * @param {{ phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 */
function isMemberMessagingConfigured(member) {
  const route = resolveMemberChannel(member);
  if (route.channel === MESSAGE_CHANNELS.TELEGRAM) return isTelegramConfigured();
  return isSmsConfigured();
}

/**
 * Deliver to Telegram when linked; fall back to SMS on failure or when SMS-only.
 * @param {{ id: number, phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 */
async function deliverMemberMessage(member, { message, messageType, skipDailyDedupe = false }) {
  const route = resolveMemberChannel(member);

  if (route.channel === MESSAGE_CHANNELS.TELEGRAM && route.to) {
    const result = await deliverMessage({
      channel: MESSAGE_CHANNELS.TELEGRAM,
      to: route.to,
      message,
      messageType,
      entityType: 'member',
      entityId: member.id,
      skipDailyDedupe,
      memberPhone: member.phone || null,
    });
    if (result.ok || result.error === 'already_sent_today') {
      return result;
    }
    if (member.phone && isSmsConfigured()) {
      console.warn(
        `[Message] Telegram failed for member ${member.id} (${result.error}); falling back to SMS`
      );
      return deliverSms({
        to: member.phone,
        message,
        messageType,
        entityType: 'member',
        entityId: member.id,
        skipDailyDedupe,
      });
    }
    return result;
  }

  if (!member.phone) {
    return { ok: false, error: 'no_phone' };
  }

  return deliverSms({
    to: member.phone,
    message,
    messageType,
    entityType: 'member',
    entityId: member.id,
    skipDailyDedupe,
  });
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
 * @param {{ id: number, name: string, phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null, end_date?: string }} member
 * @param {string} gymName
 */
async function smsMemberDueSoon(member, gymName) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const endDate = formatDisplayDateFromIso(member.end_date) || 'soon';
  const message = `Hi ${member.name}, your membership at ${gymName} ends on ${endDate}.`;
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_DUE_SOON,
  });
}

async function smsMemberExpiresToday(member, gymName) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const message = `Hi ${member.name}, your membership at ${gymName} expires today. Renew at the front desk to stay active.`;
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_EXPIRES_TODAY,
  });
}

async function smsMemberExpired(member, gymName) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const message = `Hi ${member.name}, your membership at ${gymName} has expired. Contact the gym to renew.`;
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_EXPIRED,
  });
}

/**
 * @param {{ id: number, name: string, phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 * @param {string} gymName
 * @param {string} endDate
 * @param {{ passUrl?: string|null }} [opts]
 */
async function smsMemberRenewed(member, gymName, endDate, opts = {}) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const firstName = String(member.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || 'there';
  const ends = formatDisplayDateFromIso(endDate) || 'soon';
  let message = `Hi ${firstName}, your membership at ${gymName} has been renewed. New term ends on ${ends}. Thank you!`;
  const route = resolveMemberChannel(member);
  if (opts.passUrl && route.channel === MESSAGE_CHANNELS.TELEGRAM) {
    message = `${message}\n\nYour check-in pass: ${opts.passUrl}`;
  }
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_RENEWED,
  });
}

/**
 * @param {{ id: number, name: string, phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 * @param {string} gymName
 * @param {{ planName?: string, startDate?: string, endDate?: string, passUrl?: string|null }} term
 */
async function smsMemberEnrolled(member, gymName, term = {}) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const firstName = String(member.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || 'there';
  const ends = formatDisplayDateFromIso(term.endDate) || 'soon';
  const planLabel = term.planName
    ? String(term.planName).trim().replace(/\s*·\s*/g, ' - ')
    : '';
  const planBit = planLabel ? `Your ${planLabel} membership plan` : 'Your membership';
  let message = `Hi ${firstName}, welcome to ${gymName}. ${planBit} is active until ${ends}. We are glad to have you!`;
  const route = resolveMemberChannel(member);
  if (term.passUrl && route.channel === MESSAGE_CHANNELS.TELEGRAM) {
    message = `${message}\n\nYour check-in pass: ${term.passUrl}`;
  }
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_ENROLLED,
  });
}

/**
 * Send a link to the member’s public QR pass page (not the image).
 * @param {{ id: number, name: string, phone?: string|null, telegram_chat_id?: number|null, preferred_channel?: string|null }} member
 * @param {string} gymName
 * @param {string} passUrl
 */
async function smsMemberPassLink(member, gymName, passUrl) {
  if (!memberReachable(member)) return { ok: false, error: 'no_contact' };
  const firstName = String(member.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || 'there';
  const message = `Hi ${firstName}, your ${gymName} check-in pass: ${passUrl} Show the QR at the desk when you arrive.`;
  return deliverMemberMessage(member, {
    message,
    messageType: SMS_TYPES.MEMBER_PASS_LINK,
    skipDailyDedupe: true,
  });
}

async function smsGymLicenseDueIn3Days(gym, endDate, planName) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return { ok: false, error: 'no_phone' };
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const endDisplay = formatDisplayDateFromIso(endDate);
  const isTrial = isTrialSubscription(gym);
  const message = isTrial
    ? `${SMS_BRAND}: Your free trial for ${gymName} ends in 3 days (${endDisplay}). Contact your platform admin to subscribe and keep access.`
    : `${SMS_BRAND}: Your platform license for ${gymName} (${planName || 'plan'}) ends in 3 days (${endDisplay}). Contact your administrator to renew.`;
  return deliverSms({
    to: phone,
    message,
    messageType: isTrial ? SMS_TYPES.GYM_TRIAL_DUE_IN_3_DAYS : SMS_TYPES.GYM_LICENSE_DUE_IN_3_DAYS,
    entityType: 'gym',
    entityId: gym.id,
  });
}

async function smsGymLicenseExpiresToday(gym) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return { ok: false, error: 'no_phone' };
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const isTrial = isTrialSubscription(gym);
  const message = isTrial
    ? `${SMS_BRAND}: Your free trial for ${gymName} ends today. Contact your platform admin to subscribe before access is paused.`
    : `${SMS_BRAND}: Your platform license for ${gymName} expires today. Renew now to avoid interruption.`;
  return deliverSms({
    to: phone,
    message,
    messageType: isTrial ? SMS_TYPES.GYM_TRIAL_EXPIRES_TODAY : SMS_TYPES.GYM_LICENSE_EXPIRES_TODAY,
    entityType: 'gym',
    entityId: gym.id,
  });
}

async function smsGymLicenseExpired(gym, endDate) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return { ok: false, error: 'no_phone' };
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const endDisplay = formatDisplayDateFromIso(endDate);
  const isTrial = isTrialSubscription(gym);
  const message = isTrial
    ? `${SMS_BRAND}: Your free trial for ${gymName} ended on ${endDisplay}. Contact your platform admin to subscribe and restore access.`
    : `${SMS_BRAND}: Your platform license for ${gymName} expired on ${endDisplay}. Contact your administrator to restore access.`;
  return deliverSms({
    to: phone,
    message,
    messageType: isTrial ? SMS_TYPES.GYM_TRIAL_EXPIRED : SMS_TYPES.GYM_LICENSE_EXPIRED,
    entityType: 'gym',
    entityId: gym.id,
  });
}

async function smsGymLicenseRenewed(gym, endDate, planName) {
  const contact = await getGymOwnerContact(gym.id);
  const phone = contact?.phone || gym.phone;
  if (!phone) return { ok: false, error: 'no_phone' };
  const gymName = gym.name || contact?.gym_name || 'your gym';
  const ends = formatDisplayDateFromIso(endDate) || 'soon';
  const message = `${SMS_BRAND}: Your platform license for ${gymName} (${planName || 'plan'}) has been renewed. New term ends on ${ends}.`;
  return deliverSms({
    to: phone,
    message,
    messageType: SMS_TYPES.GYM_LICENSE_RENEWED,
    entityType: 'gym',
    entityId: gym.id,
  });
}

module.exports = {
  SMS_TYPES,
  MESSAGE_CHANNELS,
  isSmsConfigured,
  isTelegramConfigured,
  logOtpSms,
  linkSignupOtpToGym,
  deliverMessage,
  deliverSms,
  deliverTelegram,
  deliverMemberMessage,
  resolveMemberChannel,
  memberReachable,
  isMemberMessagingConfigured,
  smsMemberDueSoon,
  smsMemberExpiresToday,
  smsMemberExpired,
  smsMemberRenewed,
  smsMemberEnrolled,
  smsMemberPassLink,
  smsGymLicenseDueIn3Days,
  smsGymLicenseExpiresToday,
  smsGymLicenseExpired,
  smsGymLicenseRenewed,
  getGymOwnerContact,
  logSms,
};
