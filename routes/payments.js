/**
 * @file routes/payments.js
 * @description Gym Payments & Transaction History Router.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const checkSubscription = require('../middleware/subscriptionCheck');
const requireActiveSubscription = require('../middleware/requireActiveSubscription');
const requireGymAccess = require('../middleware/requireGymAccess');
const requireGymOwner = require('../middleware/requireGymOwner');
const { memberHasPaymentForCurrentTerm, validatePaymentDate, calendarDateString } = require('../utils/memberPayments');
const { validatePlanPaymentAmount } = require('../utils/paymentValidation');
const { PAYMENT_SOURCES } = require('../utils/paymentSources');
const { todayLocalString } = require('../utils/localDate');
const { parsePaginationQuery, paginatedResponse } = require('../utils/pagination');
const { parsePeriodQuery, formatLocalDate, parseLocalDate } = require('../utils/paymentPeriodSql');
const { parseOwnerPaymentSortOrder } = require('../utils/listSortSql');
const { summarizePaymentRows } = require('../utils/paymentSummary');
const { buildOwnerPaymentWhere } = require('../utils/paymentQuerySql');
const { MEMBER_UNPAID_SQL } = require('../utils/memberListSql');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { ownerPaymentListQuerySchema } = require('../validation/querySchemas');
const {
  idParamSchema,
  createPaymentSchema,
  updatePaymentSchema,
} = require('../validation/schemas');
const { ACTIONS, recordAuditLog } = require('../utils/auditLog');
const { resolveBranchScope } = require('../utils/branchScope');
const { assertMemberBranchWritable } = require('../utils/branches');

router.use(auth, checkSubscription, requireGymAccess);

/** Branch filter for staff-scoped payment mutations (PUT/DELETE). */
async function resolvePaymentMutationScope(req) {
  const scope = await resolveBranchScope(req);
  if (scope.error) {
    return { error: scope.error };
  }
  return { scope, gymId: req.user.gym_id };
}

function computeTrendPercent(currentRows, previousRows) {
  const currentTotal = currentRows.reduce((s, p) => s + parseFloat(p.amount), 0);
  const previousTotal = previousRows.reduce((s, p) => s + parseFloat(p.amount), 0);
  if (previousTotal === 0) {
    return currentTotal > 0 ? '+100%' : null;
  }
  const change = ((currentTotal - previousTotal) / previousTotal) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

function previousPeriodRange(period) {
  if (!period.start || !period.end) return null;
  const start = parseLocalDate(period.start);
  const end = parseLocalDate(period.end);
  const spanMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - spanMs);
  return {
    start: formatLocalDate(prevStart),
    end: formatLocalDate(prevEnd),
  };
}

router.post('/', requireActiveSubscription, validateBody(createPaymentSchema), async (req, res, next) => {
  const { member_id, amount, date, method } = req.body;
  const gym_id = req.user.gym_id;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const scope = await resolveBranchScope(req);
    if (scope.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: scope.error });
    }

    let memberSql =
      'SELECT m.id, m.name, m.start_date, m.plan_id, p.price AS plan_price FROM Members m LEFT JOIN Plans p ON p.id = m.plan_id WHERE m.id = $1 AND m.gym_id = $2';
    const memberParams = [member_id, gym_id];
    if (scope.branchId) {
      memberSql += ' AND m.branch_id = $3';
      memberParams.push(scope.branchId);
    }
    memberSql += ' FOR UPDATE OF m';

    const memberCheck = await client.query(memberSql, memberParams);
    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found in this gym.' });
    }

    await assertMemberBranchWritable(member_id, gym_id, client);

    const member = memberCheck.rows[0];
    const existingPayments = await client.query(
      'SELECT date FROM Payments WHERE member_id = $1 AND gym_id = $2',
      [member_id, gym_id]
    );

    if (memberHasPaymentForCurrentTerm(member, existingPayments.rows)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:
          'This member already has a payment for their current membership term. Use Renew when starting a new term.',
      });
    }

    const paymentDate = date || todayLocalString();
    const paymentDateCheck = validatePaymentDate(paymentDate, member.start_date);
    if (!paymentDateCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    const amountCheck = validatePlanPaymentAmount(amount, member.plan_price);
    if (!amountCheck.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: amountCheck.error });
    }

    const insertQuery = `
      INSERT INTO Payments (member_id, gym_id, amount, date, method, source)
      VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), COALESCE($5, 'Cash'), $6)
      RETURNING *;
    `;
    const result = await client.query(insertQuery, [
      member_id,
      gym_id,
      amount,
      date || null,
      method || 'Cash',
      PAYMENT_SOURCES.COLLECT,
    ]);
    const payment = result.rows[0];

    await recordAuditLog({
      req,
      client,
      action: ACTIONS.PAYMENT_RECORDED,
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: member.name,
      details: {
        member_id,
        amount: parseFloat(payment.amount),
        method: payment.method,
        date: payment.date,
      },
    });

    await client.query('COMMIT');
    res.status(201).json(payment);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* transaction may not have started */
    }
    next(error);
  } finally {
    client.release();
  }
});

