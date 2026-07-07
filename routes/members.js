/**
 * @file routes/members.js
 * @description Gym Members Management Router.
 * Handles adding, retrieving, updating, and deleting members within a gym owner's tenant scope.
 * Automatically recalculates member subscription expiration dates based on the assigned plan duration.
 * Utilizes `checkSubscription` middleware to enforce SaaS billing state checks.
 * * @module routes/members
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const { calculateEndDate } = require('../utils/memberDates');
const { todayLocalString } = require('../utils/localDate');
const { deriveMemberStatusFromEndDate, normalizeMemberStatus, MEMBER_STATUS } = require('../utils/memberStatus');
const { parsePaginationQuery, paginatedResponse } = require('../utils/pagination');
const { parseMemberListSortOrder } = require('../utils/listSortSql');
const { buildMemberListFilters, MEMBER_IS_UNPAID_SELECT } = require('../utils/memberListSql');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { memberListQuerySchema } = require('../validation/querySchemas');
const {
  idParamSchema,
  createMemberSchema,
  enrollMemberSchema,
  renewMemberSchema,
  changeMemberPlanSchema,
  transferMemberSchema,
  updateMemberSchema,
} = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');
const { resolveBranchScope, gymBranchParams } = require('../utils/branchScope');
const { resolveMemberBranchId, assertMemberBranchWritable, assertBranchInGym } = require('../utils/branches');
const {
  queryMemberPaidForCurrentTerm,
  queryHasPaidTermStartingOn,
  queryChangePlanPaymentExistsOnCalendarDate,
  minimumRenewStartDate,
  calendarDateString,
  validatePaymentDate,
} = require('../utils/memberPayments');
const { validatePlanPaymentAmount } = require('../utils/paymentValidation');
const {
  parsePhotoDataUrl,
  saveMemberPhoto,
  removeMemberPhotoFiles,
  resolveMemberPhotoOnDisk,
} = require('../utils/memberPhotos');
const { PAYMENT_SOURCES } = require('../utils/paymentSources');

router.use(auth, checkSubscription, requireGymAccess);

async function memberBranchClause(req) {
  const scope = await resolveBranchScope(req);
  if (scope.error) return { error: scope.error };
  return {
    scope,
    sql: scope.branchId ? ' AND branch_id = $3' : '',
    aliasSql: scope.memberSql.replace('$2', '$3'),
    params: scope.params,
  };
}

/**
 * POST /api/members
 * @description Adds a new member to the owner's gym tenant scope (FR-5, FR-8).
 * Automatically calculates the member's `end_date` based on the selected plan duration.
 * Restricts access to Gym Owners only.
 * * @name add-member
 * @route {POST} /api/members
 * @header {String} Authorization - Bearer token.
 * @bodyparam {String} name - Member's full name.
 * @bodyparam {String} [phone] - Member's phone number.
 * @bodyparam {Number} plan_id - ID of the Plan to subscribe the member to.
 * @bodyparam {String} start_date - Start date of the membership (YYYY-MM-DD).
 */
