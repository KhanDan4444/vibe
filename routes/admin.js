/**
 * @file routes/admin.js
 * @description Platform Administration Router.
 * Provides system-wide administration features, including registering/suspending/deleting gyms (tenants),
 * managing SaaS licensing states, and aggregating global system revenue analytics.
 * Guards all routes in this file using `auth` and `adminCheck` middlewares.
 * * @module routes/admin
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/db');
const auth = require('../middleware/auth');
const adminCheck = require('../middleware/adminCheck');
const { ROLES } = require('../utils/roles');
const { DUE_SOON_DAYS } = require('../utils/memberStatus');
const { MEMBER_UNPAID_SQL } = require('../utils/memberListSql');
const { createDefaultBranch } = require('../utils/branches');
const { assignSaasPlanToGym } = require('../utils/saasSubscription');
const { gymHasPaymentForCurrentTerm, validatePaymentDate, calendarDateString, minimumRenewStartDate, queryGymPaidForCurrentTerm, queryHasPaidTermStartingOn, queryPaymentExistsOnCalendarDate } = require('../utils/saasPayments');
const { parsePaginationQuery, paginatedResponse } = require('../utils/pagination');
const {
  parseGymListSortOrder,
  parseAdminPaymentSortOrder,
  DEFAULT_REPORT_ADMIN_REVENUE_SORT,
} = require('../utils/listSortSql');
const { todayLocalString } = require('../utils/localDate');
const { parsePeriodQuery } = require('../utils/paymentPeriodSql');
const { summarizePaymentRows } = require('../utils/paymentSummary');
const { computePercentChange, computeCountDelta } = require('../utils/periodComparison');
const { buildAdminSaaSPaymentWhere } = require('../utils/paymentQuerySql');
const {
  GYM_UNPAID_SQL,
  GYM_IS_UNPAID_SELECT,
  GYM_DUE_SOON_SQL,
  GYM_NEEDS_RENEWAL_SQL,
  buildGymListFilters,
} = require('../utils/gymListSql');
const { validatePlanPaymentAmount } = require('../utils/paymentValidation');
const { PAYMENT_SOURCES } = require('../utils/paymentSources');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  adminGymListQuerySchema,
  adminPaymentListQuerySchema,
  adminGymSmsQuerySchema,
} = require('../validation/querySchemas');
const {
  idParamSchema,
  adminEnrollGymSchema,
  updateGymSchema,
  renewGymSchema,
  changeGymPlanSchema,
  adminCreatePaymentSchema,
  adminUpdatePaymentSchema,
  adminSetPasswordSchema,
} = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');

const GYM_LIST_BASE = `
  SELECT
    g.*,
    COUNT(m.id) FILTER (
      WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
        AND NOT (${MEMBER_UNPAID_SQL})
    )::int AS active_member_count,
    gs.saas_plan_id AS saas_plan_id,
    gs.plan AS saas_plan_name,
    gs.start_date AS saas_start_date,
    gs.end_date AS saas_end_date,
    sp.price AS saas_plan_price,
    sp.duration AS saas_plan_duration,
    ${GYM_IS_UNPAID_SELECT}
  FROM Gyms g
  LEFT JOIN Members m ON m.gym_id = g.id
  LEFT JOIN GymSubscriptions gs ON gs.gym_id = g.id
  LEFT JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
  GROUP BY g.id, gs.saas_plan_id, gs.plan, gs.start_date, gs.end_date, sp.price, sp.duration
`;

// Guard all endpoints inside this router for Platform Admins only
router.use(auth, adminCheck);

// ==========================================
// GYM MANAGEMENT & SUBSCRIPTION CONTROL (FR-1, FR-2)
// ==========================================

/**
 * GET /api/admin/gyms
 * @description Lists all gyms (tenants) registered on the SaaS platform.
 * Restricts access to platform Admins.
 * * @name list-gyms
 * @route {GET} /api/admin/gyms
 * @header {String} Authorization - Bearer token.
 */