/**
 * GET /api/payments
 * @queryparam page, limit, search, method, preset, from, to
 */
router.get('/', validateQuery(ownerPaymentListQuerySchema), async (req, res, next) => {
  const gym_id = req.user.gym_id;
  const { page, limit, offset } = parsePaginationQuery(req.query);
  const period = parsePeriodQuery(req.query);
  const { search, method } = req.query;
  const paymentOrderBy = parseOwnerPaymentSortOrder(req.query.sort);

  try {
    const scope = await resolveBranchScope(req);
    if (scope.error) {
      return res.status(400).json({ error: scope.error });
    }

    const { whereClause, params } = buildOwnerPaymentWhere(
      req.query,
      period,
      gym_id,
      scope.branchId
    );

    const countResult = await db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
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
      SELECT p.*, m.name AS member_name, m.photo_url AS member_photo_url, b.name AS branch_name
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE ${whereClause}
      ORDER BY ${paymentOrderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      listParams
    );

    const summaryResult = await db.query(
      `
      SELECT p.amount, p.method
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
      WHERE ${whereClause}
      `,
      params
    );
    const summary = summarizePaymentRows(summaryResult.rows);

    let trendPercent = null;
    const prevRange = previousPeriodRange(period);
    if (prevRange) {
      const prevConditions = ['p.gym_id = $1'];
      const prevParams = [gym_id];
      let pIdx = 2;
      if (scope.branchId) {
        prevConditions.push(`m.branch_id = $${pIdx}`);
        prevParams.push(scope.branchId);
        pIdx += 1;
      }
      prevConditions.push(`p.date >= $${pIdx}`);
      prevParams.push(prevRange.start);
      pIdx += 1;
      prevConditions.push(`p.date <= $${pIdx}`);
      prevParams.push(prevRange.end);
      pIdx += 1;
      if (search && String(search).trim()) {
        prevConditions.push(`m.name ILIKE $${pIdx}`);
        prevParams.push(`%${String(search).trim()}%`);
        pIdx += 1;
      }
      if (method && method !== 'All') {
        prevConditions.push(`p.method = $${pIdx}`);
        prevParams.push(method);
      }
      const prevResult = await db.query(
        `
        SELECT p.amount FROM Payments p
        JOIN Members m ON m.id = p.member_id
        WHERE ${prevConditions.join(' AND ')}
        `,
        prevParams
      );
      trendPercent = computeTrendPercent(summaryResult.rows, prevResult.rows);
    }

    let unpaidMembers = [];
    if (period.start || period.end) {
      const unpaidConditions = [`m.gym_id = $1`, `(${MEMBER_UNPAID_SQL})`];
      const unpaidParams = [gym_id];
      let uIdx = 2;
      if (scope.branchId) {
        unpaidConditions.push(`m.branch_id = $${uIdx}`);
        unpaidParams.push(scope.branchId);
        uIdx += 1;
      }
      if (period.start) {
        unpaidConditions.push(`m.start_date >= $${uIdx}`);
        unpaidParams.push(period.start);
        uIdx += 1;
      }
      if (period.end) {
        unpaidConditions.push(`m.start_date <= $${uIdx}`);
        unpaidParams.push(period.end);
        uIdx += 1;
      }
      const unpaidResult = await db.query(
        `
        SELECT m.id, m.name, m.status, m.end_date
        FROM Members m
        WHERE ${unpaidConditions.join(' AND ')}
        ORDER BY m.name ASC
        LIMIT 50
        `,
        unpaidParams
      );
      unpaidMembers = unpaidResult.rows;
    }

    res.json(
      paginatedResponse(result.rows, total, page, limit, {
        summary,
        trendPercent,
        unpaidMembers,
      })
    );
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), validateBody(updatePaymentSchema), async (req, res, next) => {
  const { id } = req.params;
  const { amount, date, method } = req.body;

  try {
    const access = await resolvePaymentMutationScope(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }
    const { scope, gymId } = access;

    let branchSql = '';
    const findParams = [id, gymId];
    if (scope.branchId) {
      branchSql = ' AND m.branch_id = $3';
      findParams.push(scope.branchId);
    }

    const existing = await db.query(
      `
      SELECT p.id, p.member_id, m.start_date, m.name AS member_name, pl.price AS plan_price
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
      LEFT JOIN Plans pl ON pl.id = m.plan_id
      WHERE p.id = $1 AND p.gym_id = $2${branchSql}
      `,
      findParams
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found or unauthorized.' });
    }

    const paymentRow = existing.rows[0];
    await assertMemberBranchWritable(paymentRow.member_id, gymId);

    const paymentDateCheck = validatePaymentDate(date, paymentRow.start_date);
    if (!paymentDateCheck.ok) {
      return res.status(400).json({ error: paymentDateCheck.error });
    }

    const amountCheck = validatePlanPaymentAmount(amount, paymentRow.plan_price);
    if (!amountCheck.ok) {
      return res.status(400).json({ error: amountCheck.error });
    }

    const result = await db.query(
      `
      UPDATE Payments p
      SET amount = $1, date = $2, method = $3
      FROM Members m
      WHERE p.id = $4 AND p.gym_id = $5 AND m.id = p.member_id
      RETURNING p.*, m.name AS member_name;
      `,
      [amount, date, method, id, gymId]
    );

    const payment = result.rows[0];
    await recordAuditLog({
      req,
      action: ACTIONS.PAYMENT_UPDATED,
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: payment.member_name,
      details: {
        member_id: payment.member_id,
        amount: parseFloat(payment.amount),
        method: payment.method,
        date: payment.date,
      },
    });

    res.json(payment);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireGymOwner, requireActiveSubscription, validateParams(idParamSchema), async (req, res, next) => {
  const { id } = req.params;

  try {
    const access = await resolvePaymentMutationScope(req);
    if (access.error) {
      return res.status(400).json({ error: access.error });
    }
    const { scope, gymId } = access;

    let branchSql = '';
    const findParams = [id, gymId];
    if (scope.branchId) {
      branchSql = ' AND m.branch_id = $3';
      findParams.push(scope.branchId);
    }

    const existing = await db.query(
      `
      SELECT p.id, p.member_id, p.amount, p.method, p.date, m.name AS member_name
      FROM Payments p
      JOIN Members m ON m.id = p.member_id
      WHERE p.id = $1 AND p.gym_id = $2${branchSql}
      `,
      findParams
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found or unauthorized.' });
    }

    const paymentRow = existing.rows[0];
    await assertMemberBranchWritable(paymentRow.member_id, gymId);

    await db.query('DELETE FROM Payments WHERE id = $1 AND gym_id = $2', [id, gymId]);

    await recordAuditLog({
      req,
      action: ACTIONS.PAYMENT_DELETED,
      entityType: 'payment',
      entityId: parseInt(id, 10),
      entityLabel: paymentRow.member_name,
      details: {
        member_id: paymentRow.member_id,
        amount: parseFloat(paymentRow.amount),
        method: paymentRow.method,
        date: paymentRow.date,
      },
    });
    res.json({ message: 'Payment deleted successfully.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
