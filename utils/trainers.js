/**
 * @file utils/trainers.js
 * @description Trainer lookup helpers (employees, not logins).
 */

const db = require('../config/db');

function mapTrainerRow(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || null,
    specialty: row.specialty || null,
    branch_id: row.branch_id,
    branch_name: row.branch_name || null,
    deleted_at: row.deleted_at || null,
    created_at: row.created_at || null,
  };
}

async function findLiveTrainerInGym(trainerId, gymId, executor = db) {
  const result = await executor.query(
    `
    SELECT t.id, t.name, t.phone, t.specialty, t.branch_id, t.deleted_at, b.name AS branch_name
    FROM Trainers t
    LEFT JOIN Branches b ON b.id = t.branch_id
    WHERE t.id = $1 AND t.gym_id = $2 AND t.deleted_at IS NULL
    `,
    [trainerId, gymId]
  );
  return result.rows[0] || null;
}

/**
 * Assign trainer and optionally record a trainer-fee payment (does not count as membership payment).
 */
async function assignTrainerToMember(executor, {
  gymId,
  memberId,
  trainerId,
  trainerFee,
  feeDate,
  feeMethod,
}) {
  if (trainerId == null) {
    await executor.query(
      `UPDATE Members SET trainer_id = NULL WHERE id = $1 AND gym_id = $2`,
      [memberId, gymId]
    );
    return { trainer: null, payment: null };
  }

  const trainer = await findLiveTrainerInGym(trainerId, gymId, executor);
  if (!trainer) {
    const err = new Error('Trainer not found.');
    err.statusCode = 404;
    throw err;
  }

  await executor.query(
    `UPDATE Members SET trainer_id = $1 WHERE id = $2 AND gym_id = $3`,
    [trainerId, memberId, gymId]
  );

  const fee = trainerFee != null ? Number(trainerFee) : 0;
  if (!(fee > 0)) {
    return { trainer, payment: null };
  }

  const { PAYMENT_SOURCES } = require('./paymentSources');
  const paymentResult = await executor.query(
    `
    INSERT INTO Payments (member_id, gym_id, amount, date, method, source)
    VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), COALESCE($5, 'Cash'), $6)
    RETURNING *
    `,
    [memberId, gymId, fee, feeDate || null, feeMethod || 'Cash', PAYMENT_SOURCES.TRAINER]
  );
  return { trainer, payment: paymentResult.rows[0] };
}

module.exports = {
  mapTrainerRow,
  findLiveTrainerInGym,
  assignTrainerToMember,
};