router.get('/gyms', validateQuery(adminGymListQuerySchema), async (req, res, next) => {
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const gymOrderBy = parseGymListSortOrder(req.query.sort);

  try {
    const { whereExtra, params } = buildGymListFilters(req.query, 1);

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g ${whereExtra}`,
      params
    );
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const limitIdx = listParams.length - 1;
    const offsetIdx = listParams.length;

    const result = await db.query(
      `
      SELECT * FROM (${GYM_LIST_BASE}) g
      ${whereExtra}
      ORDER BY ${gymOrderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      listParams
    );

    const [allCount, unpaidCount, activeCount, suspendedCount, expiredCount, dueSoonCount, needsRenewalCount] =
      await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE (${GYM_UNPAID_SQL})`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE LOWER(g.subscription_status) = 'active'`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE LOWER(g.subscription_status) = 'suspended'`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE LOWER(g.subscription_status) = 'expired'`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE (${GYM_DUE_SOON_SQL})`),
      db.query(`SELECT COUNT(*)::int AS count FROM (${GYM_LIST_BASE}) g WHERE (${GYM_NEEDS_RENEWAL_SQL})`),
    ]);

    res.json(
      paginatedResponse(result.rows, total, page, limit, {
        counts: {
          all: allCount.rows[0].count,
          unpaid: unpaidCount.rows[0].count,
          active: activeCount.rows[0].count,
          suspended: suspendedCount.rows[0].count,
          expired: expiredCount.rows[0].count,
          dueSoon: dueSoonCount.rows[0].count,
          needsRenewal: needsRenewalCount.rows[0].count,
        },
      })
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/gyms/enroll
 * Register gym + owner + SaaS subscription + optional initial payment (one transaction).
 */
router.post('/gyms/enroll', validateBody(adminEnrollGymSchema), async (req, res, next) => {
  const {
    gym_name,
    owner_name,
    email,
    username,
    password,
    phone,
    saas_plan_id,
    amount,
    date,
    method,
    skip_payment,
    start_date,
  } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const gymResult = await client.query(
      'INSERT INTO Gyms (name, owner_name, phone) VALUES ($1, $2, $3) RETURNING *',
      [gym_name.trim(), owner_name.trim(), phone?.trim() || null]
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

    const licenseStart = skip_payment
      ? calendarDateString(start_date || todayLocalString())
      : calendarDateString(date || start_date || todayLocalString());

    const subscription = await assignSaasPlanToGym(
      client,
      gymId,
      parseInt(saas_plan_id, 10),
      licenseStart
    );

    let payment = null;
    if (!skip_payment) {
      const subscriptionStart = subscription.start_date;
      const paymentDateCheck = validatePaymentDate(date || todayLocalString(), subscriptionStart);
      if (!paymentDateCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: paymentDateCheck.error });
      }

      const paymentAmount = amount != null ? parseFloat(amount) : parseFloat(subscription.plan.price);
      const amountCheck = validatePlanPaymentAmount(paymentAmount, subscription.plan.price);
      if (!amountCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: amountCheck.error });
      }

      const paymentResult = await client.query(
        `
        INSERT INTO SaaSPayments (gym_id, saas_plan_id, amount, date, coverage_start_date, method, source)
        VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, COALESCE($6, 'Bank Transfer'), $7)
        RETURNING *
        `,
        [
          gymId,
          parseInt(saas_plan_id, 10),
          paymentAmount,
          date || null,
          subscription.start_date,
          method || 'Bank Transfer',
          PAYMENT_SOURCES.ENROLL,
        ]
      );
      payment = paymentResult.rows[0];
    }

    await client.query('COMMIT');
    res.status(201).json({
      gym: gymResult.rows[0],
      owner: userResult.rows[0],
      subscription: {
        plan_name: subscription.plan.name,
        start_date: subscription.start_date,
        end_date: subscription.end_date,
      },
      payment,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email or username is already in use.' });
    }
    next(error);
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/gyms/:id
 * @description Gym tenant profile with owner login, member breakdown, and roster.
 */
router.get('/gyms/:id', async (req, res, next) => {
  const { id } = req.params;

  try {
    const gymResult = await db.query(
      `
      SELECT
        g.*,
        u.id AS owner_user_id,
        u.email AS owner_email,
        u.username AS owner_username,
        u.name AS owner_account_name
      FROM Gyms g
      LEFT JOIN Users u ON u.gym_id = g.id AND u.role = $2
      WHERE g.id = $1
      `,
      [id, ROLES.GYM_OWNER]
    );

    if (gymResult.rows.length === 0) {
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const gym = gymResult.rows[0];

    const [statsResult, plansResult, branchesResult, saasSubResult, paymentsResult] = await Promise.all([
      db.query(
      `
      SELECT
        COUNT(*)::int AS total_members,
        COUNT(*) FILTER (
          WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
            AND NOT (${MEMBER_UNPAID_SQL})
        )::int AS active_members,
        COUNT(*) FILTER (WHERE m.end_date < CURRENT_DATE)::int AS expired_members,
        COUNT(*) FILTER (
          WHERE m.end_date >= CURRENT_DATE
            AND m.end_date <= CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
        )::int AS due_soon_members
      FROM Members m
      WHERE m.gym_id = $1
      `,
      [id]
      ),
      db.query(
      'SELECT COUNT(*)::int AS plan_count FROM Plans WHERE gym_id = $1',
      [id]
      ),
      db.query(
      'SELECT COUNT(*)::int AS branch_count FROM Branches WHERE gym_id = $1 AND is_active = true',
      [id]
      ),
      db.query(
      `
      SELECT gs.*, sp.name AS saas_plan_catalog_name, sp.duration AS saas_plan_duration, sp.price AS saas_plan_price
      FROM GymSubscriptions gs
      LEFT JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
      WHERE gs.gym_id = $1
      `,
      [id]
      ),
      db.query(
      `
      SELECT id, amount, date, coverage_start_date, method, notes, saas_plan_id, source
      FROM SaaSPayments
      WHERE gym_id = $1
      ORDER BY date DESC, id DESC
      `,
      [id]
      ),
    ]);

    res.json({
      ...gym,
      stats: statsResult.rows[0],
      plan_count: plansResult.rows[0].plan_count,
      branch_count: branchesResult.rows[0].branch_count,
      saas_subscription: saasSubResult.rows[0] || null,
      saas_payments: paymentsResult.rows,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/gyms/:id
 * @description Updates details or subscription states (e.g. 'active', 'suspended', 'expired') for a specific gym (FR-1, FR-2).
 * Restricts access to platform Admins.
 * * @name update-gym
 * @route {PUT} /api/admin/gyms/:id
 * @header {String} Authorization - Bearer token.
 * @routeparam {Number} id - Gym database ID.
 * @bodyparam {String} [name] - Updated gym name.
 * @bodyparam {String} [owner_name] - Updated owner name.
 * @bodyparam {String} [phone] - Updated contact phone number.
 * @bodyparam {String} subscription_status - Updated subscription state ('active', 'suspended', 'expired').
 */
router.put('/gyms/:id', validateParams(idParamSchema), validateBody(updateGymSchema), async (req, res, next) => {
  const { id } = req.params;
  const { name, owner_name, phone, subscription_status, saas_plan_id } = req.body;

  const normalizedStatus = (subscription_status || 'active').trim().toLowerCase();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const updateQuery = `
      UPDATE Gyms
      SET name = $1,
          owner_name = $2,
          phone = $3,
          subscription_status = $4
      WHERE id = $5
      RETURNING *;
    `;
    const result = await client.query(updateQuery, [
      name.trim(),
      owner_name.trim(),
      phone?.trim() || null,
      normalizedStatus,
      id,
    ]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gym not found.' });
    }

    await client.query(
      `UPDATE Users SET name = $1 WHERE gym_id = $2 AND role = $3`,
      [owner_name.trim(), id, ROLES.GYM_OWNER]
    );

    if (saas_plan_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'SaaS plan changes use Change plan or Renew — not Edit gym.',
      });
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/gyms/:id/reset-owner-password
 * Platform admin sets a new password for the gym owner account.
 */
router.post(
  '/gyms/:id/reset-owner-password',
  validateParams(idParamSchema),
  validateBody(adminSetPasswordSchema),
  async (req, res, next) => {
    const { id } = req.params;
    const { password } = req.body;

    try {
      const ownerResult = await db.query(
        `SELECT id, name FROM Users WHERE gym_id = $1 AND role = $2`,
        [id, ROLES.GYM_OWNER]
      );
      if (ownerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Gym owner account not found.' });
      }

      const owner = ownerResult.rows[0];
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.query(
        `
        UPDATE Users
        SET password = $1, password_changed_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [hashedPassword, owner.id]
      );

      res.json({
        message: 'Owner password updated.',
        owner: { id: owner.id, name: owner.name },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/admin/gyms/:id/renew
 * Renew gym SaaS license and record payment in one transaction.
 */
router.post('/gyms/:id/renew', validateParams(idParamSchema), validateBody(renewGymSchema), async (req, res, next) => {
  const { id } = req.params;
  const { saas_plan_id, start_date, amount, date, method, notes } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const gymResult = await client.query('SELECT * FROM Gyms WHERE id = $1 FOR UPDATE', [id]);
    if (gymResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const subResult = await client.query(
      'SELECT * FROM GymSubscriptions WHERE gym_id = $1',
      [id]
    );
    const currentSub = subResult.rows[0];
    const targetPlanId = saas_plan_id || currentSub?.saas_plan_id;
    if (!targetPlanId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Gym has no SaaS plan. Select a plan to renew.' });
    }

    const paidForCurrentTerm = await queryGymPaidForCurrentTerm(client, id);
    const targetStartDate = start_date || todayLocalString();
    const minStartDate = minimumRenewStartDate(currentSub, paidForCurrentTerm);
    if (targetStartDate < minStartDate) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `New license cannot start before ${minStartDate}. Current term is paid through ${calendarDateString(currentSub?.end_date)}.`,
      });
    }

    if (await queryHasPaidTermStartingOn(client, id, targetStartDate)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A payment is already recorded for this renewal term.',
      });
    }

    const planPriceResult = await client.query('SELECT price FROM SaaSPlans WHERE id = $1', [
      parseInt(targetPlanId, 10),
    ]);
    const amountCheck = validatePlanPaymentAmount(
      amount,
      planPriceResult.rows[0]?.price
    );
    if (!amountCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: amountCheck.error });
    }

    const paymentDateCheck = validatePaymentDate(date || todayLocalString(), null);
    if (!paymentDateCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    const subscription = await assignSaasPlanToGym(
      client,
      parseInt(id, 10),
      parseInt(targetPlanId, 10),
      targetStartDate
    );

    await client.query(
      `UPDATE Gyms SET subscription_status = 'active' WHERE id = $1`,
      [id]
    );

    const paymentResult = await client.query(
      `
      INSERT INTO SaaSPayments (gym_id, saas_plan_id, amount, date, coverage_start_date, method, notes, source)
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, COALESCE($6, 'Bank Transfer'), $7, $8)
      RETURNING *
      `,
      [
        id,
        parseInt(targetPlanId, 10),
        amount,
        date || null,
        targetStartDate,
        method || 'Bank Transfer',
        notes || null,
        PAYMENT_SOURCES.RENEW,
      ]
    );

    await client.query('COMMIT');
    res.json({
      gym: { ...gymResult.rows[0], subscription_status: 'active' },
      subscription: {
        plan_name: subscription.plan.name,
        start_date: subscription.start_date,
        end_date: subscription.end_date,
      },
      payment: paymentResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/gyms/:id/change-plan
 * Switch SaaS plan mid-term for an active, paid gym and record payment.
 */
router.post(
  '/gyms/:id/change-plan',
  validateParams(idParamSchema),
  validateBody(changeGymPlanSchema),
  async (req, res, next) => {
    const { id } = req.params;
    const { saas_plan_id, start_date, amount, date, method, notes } = req.body;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const gymResult = await client.query('SELECT * FROM Gyms WHERE id = $1 FOR UPDATE', [id]);
      if (gymResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Gym not found.' });
      }

      const gym = gymResult.rows[0];
      if (gym.subscription_status?.toLowerCase() !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            gym.subscription_status?.toLowerCase() === 'expired' ||
            gym.subscription_status?.toLowerCase() === 'suspended'
              ? 'Use Renew when the license is ending or has ended.'
              : 'Plan changes are only available for active gyms.',
        });
      }

      const paidForCurrentTerm = await queryGymPaidForCurrentTerm(client, id);

      const subResult = await client.query(
        'SELECT * FROM GymSubscriptions WHERE gym_id = $1',
        [id]
      );
      const currentSub = subResult.rows[0];
      const targetPlanId = parseInt(saas_plan_id, 10);

      if (currentSub && targetPlanId === currentSub.saas_plan_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Select a different plan. To extend the same plan, use Renew when the term ends.',
        });
      }

      const targetPlanResult = await client.query('SELECT price FROM SaaSPlans WHERE id = $1', [
        targetPlanId,
      ]);
      if (targetPlanResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'SaaS plan not found.' });
      }

      let currentPlanPrice = null;
      if (currentSub?.saas_plan_id) {
        const currentPlanResult = await client.query('SELECT price FROM SaaSPlans WHERE id = $1', [
          currentSub.saas_plan_id,
        ]);
        currentPlanPrice = currentPlanResult.rows[0]?.price;
      }

      const currentStartDate = calendarDateString(currentSub?.start_date);
      const targetStartDate = start_date || currentStartDate;
      if (targetStartDate > todayLocalString()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'New license term cannot start in the future.' });
      }

      const sameTermStart = targetStartDate === currentStartDate;
      const paymentAmount = parseFloat(amount);

      if (!sameTermStart && paymentAmount <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Enter the payment collected for this new license start date.',
        });
      }

      if (
        paidForCurrentTerm &&
        !sameTermStart &&
        (await queryHasPaidTermStartingOn(client, id, targetStartDate))
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            'A payment is already recorded for a license term starting on this date. Edit or remove it before changing plan again.',
        });
      }

      const targetPrice = Number(targetPlanResult.rows[0].price);
      const isDowngrade =
        currentPlanPrice != null && Number.isFinite(targetPrice) && targetPrice <= Number(currentPlanPrice);
      const preserveEndDate =
        isDowngrade &&
        sameTermStart &&
        paidForCurrentTerm &&
        currentSub?.end_date;

      const subscription = await assignSaasPlanToGym(
        client,
        parseInt(id, 10),
        targetPlanId,
        targetStartDate,
        preserveEndDate ? calendarDateString(currentSub.end_date) : undefined
      );

      await client.query(
        `UPDATE Gyms SET subscription_status = 'active' WHERE id = $1`,
        [id]
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
          (await queryPaymentExistsOnCalendarDate(client, id, paymentDate))
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `A payment is already recorded on ${calendarDateString(paymentDate)} for this license term. Remove or edit it first, or choose a different payment date.`,
          });
        }

        const amountCheck = validatePlanPaymentAmount(
          paymentAmount,
          targetPlanResult.rows[0].price
        );
        if (!amountCheck.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: amountCheck.error });
        }

        const paymentResult = await client.query(
          `
          INSERT INTO SaaSPayments (gym_id, saas_plan_id, amount, date, coverage_start_date, method, notes, source)
          VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, COALESCE($6, 'Bank Transfer'), $7, $8)
          RETURNING *
          `,
          [
            id,
            targetPlanId,
            paymentAmount,
            date || null,
            targetStartDate,
            method || 'Bank Transfer',
            notes || null,
            PAYMENT_SOURCES.CHANGE_PLAN,
          ]
        );
        payment = paymentResult.rows[0];
      }

      await client.query('COMMIT');
      res.json({
        gym: { ...gymResult.rows[0], subscription_status: 'active' },
        subscription: {
          plan_name: subscription.plan.name,
          start_date: subscription.start_date,
          end_date: subscription.end_date,
        },
        payment,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode === 404) {
        return res.status(404).json({ error: error.message });
      }
      next(error);
    } finally {
      client.release();
    }
  }
);