router.post('/', requireActiveSubscription, validateBody(createMemberSchema), async (req, res, next) => {
  const { name, phone, plan_id, start_date, branch_id: bodyBranchId } = req.body;
  const gym_id = req.user.gym_id;

  try {
    const branch_id = await resolveMemberBranchId(req, bodyBranchId);
    const planResult = await db.query('SELECT duration FROM Plans WHERE id = $1 AND gym_id = $2', [plan_id, gym_id]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Membership plan not found.' });
    }
    const duration = planResult.rows[0].duration;
    const end_date = calculateEndDate(start_date, duration);
    const status = deriveMemberStatusFromEndDate(end_date);

    const insertQuery = `
      INSERT INTO Members (gym_id, branch_id, name, phone, plan_id, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const result = await db.query(insertQuery, [
      gym_id,
      branch_id,
      name,
      phone,
      plan_id,
      start_date,
      end_date,
      status,
    ]);
    const member = result.rows[0];
    await recordAuditLog({
      req,
      action: ACTIONS.MEMBER_CREATED,
      entityType: 'member',
      entityId: member.id,
      entityLabel: member.name,
      details: { plan_id, start_date, end_date: member.end_date, branch_id },
    });
    res.status(201).json(member);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/members/enroll
 * @description Registers a new member and records initial payment in one transaction.
 * @bodyparam {Boolean} [skip_payment] - If true, member is created without a payment record.
 */
router.post('/enroll', requireActiveSubscription, validateBody(enrollMemberSchema), async (req, res, next) => {
  const { name, phone, plan_id, start_date, amount, date, method, skip_payment, branch_id: bodyBranchId, photo } = req.body;
  const gym_id = req.user.gym_id;

  const photoCheck = parsePhotoDataUrl(photo);
  if (!photoCheck.ok) {
    return res.status(400).json({ error: photoCheck.error });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const branch_id = await resolveMemberBranchId(req, bodyBranchId, client);

    const planResult = await client.query(
      'SELECT duration, price FROM Plans WHERE id = $1 AND gym_id = $2',
      [plan_id, gym_id]
    );
    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Membership plan not found.' });
    }

    const { duration, price: planPrice } = planResult.rows[0];
    const end_date = calculateEndDate(start_date, duration);
    const status = deriveMemberStatusFromEndDate(end_date);

    const memberResult = await client.query(
      `
      INSERT INTO Members (gym_id, branch_id, name, phone, plan_id, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
      `,
      [gym_id, branch_id, name, phone, plan_id, start_date, end_date, status]
    );

    let payment = null;
    if (!skip_payment) {
      const paymentDateCheck = validatePaymentDate(date || todayLocalString(), start_date);
      if (!paymentDateCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: paymentDateCheck.error });
      }

      const paymentAmount = amount != null ? parseFloat(amount) : parseFloat(planPrice);
      const amountCheck = validatePlanPaymentAmount(paymentAmount, planPrice);
      if (!amountCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: amountCheck.error });
      }

      const paymentResult = await client.query(
        `
        INSERT INTO Payments (member_id, gym_id, amount, date, method, source)
        VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), COALESCE($5, 'Cash'), $6)
        RETURNING *;
        `,
        [memberResult.rows[0].id, gym_id, paymentAmount, date || null, method || 'Cash', PAYMENT_SOURCES.ENROLL]
      );
      payment = paymentResult.rows[0];
    }

    let member = memberResult.rows[0];
    if (photo && photoCheck.buffer) {
      const saved = await saveMemberPhoto(gym_id, member.id, photo);
      if (!saved.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: saved.error });
      }
      const photoUpdate = await client.query(
        'UPDATE Members SET photo_url = $1 WHERE id = $2 AND gym_id = $3 RETURNING *',
        [saved.photoUrl, member.id, gym_id]
      );
      member = photoUpdate.rows[0];
    }

    await recordAuditLog({
      req,
      client,
      action: ACTIONS.MEMBER_ENROLLED,
      entityType: 'member',
      entityId: memberResult.rows[0].id,
      entityLabel: member.name,
      details: {
        plan_id,
        start_date,
        skip_payment: !!skip_payment,
        payment_amount: payment ? parseFloat(payment.amount) : null,
        payment_method: payment?.method || null,
      },
    });

    await client.query('COMMIT');
    res.status(201).json({ member, payment });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * GET /api/members
 * @queryparam {Number} [page=1]
 * @queryparam {Number} [limit=50]
 * @queryparam {String} [search] - Name or phone
 * @queryparam {String} [status] - Active, Expired, Due Soon
 * @queryparam {String} [filter] - due_soon | expired | unpaid
 */
router.get('/', validateQuery(memberListQuerySchema), async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const memberOrderBy = parseMemberListSortOrder(req.query.sort);

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const syncParams = [gym_id, ...scope.params];
    const syncBranch = scope.branchId ? ' AND branch_id = $2' : '';
    await db.query(
      `
      UPDATE Members
      SET status = CASE
        WHEN end_date < CURRENT_DATE THEN 'expired'
        WHEN end_date <= CURRENT_DATE + INTERVAL '3 days' THEN 'due soon'
        ELSE 'active'
      END
      WHERE gym_id = $1${syncBranch} AND LOWER(status) IN ('active', 'due soon', 'expired')
      `,
      syncParams
    );

    const filterStartIdx = 2 + scope.params.length;
    const { whereExtra, params } = buildMemberListFilters(req.query, filterStartIdx);
    const listParams = [gym_id, ...scope.params, ...params];
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM Members m WHERE m.gym_id = $1${scope.memberSql}${whereExtra}`,
      listParams
    );
    const total = countResult.rows[0].count;

    const pagedParams = [...listParams, limit, offset];
    const limitIdx = pagedParams.length - 1;
    const offsetIdx = pagedParams.length;

    const result = await db.query(
      `
      SELECT m.*, p.name AS plan_name, b.name AS branch_name, ${MEMBER_IS_UNPAID_SELECT}
      FROM Members m
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.gym_id = $1${scope.memberSql}${whereExtra}
      ORDER BY ${memberOrderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      pagedParams
    );

    res.json(paginatedResponse(result.rows, total, page, limit));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/members/:id/photo
 */
router.get('/:id/photo', validateParams(idParamSchema), async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const { id } = req.params;

  try {
    const access = await memberBranchClause(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }

    const result = await db.query(
      `SELECT photo_url FROM Members WHERE id = $1 AND gym_id = $2${access.sql}`,
      [id, gym_id, ...access.params]
    );
    if (result.rows.length === 0 || !result.rows[0].photo_url) {
      return res.status(404).json({ error: 'Photo not found.' });
    }

    const file = resolveMemberPhotoOnDisk(result.rows[0].photo_url);
    if (!file) {
      return res.status(404).json({ error: 'Photo not found.' });
    }

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(file.absolute);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/members/:id/payments
 */
router.get('/:id/payments', validateParams(idParamSchema), async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const { id } = req.params;

  try {
    const access = await memberBranchClause(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }

    const memberCheck = await db.query(
      `SELECT id FROM Members WHERE id = $1 AND gym_id = $2${access.sql}`,
      [id, gym_id, ...access.params]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }

    const result = await db.query(
      `
      SELECT * FROM Payments
      WHERE member_id = $1 AND gym_id = $2
      ORDER BY date DESC, id DESC
      `,
      [id, gym_id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/members/:id
 */
router.get('/:id', validateParams(idParamSchema), async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const { id } = req.params;

  try {
    const access = await memberBranchClause(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }

    const result = await db.query(
      `
      SELECT m.*, p.name AS plan_name, b.name AS branch_name, ${MEMBER_IS_UNPAID_SELECT}
      FROM Members m
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.id = $1 AND m.gym_id = $2${access.aliasSql}
      `,
      [id, gym_id, ...access.params]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/members/:id/renew
 * @description Renews a member's subscription and records payment in one transaction.
 * @bodyparam {Number} [plan_id] - Plan for the new term (defaults to current plan).
 * @bodyparam {String} [start_date] - Renewal start date YYYY-MM-DD (defaults to today).
 * @bodyparam {Number} amount - Payment amount received.
 * @bodyparam {String} [date] - Payment date (defaults to today).
 * @bodyparam {String} [method] - Payment method (defaults to Cash).
 */
router.post('/:id/renew', requireActiveSubscription, validateParams(idParamSchema), validateBody(renewMemberSchema), async (req, res, next) => {
  const { id } = req.params;
  const gym_id = req.user.gym_id;
  const { plan_id, start_date, amount, date, method } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const access = await memberBranchClause(req);
    if (access.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: access.error });
    }

    const memberResult = await client.query(
      `SELECT * FROM Members WHERE id = $1 AND gym_id = $2${access.sql} FOR UPDATE`,
      [id, gym_id, ...access.params]
    );
    if (memberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }
    await assertMemberBranchWritable(id, gym_id, client);

    const currentMember = memberResult.rows[0];
    const targetPlanId = plan_id || currentMember.plan_id;
    if (!targetPlanId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Member has no plan assigned. Select a plan to renew.' });
    }

    const paidForCurrentTerm = await queryMemberPaidForCurrentTerm(client, id, gym_id);
    if (!paidForCurrentTerm) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This member has no payment for their current term. Collect payment first, then renew when the term ends.',
      });
    }

    const targetStartDate = start_date || todayLocalString();
    const minStartDate = minimumRenewStartDate(currentMember, paidForCurrentTerm);
    if (targetStartDate < minStartDate) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `New term cannot start before ${minStartDate}. Current term is paid through ${String(currentMember.end_date).split('T')[0]}.`,
      });
    }

    if (await queryHasPaidTermStartingOn(client, id, gym_id, targetStartDate)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A payment is already recorded for this renewal term.',
      });
    }

    const planResult = await client.query(
      'SELECT duration, price FROM Plans WHERE id = $1 AND gym_id = $2',
      [targetPlanId, gym_id]
    );
    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Membership plan not found.' });
    }

    const amountCheck = validatePlanPaymentAmount(amount, planResult.rows[0].price);
    if (!amountCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: amountCheck.error });
    }

    const end_date = calculateEndDate(targetStartDate, planResult.rows[0].duration);
    const status = deriveMemberStatusFromEndDate(end_date);

    const paymentDateCheck = validatePaymentDate(date || todayLocalString(), targetStartDate);
    if (!paymentDateCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    const updatedMember = await client.query(
      `
      UPDATE Members
      SET plan_id = $1, start_date = $2, end_date = $3, status = $4
      WHERE id = $5 AND gym_id = $6
      RETURNING *;
      `,
      [targetPlanId, targetStartDate, end_date, status, id, gym_id]
    );

    const paymentResult = await client.query(
      `
      INSERT INTO Payments (member_id, gym_id, amount, date, method, source)
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), COALESCE($5, 'Cash'), $6)
      RETURNING *;
      `,
      [id, gym_id, amount, date || null, method || 'Cash', PAYMENT_SOURCES.RENEW]
    );

    await recordAuditLog({
      req,
      client,
      action: ACTIONS.MEMBER_RENEWED,
      entityType: 'member',
      entityId: updatedMember.rows[0].id,
      entityLabel: updatedMember.rows[0].name,
      details: {
        plan_id: targetPlanId,
        start_date: targetStartDate,
        end_date,
        payment_amount: parseFloat(paymentResult.rows[0].amount),
        payment_method: paymentResult.rows[0].method,
      },
    });

    await client.query('COMMIT');
    res.json({
      member: updatedMember.rows[0],
      payment: paymentResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/members/:id/change-plan
 * Switch plan mid-term for an active member, or before first payment when enrolled unpaid.
 */
router.post(
  '/:id/change-plan',
  requireActiveSubscription,
  validateParams(idParamSchema),
  validateBody(changeMemberPlanSchema),
  async (req, res, next) => {
    const { id } = req.params;
    const gym_id = req.user.gym_id;
    const { plan_id, start_date, amount, date, method } = req.body;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const access = await memberBranchClause(req);
      if (access.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: access.error });
      }

      const memberResult = await client.query(
        `SELECT * FROM Members WHERE id = $1 AND gym_id = $2${access.sql} FOR UPDATE`,
        [id, gym_id, ...access.params]
      );
      if (memberResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Member not found or unauthorized.' });
      }
      await assertMemberBranchWritable(id, gym_id, client);

      const currentMember = memberResult.rows[0];
      const memberStatus = normalizeMemberStatus(currentMember.status);

      if (memberStatus !== MEMBER_STATUS.ACTIVE) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            memberStatus === MEMBER_STATUS.DUE_SOON || memberStatus === MEMBER_STATUS.EXPIRED
              ? 'Use Renew when the current term is ending or has ended.'
              : 'Plan changes are only available for active memberships.',
        });
      }

      const paidForCurrentTerm = await queryMemberPaidForCurrentTerm(client, id, gym_id);

      const targetPlanId = plan_id;
      if (targetPlanId === currentMember.plan_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Select a different plan. To extend the same plan, use Renew when the term ends.',
        });
      }

      const planResult = await client.query(
        'SELECT id, name, duration, price FROM Plans WHERE id = $1 AND gym_id = $2',
        [targetPlanId, gym_id]
      );
      if (planResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Membership plan not found.' });
      }

      const currentStartDate = calendarDateString(currentMember.start_date);
      const targetStartDate = start_date || currentStartDate;
      if (targetStartDate > todayLocalString()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'New term cannot start in the future.' });
      }

      const sameTermStart = targetStartDate === currentStartDate;
      const paymentAmount = parseFloat(amount);

      if (!paidForCurrentTerm) {
        if (!sameTermStart && paymentAmount <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Enter the payment collected for this new term start date.',
          });
        }
      } else {
        if (!sameTermStart && paymentAmount <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Enter the payment collected for this new term start date.',
          });
        }

        if (!sameTermStart && (await queryHasPaidTermStartingOn(client, id, gym_id, targetStartDate))) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error:
              'A payment is already recorded for a term starting on this date. Edit or remove it before changing plan again.',
          });
        }
      }

      const end_date =
        paidForCurrentTerm &&
        sameTermStart &&
        Number(planResult.rows[0].price) <=
          Number(
            (
              await client.query('SELECT price FROM Plans WHERE id = $1', [currentMember.plan_id])
            ).rows[0]?.price ?? Infinity
          ) &&
        currentMember.end_date
          ? calendarDateString(currentMember.end_date)
          : calculateEndDate(targetStartDate, planResult.rows[0].duration);
      const status = deriveMemberStatusFromEndDate(end_date);

      const previousPlanResult = await client.query(
        'SELECT name FROM Plans WHERE id = $1',
        [currentMember.plan_id]
      );
      const previousPlanName = previousPlanResult.rows[0]?.name ?? null;

      const updatedMember = await client.query(
        `
        UPDATE Members
        SET plan_id = $1, start_date = $2, end_date = $3, status = $4
        WHERE id = $5 AND gym_id = $6
        RETURNING *;
        `,
        [targetPlanId, targetStartDate, end_date, status, id, gym_id]
      );

      let payment = null;
      if (paymentAmount > 0) {
        const paymentDate = date || todayLocalString();
        const paymentDateCheck = validatePaymentDate(paymentDate, targetStartDate);
        if (!paymentDateCheck.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: paymentDateCheck.error });
        }

        if (
          paidForCurrentTerm &&
          sameTermStart &&
          (await queryChangePlanPaymentExistsOnCalendarDate(client, id, gym_id, paymentDate))
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `A plan-change payment is already recorded on ${calendarDateString(paymentDate)}. Remove or edit it first, or choose a different payment date.`,
          });
        }

        const amountCheck = validatePlanPaymentAmount(paymentAmount, planResult.rows[0].price);
        if (!amountCheck.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: amountCheck.error });
        }

        const paymentResult = await client.query(
          `
          INSERT INTO Payments (member_id, gym_id, amount, date, method, source)
          VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), COALESCE($5, 'Cash'), $6)
          RETURNING *;
          `,
          [id, gym_id, paymentAmount, date || null, method || 'Cash', PAYMENT_SOURCES.CHANGE_PLAN]
        );
        payment = paymentResult.rows[0];
      }

      await recordAuditLog({
        req,
        client,
        action: ACTIONS.MEMBER_PLAN_CHANGED,
        entityType: 'member',
        entityId: updatedMember.rows[0].id,
        entityLabel: updatedMember.rows[0].name,
        details: {
          previous_plan_id: currentMember.plan_id,
          previous_plan_name: previousPlanName,
          plan_id: targetPlanId,
          plan_name: planResult.rows[0].name,
          start_date: targetStartDate,
          end_date,
          payment_amount: payment ? parseFloat(payment.amount) : 0,
          payment_method: payment?.method ?? null,
          same_term_start: sameTermStart,
        },
      });

      await client.query('COMMIT');
      res.json({
        member: updatedMember.rows[0],
        payment,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  }
);

/**
 * POST /api/members/:id/transfer
 * Owner-only: move a member to another active branch (allowed from inactive branches).
 */
router.post(
  '/:id/transfer',
  requireGymOwner,
  requireActiveSubscription,
  validateParams(idParamSchema),
  validateBody(transferMemberSchema),
  async (req, res, next) => {
    const { id } = req.params;
    const { branch_id: targetBranchId } = req.body;
    const gym_id = req.user.gym_id;

    try {
      const memberRes = await db.query(
        `
        SELECT m.*, b.name AS branch_name
        FROM Members m
        JOIN Branches b ON b.id = m.branch_id
        WHERE m.id = $1 AND m.gym_id = $2
        `,
        [id, gym_id]
      );
      if (memberRes.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found.' });
      }
      const member = memberRes.rows[0];

      if (member.branch_id === targetBranchId) {
        return res.status(400).json({ error: 'Member is already at this branch.' });
      }

      const targetBranch = await assertBranchInGym(targetBranchId, gym_id);

      await db.query(`UPDATE Members SET branch_id = $1 WHERE id = $2 AND gym_id = $3`, [
        targetBranchId,
        id,
        gym_id,
      ]);

      await recordAuditLog({
        req,
        action: ACTIONS.MEMBER_TRANSFERRED,
        entityType: 'member',
        entityId: parseInt(id, 10),
        entityLabel: member.name,
        details: {
          from_branch_id: member.branch_id,
          from_branch_name: member.branch_name,
          to_branch_id: targetBranchId,
          to_branch_name: targetBranch.name,
          branch_id: targetBranchId,
        },
      });

      const updated = await db.query(
        `
        SELECT m.*, b.name AS branch_name, p.name AS plan_name,
          ${MEMBER_IS_UNPAID_SELECT}
        FROM Members m
        LEFT JOIN Branches b ON b.id = m.branch_id
        LEFT JOIN Plans p ON p.id = m.plan_id
        WHERE m.id = $1
        `,
        [id]
      );
      res.json(updated.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/members/:id
 * @description Updates member details scoped to the owner's gym tenant scope (FR-5, FR-8).
 * Automatically recalculates member subscription end date if plan_id or start_date is updated.
 * Restricts access to Gym Owners only.
 * * @name update-member
 * @route {PUT} /api/members/:id
 * @header {String} Authorization - Bearer token.
 * @routeparam {Number} id - Member database ID.
 * @bodyparam {String} [name] - Updated member name.
 * @bodyparam {String} [phone] - Updated member phone number.
 * @bodyparam {Number} [plan_id] - Updated membership plan ID (triggers recalculation).
 * @bodyparam {String} [start_date] - Updated membership start date (triggers recalculation).
 */
router.put('/:id', requireActiveSubscription, validateParams(idParamSchema), validateBody(updateMemberSchema), async (req, res, next) => {
  const { id } = req.params;
  const { name, phone, plan_id, start_date, branch_id, photo } = req.body;
  const gym_id = req.user.gym_id;
  const { isGymOwner } = require('../utils/roles');

  if (plan_id !== undefined || start_date !== undefined) {
    return res.status(400).json({
      error: 'Plan and start date cannot be edited here. Use Renew to start a new membership term.',
    });
  }

  try {
    const access = await memberBranchClause(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }

    const memberCheck = await db.query(
      `SELECT * FROM Members WHERE id = $1 AND gym_id = $2${access.sql}`,
      [id, gym_id, ...access.params]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }
    await assertMemberBranchWritable(id, gym_id);

    const currentMember = memberCheck.rows[0];

    let newBranchId = currentMember.branch_id;
    if (branch_id !== undefined) {
      const parsedBranch = parseInt(branch_id, 10);
      if (!Number.isNaN(parsedBranch) && parsedBranch > 0 && parsedBranch !== currentMember.branch_id) {
        if (!isGymOwner(req.user.role)) {
          return res.status(403).json({ error: 'Only the gym owner can change a member\'s branch.' });
        }
        await assertBranchInGym(parsedBranch, gym_id);
        newBranchId = parsedBranch;
      }
    }

    let newPhotoUrl = currentMember.photo_url;
    if (photo !== undefined) {
      if (photo === null || photo === '') {
        if (currentMember.photo_url) {
          await removeMemberPhotoFiles(gym_id, id);
        }
        newPhotoUrl = null;
      } else {
        const photoCheck = parsePhotoDataUrl(photo);
        if (!photoCheck.ok) {
          return res.status(400).json({ error: photoCheck.error });
        }
        const saved = await saveMemberPhoto(gym_id, id, photo);
        if (!saved.ok) {
          return res.status(400).json({ error: saved.error });
        }
        newPhotoUrl = saved.photoUrl;
      }
    }

    const updateQuery = `
      UPDATE Members 
      SET name = $1, phone = $2, branch_id = $3, photo_url = $4
      WHERE id = $5 AND gym_id = $6
      RETURNING *;
    `;
    const result = await db.query(updateQuery, [
      name || currentMember.name,
      phone !== undefined ? phone : currentMember.phone,
      newBranchId,
      newPhotoUrl,
      id,
      gym_id,
    ]);

    const updated = result.rows[0];
    const enriched = await db.query(
      `
      SELECT m.*, p.name AS plan_name, b.name AS branch_name, ${MEMBER_IS_UNPAID_SELECT}
      FROM Members m
      LEFT JOIN Plans p ON p.id = m.plan_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.id = $1 AND m.gym_id = $2
      `,
      [id, gym_id]
    );

    const auditDetails = { name: updated.name, phone: updated.phone };
    if (newBranchId !== currentMember.branch_id) {
      auditDetails.branch_id = newBranchId;
      auditDetails.from_branch_id = currentMember.branch_id;
    }
    if (photo !== undefined && newPhotoUrl !== currentMember.photo_url) {
      auditDetails.photo_updated = true;
    }

    await recordAuditLog({
      req,
      action: ACTIONS.MEMBER_UPDATED,
      entityType: 'member',
      entityId: updated.id,
      entityLabel: updated.name,
      details: auditDetails,
    });
    res.json(enriched.rows[0] || updated);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/members/:id
 * @description Deletes a gym member. Gym owners only (staff may enroll/renew/update in-branch).
 */
router.delete('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), async (req, res, next) => {
  const { id } = req.params;
  const gym_id = req.user.gym_id;

  try {
    await assertMemberBranchWritable(id, gym_id);

    const deleteQuery = `
      DELETE FROM Members 
      WHERE id = $1 AND gym_id = $2
      RETURNING *;
    `;
    const result = await db.query(deleteQuery, [id, gym_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }

    const deleted = result.rows[0];
    if (deleted.photo_url) {
      await removeMemberPhotoFiles(gym_id, deleted.id);
    }
    await recordAuditLog({
      req,
      action: ACTIONS.MEMBER_DELETED,
      entityType: 'member',
      entityId: deleted.id,
      entityLabel: deleted.name,
    });
    res.json({ message: 'Member successfully deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
