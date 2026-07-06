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
async function emailGymOwnerLicenseAlert(gym, subject, bodyLines) {
  const owner = await getGymOwnerEmail(gym.id);
  if (!owner?.email) return;

  const text = [
    `Hello ${owner.owner_name},`,
    '',
    ...bodyLines,
    '',
    `Gym: ${gym.name}`,
    '',
    'Contact your platform administrator to renew your SaaS license.',
  ].join('\n');

  await sendEmail({
    to: owner.email,
    subject: `[${gym.name}] ${subject}`,
    text,
  });
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
  groupMembersByGym,
};