/**
 * DELETE /api/admin/gyms/:id
 * @description Deletes a gym (tenant) and recursively purges all linked records (users, members, payments) via cascade deletes.
 * Restricts access to platform Admins.
 * * @name delete-gym
 * @route {DELETE} /api/admin/gyms/:id
 * @header {String} Authorization - Bearer token.
 * @routeparam {Number} id - Gym database ID to purge.
 */
router.delete('/gyms/:id', validateParams(idParamSchema), async (req, res, next) => {
  const { id } = req.params;

  try {
    const result = await db.query('DELETE FROM Gyms WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gym not found.' });
    }
    res.json({ message: 'Gym and all associated tenant records successfully deleted.' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// REVENUE & SYSTEM ANALYTICS (FR-3, FR-4)
// ==========================================

/**
 * GET /api/admin/dashboard
 * @description Generates system-wide global SaaS metrics and revenue estimations (FR-3, FR-4).
 * Enforces case-insensitive status matching using SQL LOWER() functions.
 * Returns:
 * 1. Total registered gyms on the platform.
 * 2. Active gyms count.
 * 3. Expired/suspended gyms count.
 * 4. Sum of all active gym members across the entire platform.
 * 5. Average number of active members per gym.
 * 6. Estimated monthly recurring revenue (MRR) based on a flat $99/month licensing fee per active gym.
 * * Restricts access to platform Admins.
 * * @name get-platform-dashboard-metrics
 * @route {GET} /api/admin/dashboard
 * @header {String} Authorization - Bearer token.
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const [
      totalGymsRes,
      activeGymsRes,
      unpaidGymsRes,
      unpaidCatchUpRes,
      activeUsersRes,
      avgUsersRes,
      mrrRes,
      dueSoonRes,
      topGymsRes,
      saasIncomeThisMonthRes,
      saasIncomeLastMonthRes,
      newGymsThisMonthRes,
      newGymsLastMonthRes,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) FROM Gyms'),
      db.query("SELECT COUNT(*) FROM Gyms WHERE LOWER(subscription_status) = 'active'"),
      db.query("SELECT COUNT(*) FROM Gyms WHERE LOWER(subscription_status) IN ('expired', 'suspended')"),
      db.query(`
        SELECT COUNT(*)::int AS count FROM Gyms g
        WHERE ${GYM_UNPAID_SQL}
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM Members m
        WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})
      `),
      db.query(`
      SELECT COALESCE(AVG(member_count), 0) AS avg_members_per_gym FROM (
        SELECT COUNT(*) AS member_count 
        FROM Members m
        WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})
        GROUP BY m.gym_id
      ) AS sub;
    `),
      db.query(`
      SELECT COALESCE(SUM(sp.price / NULLIF(sp.duration, 0)), 0) AS mrr
      FROM Gyms g
      JOIN GymSubscriptions gs ON gs.gym_id = g.id
      JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
      WHERE LOWER(g.subscription_status) = 'active' AND LOWER(gs.status) = 'active'
    `),
      db.query(`
      SELECT COUNT(*)::int AS count
      FROM Gyms g
      JOIN GymSubscriptions gs ON gs.gym_id = g.id
      WHERE LOWER(g.subscription_status) = 'active'
        AND gs.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
    `),
      db.query(`
      SELECT g.name, COUNT(m.id) FILTER (
        WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
          AND NOT (${MEMBER_UNPAID_SQL})
      )::int AS active_members
      FROM Gyms g
      LEFT JOIN Members m ON m.gym_id = g.id
      GROUP BY g.id, g.name
      ORDER BY active_members DESC
      LIMIT 5
    `),
      db.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM SaaSPayments
        WHERE date_trunc('month', date) = date_trunc('month', CURRENT_DATE)
      `),
      db.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM SaaSPayments
        WHERE date_trunc('month', date) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM Gyms
        WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM Gyms
        WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
      `),
    ]);

    const activeGymsCount = parseInt(activeGymsRes.rows[0].count, 10);
    const totalGymsCount = parseInt(totalGymsRes.rows[0].count, 10);
    const estimatedMonthlyRevenue = parseFloat(mrrRes.rows[0].mrr);
    const saasIncomeThisMonth = parseFloat(saasIncomeThisMonthRes.rows[0].total);
    const saasIncomeLastMonth = parseFloat(saasIncomeLastMonthRes.rows[0].total);
    const newGymsThisMonth = newGymsThisMonthRes.rows[0].count;
    const newGymsLastMonth = newGymsLastMonthRes.rows[0].count;

    res.json({
      totalGyms: totalGymsCount,
      activeGyms: activeGymsCount,
      unpaidExpiredGyms: parseInt(unpaidGymsRes.rows[0].count, 10),
      unpaidCatchUpGyms: unpaidCatchUpRes.rows[0].count,
      dueSoonGyms: dueSoonRes.rows[0].count,
      platformActiveMembers: parseInt(activeUsersRes.rows[0].count, 10),
      averageMembersPerGym: parseFloat(avgUsersRes.rows[0].avg_members_per_gym).toFixed(1),
      estimatedMonthlyRevenue,
      saasIncomeThisMonth,
      saasIncomeLastMonth,
      saasRevenueTrendPercent: computePercentChange(saasIncomeThisMonth, saasIncomeLastMonth),
      newGymsThisMonth,
      newGymsLastMonth,
      newGymsTrendPercent: computePercentChange(newGymsThisMonth, newGymsLastMonth),
      newGymsDeltaLabel: computeCountDelta(newGymsThisMonth, newGymsLastMonth),
      topGymsByMembers: topGymsRes.rows.map((r) => ({
        name: r.name,
        members: r.active_members,
      })),
    });
  } catch (error) {
    next(error);
  }
});


// ==========================================
// PLATFORM SMS LOG (license reminders + OTP)
// ==========================================

const GYM_LICENSE_SMS_TYPES = [
  'gym_license_due_in_3_days',
  'gym_license_expires_today',
  'gym_license_expired',
];

const OTP_SMS_TYPES = [
  'otp_forgot_password',
  'otp_gym_signup',
];

const ADMIN_SMS_TYPES = [...GYM_LICENSE_SMS_TYPES, ...OTP_SMS_TYPES];

/**
 * GET /api/admin/gym-sms
 * Paginated platform SMS log: gym license reminders and OTP verification texts.
 * @queryparam {number} [page=1]
 * @queryparam {number} [limit=10]
 * @queryparam {string} [type] - gym_license_* | otp_* | all
 * @queryparam {number} [gym_id] - filter license reminders by gym (OTP rows excluded)
 */
router.get('/gym-sms', validateQuery(adminGymSmsQuerySchema), async (req, res, next) => {
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const typeFilter = String(req.query.type || 'all').toLowerCase();
  const gymId = req.query.gym_id;

  try {
    let allowedTypes = ADMIN_SMS_TYPES;
    if (typeFilter !== 'all' && ADMIN_SMS_TYPES.includes(typeFilter)) {
      allowedTypes = [typeFilter];
    }

    const conditions = ['s.message_type = ANY($1::text[])'];
    const params = [allowedTypes];

    if (gymId != null) {
      conditions.push(`(
        (s.entity_type = 'gym' AND s.entity_id = $${params.length + 1})
        OR (g_phone.id = $${params.length + 1})
      )`);
      params.push(gymId);
    }

    const whereClause = conditions.join(' AND ');

    const smsFromJoin = `
      FROM SmsLog s
      LEFT JOIN Gyms g ON s.entity_type = 'gym' AND g.id = s.entity_id
      LEFT JOIN LATERAL (
        SELECT id, name, owner_name, phone
        FROM Gyms g2
        WHERE s.entity_type = 'otp'
          AND (
            g2.phone = s.recipient_phone
            OR g2.phone = CONCAT('0', SUBSTRING(s.recipient_phone FROM 5))
          )
        ORDER BY g2.id DESC
        LIMIT 1
      ) g_phone ON TRUE
    `;

    const countResult = await db.query(
      `
      SELECT COUNT(*)::int AS count
      ${smsFromJoin}
      WHERE ${whereClause}
      `,
      params
    );
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const result = await db.query(
      `
      SELECT
        s.id,
        s.recipient_phone,
        s.message_type,
        s.entity_type,
        s.entity_id,
        s.message_id,
        s.otp_code,
        s.sent_at,
        COALESCE(g.id, g_phone.id) AS gym_id,
        COALESCE(g.name, g_phone.name) AS gym_name,
        COALESCE(g.owner_name, g_phone.owner_name) AS owner_name,
        COALESCE(g.phone, g_phone.phone) AS gym_phone
      ${smsFromJoin}
      WHERE ${whereClause}
      ORDER BY s.sent_at DESC, s.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    res.json(paginatedResponse(result.rows, total, page, limit));
  } catch (error) {
    next(error);
  }
});

// ==========================================
// PLATFORM-WIDE PAYMENTS (FR-5)
// ==========================================

/**
 * GET /api/admin/payments
 * @description Retrieves all SaaS payments made by gyms to the platform.
 * Joins gym name and SaaS plan name.
 * Restricted to Platform Admins only.
 */
router.get('/payments', validateQuery(adminPaymentListQuerySchema), async (req, res, next) => {
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const period = parsePeriodQuery(req.query);
  const paymentOrderBy = parseAdminPaymentSortOrder(req.query.sort);

  try {
    const { whereClause, params } = buildAdminSaaSPaymentWhere(req.query, period);

    const countResult = await db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM SaaSPayments p
      JOIN Gyms g ON g.id = p.gym_id
      WHERE ${whereClause}
      `,
      params
    );
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const limitIdx = listParams.length - 1;
    const offsetIdx = listParams.length;

    const result = await db.query(
      `
      SELECT
        p.id,
        p.amount,
        p.date,
        p.coverage_start_date,
        p.method,
        p.notes,
        p.source,
        g.name AS gym_name,
        g.id   AS gym_id,
        sp.name AS plan_name
      FROM SaaSPayments p
      JOIN Gyms g ON g.id = p.gym_id
      LEFT JOIN SaaSPlans sp ON sp.id = p.saas_plan_id
      WHERE ${whereClause}
      ORDER BY ${paymentOrderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      listParams
    );

    const summaryResult = await db.query(
      `
      SELECT p.amount, p.method
      FROM SaaSPayments p
      JOIN Gyms g ON g.id = p.gym_id
      WHERE ${whereClause}
      `,
      params
    );
    const summary = summarizePaymentRows(summaryResult.rows);

    res.json(paginatedResponse(result.rows, total, page, limit, { summary }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/payments
 * @description Records a new SaaS payment from a gym.
 */
router.post('/payments', validateBody(adminCreatePaymentSchema), async (req, res, next) => {
  const { gym_id, saas_plan_id, amount, date, method, notes } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const gymResult = await client.query('SELECT * FROM Gyms WHERE id = $1 FOR UPDATE', [gym_id]);
    if (gymResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gym not found.' });
    }

    const subResult = await client.query(
      `
      SELECT gs.start_date, gs.saas_plan_id, sp.price AS plan_price
      FROM GymSubscriptions gs
      LEFT JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
      WHERE gs.gym_id = $1
      `,
      [gym_id]
    );
    if (subResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gym has no active SaaS subscription.' });
    }

    const subscription = subResult.rows[0];
    const existingPayments = await client.query(
      'SELECT date, coverage_start_date FROM SaaSPayments WHERE gym_id = $1',
      [gym_id]
    );

    if (gymHasPaymentForCurrentTerm(subscription, existingPayments.rows)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This gym already has a payment for their current license term. Use Renew when starting a new term.',
      });
    }

    if (gymResult.rows[0].subscription_status?.toLowerCase() !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Collect payment is only for active gyms registered without paying. Expired gyms should renew.',
      });
    }

    const paymentDate = date || todayLocalString();
    const paymentDateCheck = validatePaymentDate(paymentDate, subscription.start_date);
    if (!paymentDateCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    let planPrice = subscription.plan_price;
    if (saas_plan_id) {
      const planRow = await client.query('SELECT price FROM SaaSPlans WHERE id = $1', [saas_plan_id]);
      if (planRow.rows.length > 0) planPrice = planRow.rows[0].price;
    }

    const amountCheck = validatePlanPaymentAmount(amount, planPrice);
    if (!amountCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: amountCheck.error });
    }

    const insertQuery = `
      INSERT INTO SaaSPayments (gym_id, saas_plan_id, amount, date, coverage_start_date, method, notes, source)
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5, COALESCE($6, 'Bank Transfer'), $7, $8)
      RETURNING *;
    `;
    const result = await client.query(insertQuery, [
      gym_id,
      saas_plan_id || subscription.saas_plan_id || null,
      amount,
      date || null,
      subscription.start_date,
      method || 'Bank Transfer',
      notes || null,
      PAYMENT_SOURCES.COLLECT,
    ]);

    const payment = result.rows[0];
    const gymName = gymResult.rows[0].name;

    await recordAuditLog({
      req,
      client,
      gymId: parseInt(gym_id, 10),
      action: ACTIONS.PAYMENT_RECORDED,
      entityType: 'saas_payment',
      entityId: payment.id,
      entityLabel: gymName,
      details: {
        gym_id: parseInt(gym_id, 10),
        amount: parseFloat(payment.amount),
        method: payment.method,
        date: payment.date,
        source: payment.source || PAYMENT_SOURCES.COLLECT,
      },
    });

    await client.query('COMMIT');
    res.status(201).json(payment);
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * PUT /api/admin/payments/:id
 * @description Correct a SaaS payment record (amount, date, method, notes).
 */
router.put('/payments/:id', validateParams(idParamSchema), validateBody(adminUpdatePaymentSchema), async (req, res, next) => {
  const { id } = req.params;
  const { amount, date, method, notes } = req.body;

  try {
    const existing = await db.query(
      `
      SELECT sp.*, gs.start_date AS term_start, spl.price AS plan_price, g.name AS gym_name
      FROM SaaSPayments sp
      JOIN GymSubscriptions gs ON gs.gym_id = sp.gym_id
      JOIN Gyms g ON g.id = sp.gym_id
      LEFT JOIN SaaSPlans spl ON spl.id = sp.saas_plan_id
      WHERE sp.id = $1
      `,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    const row = existing.rows[0];
    const paymentDateCheck = validatePaymentDate(
      date,
      row.coverage_start_date && row.source === PAYMENT_SOURCES.RENEW ? null : row.term_start
    );
    if (!paymentDateCheck.ok) {
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    const amountCheck = validatePlanPaymentAmount(amount, row.plan_price);
    if (!amountCheck.ok) {
      return res.status(400).json({ error: amountCheck.error });
    }

    const result = await db.query(
      `
      UPDATE SaaSPayments
      SET amount = $1, date = $2, method = $3, notes = $4
      WHERE id = $5
      RETURNING *
      `,
      [amount, date, method, notes ?? null, id]
    );

    const payment = result.rows[0];
    await recordAuditLog({
      req,
      gymId: row.gym_id,
      action: ACTIONS.PAYMENT_UPDATED,
      entityType: 'saas_payment',
      entityId: payment.id,
      entityLabel: row.gym_name,
      details: {
        gym_id: row.gym_id,
        amount: parseFloat(payment.amount),
        method: payment.method,
        date: payment.date,
        source: payment.source || PAYMENT_SOURCES.COLLECT,
      },
    });

    res.json(payment);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/payments/:id
 * @description Deletes a SaaS payment record.
 */
router.delete('/payments/:id', validateParams(idParamSchema), async (req, res, next) => {
  try {
    const existing = await db.query(
      `
      SELECT sp.*, g.name AS gym_name
      FROM SaaSPayments sp
      JOIN Gyms g ON g.id = sp.gym_id
      WHERE sp.id = $1
      `,
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    const row = existing.rows[0];
    await db.query('DELETE FROM SaaSPayments WHERE id = $1', [req.params.id]);

    await recordAuditLog({
      req,
      gymId: row.gym_id,
      action: ACTIONS.PAYMENT_DELETED,
      entityType: 'saas_payment',
      entityId: parseInt(req.params.id, 10),
      entityLabel: row.gym_name,
      details: {
        gym_id: row.gym_id,
        amount: parseFloat(row.amount),
        method: row.method,
        date: row.date,
        source: payment.source || PAYMENT_SOURCES.COLLECT,
      },
    });

    res.json({ message: 'Payment deleted.' });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// REPORTS (export data for PDF / CSV)
// ==========================================

const GYM_REPORT_BASE = `
  SELECT
    g.id,
    g.name,
    g.owner_name,
    g.phone,
    g.subscription_status,
    g.created_at,
    COUNT(m.id) FILTER (
      WHERE m.end_date > CURRENT_DATE + INTERVAL '${DUE_SOON_DAYS} days'
        AND NOT (${MEMBER_UNPAID_SQL})
    )::int AS active_member_count,
    COUNT(m.id)::int AS total_member_count,
    gs.plan AS saas_plan_name,
    sp.price AS saas_plan_price,
    sp.duration AS saas_plan_duration,
    gs.start_date AS saas_start_date,
    gs.end_date AS saas_end_date,
    (
      SELECT u.email FROM Users u
      WHERE u.gym_id = g.id AND u.role = $1
      LIMIT 1
    ) AS owner_email,
    ${GYM_IS_UNPAID_SELECT}
  FROM Gyms g
  LEFT JOIN Members m ON m.gym_id = g.id
  LEFT JOIN GymSubscriptions gs ON gs.gym_id = g.id
  LEFT JOIN SaaSPlans sp ON sp.id = gs.saas_plan_id
  GROUP BY g.id, gs.saas_plan_id, gs.plan, gs.start_date, gs.end_date, sp.price, sp.duration
`;

/**
 * GET /api/admin/reports/gyms
 * Full gym registry for admin exports (no pagination).
 */
router.get('/reports/gyms', async (req, res, next) => {
  try {
    const gymOrderBy = parseGymListSortOrder(req.query.sort || 'name_asc');
    const { whereExtra, params: filterParams } = buildGymListFilters(req.query, 2);
    const params = [ROLES.GYM_OWNER, ...filterParams];

    const result = await db.query(
      `
      SELECT * FROM (${GYM_REPORT_BASE}) g
      ${whereExtra}
      ORDER BY ${gymOrderBy}
      `,
      params
    );

    res.json({
      generatedAt: new Date().toISOString(),
      count: result.rows.length,
      gyms: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/reports/revenue
 * SaaS payment lines + summary for admin exports (no pagination).
 */
router.get('/reports/revenue', async (req, res, next) => {
  const period = parsePeriodQuery(req.query);
  const paymentOrderBy = parseAdminPaymentSortOrder(
    req.query.sort || DEFAULT_REPORT_ADMIN_REVENUE_SORT
  );

  try {
    const { whereClause, params } = buildAdminSaaSPaymentWhere(req.query, period);

    const result = await db.query(
      `
      SELECT
        p.id,
        p.amount,
        p.date,
        p.coverage_start_date,
        p.method,
        p.notes,
        p.source,
        g.name AS gym_name,
        g.id AS gym_id,
        g.owner_name,
        sp.name AS plan_name
      FROM SaaSPayments p
      JOIN Gyms g ON g.id = p.gym_id
      LEFT JOIN SaaSPlans sp ON sp.id = p.saas_plan_id
      WHERE ${whereClause}
      ORDER BY ${paymentOrderBy}
      `,
      params
    );

    const rows = result.rows;
    const summary = summarizePaymentRows(rows);

    res.json({
      generatedAt: new Date().toISOString(),
      period: {
        start: period.start || null,
        end: period.end || null,
        preset: req.query.preset || null,
      },
      summary,
      payments: rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;