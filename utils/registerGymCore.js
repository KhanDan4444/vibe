/**
 * @file registerGymCore.js
 * @description Shared gym + owner registration (used by admin enroll and public signup).
 */

const bcrypt = require('bcrypt');
const { ROLES } = require('./roles');
const { createDefaultBranch } = require('./branches');
const { assignSaasPlanToGym } = require('./saasSubscription');
const { todayLocalString } = require('./localDate');
const { normalizeEthiopianPhone } = require('./phone');

/**
 * @param {import('pg').PoolClient} client
 * @param {object} data
 */
async function registerGymWithOwner(client, data) {
  const {
    gym_name,
    owner_name,
    email,
    username,
    password,
    phone,
    saas_plan_id,
    start_date,
  } = data;

  const normalizedPhone = normalizeEthiopianPhone(phone);
  const gymResult = await client.query(
    'INSERT INTO Gyms (name, owner_name, phone) VALUES ($1, $2, $3) RETURNING *',
    [gym_name.trim(), owner_name.trim(), normalizedPhone]
  );
  const gymId = gymResult.rows[0].id;

  await createDefaultBranch(client, gymId);

  const hashedPassword = await bcrypt.hash(password, 10);
  const userResult = await client.query(
    `
    INSERT INTO Users (name, email, username, password, role, gym_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, name, email, username, role, gym_id
    `,
    [owner_name.trim(), email ?? null, username, hashedPassword, ROLES.GYM_OWNER, gymId]
  );

  const licenseStart = start_date || todayLocalString();
  const subscription = await assignSaasPlanToGym(
    client,
    gymId,
    parseInt(saas_plan_id, 10),
    licenseStart
  );

  return {
    gym: gymResult.rows[0],
    owner: userResult.rows[0],
    subscription,
  };
}

module.exports = { registerGymWithOwner };
