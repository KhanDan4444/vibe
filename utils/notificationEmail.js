/**
 * @file notificationEmail.js
 * @description Email templates for expiry cron alerts (members + gym licenses).
 */

const db = require('../config/db');
const { sendEmail } = require('./email');
const { ROLES } = require('./roles');

async function getGymOwnerEmail(gymId) {
  const result = await db.query(
    `
    SELECT u.email, u.name AS owner_name, g.name AS gym_name
    FROM Users u
    JOIN Gyms g ON g.id = u.gym_id
    WHERE u.gym_id = $1 AND u.role = $2
    LIMIT 1
  `,
    [gymId, ROLES.GYM_OWNER]
  );
  return result.rows[0] || null;
}

async function getPlatformAdminEmails() {
  const result = await db.query(
    `SELECT email, name FROM Users WHERE role = $1`,
    [ROLES.PLATFORM_ADMIN]
  );
  return result.rows;
}

function formatMemberList(members) {
  return members
    .map((m) => `  • ${m.name}${m.phone ? ` (${m.phone})` : ''} — ends ${m.end_date || 'today'}`)
    .join('\n');
}

/**
 * Notify gym owner about member membership events.
 */
async function emailGymOwnerMemberAlert(gymId, subject, intro, members) {
  if (!members?.length) return;
  const owner = await getGymOwnerEmail(gymId);
  if (!owner?.email) return;

  const text = [
    `Hello ${owner.owner_name},`,
    '',
    intro,
    '',
    formatMemberList(members),
    '',
    `Gym: ${owner.gym_name}`,
    '',
    'Log in to your VibeSaaS dashboard to renew memberships or follow up with members.',
  ].join('\n');

  await sendEmail({
    to: owner.email,
    subject: `[${owner.gym_name}] ${subject}`,
    text,
  });
}

/**
 * Notify gym owner about their SaaS license.
 */
async function emailGymOwnerLicenseAlert(gym, subject, bodyLines, { isTrial = false } = {}) {
  const owner = await getGymOwnerEmail(gym.id);
  if (!owner?.email) return;

  const footer = isTrial
    ? 'Contact your platform administrator to subscribe and continue using the portal.'
    : 'Contact your platform administrator to renew your SaaS license.';

  const text = [
    `Hello ${owner.owner_name},`,
    '',
    ...bodyLines,
    '',
    `Gym: ${gym.name}`,
    '',
    footer,
  ].join('\n');

  await sendEmail({
    to: owner.email,
    subject: `[${gym.name}] ${subject}`,
    text,
  });
}

/**
 * Daily digest for platform admins — free trials ending within the next week.
 * @param {Array<{ id: number, name: string, owner_name?: string, end_date: string, city?: string }>} gyms
 */
async function emailPlatformAdminsTrialsEndingAlert(gyms) {
  if (!gyms?.length) return;
  const admins = await getPlatformAdminEmails();
  if (admins.length === 0) return;

  const lines = gyms.map(
    (g) =>
      `  • ${g.name}${g.city ? ` (${g.city})` : ''} — trial ends ${g.end_date}${
        g.owner_name ? ` — ${g.owner_name}` : ''
      }`
  );

  const text = [
    'The following gyms are on a free trial and their access ends within 7 days:',
    '',
    ...lines,
    '',
    'Open the admin dashboard and use the “Trial ending” filter to renew them on a SaaS plan.',
  ].join('\n');

  await Promise.all(
    admins.map((admin) =>
      sendEmail({
        to: admin.email,
        subject: `[VibeSaaS] ${gyms.length} free trial(s) ending this week`,
        text: `Hello ${admin.name},\n\n${text}`,
      })
    )
  );
}

/**
 * Notify platform admins about gym license events.
 */
async function emailPlatformAdminsLicenseAlert(subject, bodyLines) {
  const admins = await getPlatformAdminEmails();
  if (admins.length === 0) return;

  const text = [
    'Platform admin alert',
    '',
    ...bodyLines,
    '',
    'Review the gym in the VibeSaaS admin dashboard.',
  ].join('\n');

  await Promise.all(
    admins.map((admin) =>
      sendEmail({
        to: admin.email,
        subject: `[VibeSaaS] ${subject}`,
        text: `Hello ${admin.name},\n\n${text}`,
      })
    )
  );
}

function groupMembersByGym(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.gym_id)) map.set(row.gym_id, []);
    map.get(row.gym_id).push(row);
  });
  return map;
}

module.exports = {
  emailGymOwnerMemberAlert,
  emailGymOwnerLicenseAlert,
  emailPlatformAdminsLicenseAlert,
  emailPlatformAdminsTrialsEndingAlert,
  groupMembersByGym,
};
