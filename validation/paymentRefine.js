/**
 * Shared Zod superRefine helpers for payment date / amount rules.
 */

const { z } = require('zod');
const { validatePaymentDate: validateMemberPaymentDate } = require('../utils/memberPayments');
const { validatePaymentDate: validateSaasPaymentDate } = require('../utils/saasPayments');
const { todayLocalString } = require('../utils/localDate');

/**
 * @param {import('zod').RefinementCtx} ctx
 * @param {string} message
 * @param {string} path
 */
function addIssue(ctx, message, path) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path: [path],
  });
}

/**
 * @param {import('zod').RefinementCtx} ctx
 * @param {string|null|undefined} paymentDate
 * @param {string|null|undefined} termStart
 * @param {string} path
 * @param {'member'|'saas'} [kind]
 */
function refinePaymentDateAgainstTerm(ctx, paymentDate, termStart, path, kind = 'member') {
  if (!paymentDate) return;
  const validate = kind === 'saas' ? validateSaasPaymentDate : validateMemberPaymentDate;
  const check = validate(paymentDate, termStart);
  if (!check.ok) {
    addIssue(ctx, check.error, path);
  }
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 * @param {{ skipKey?: string }} [options]
 */
function refineRequiredPaymentAmount(data, ctx, { skipKey = 'skip_payment' } = {}) {
  if (data[skipKey]) return;
  if (data.amount == null || data.amount <= 0) {
    addIssue(ctx, 'A valid payment amount is required.', 'amount');
  }
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineEnrollMemberPayment(data, ctx) {
  refineRequiredPaymentAmount(data, ctx);
  if (data.skip_payment) return;
  const paymentDate = data.date || todayLocalString();
  refinePaymentDateAgainstTerm(ctx, paymentDate, data.start_date, 'date');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineRenewMemberPayment(data, ctx) {
  const termStart = data.start_date || todayLocalString();
  const paymentDate = data.date || todayLocalString();
  refinePaymentDateAgainstTerm(ctx, paymentDate, termStart, 'date');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineChangeMemberPlanPayment(data, ctx) {
  if (!data.date) return;
  if (data.start_date) {
    refinePaymentDateAgainstTerm(ctx, data.date, data.start_date, 'date');
    return;
  }
  refinePaymentDateAgainstTerm(ctx, data.date, null, 'date');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineAdminEnrollGymPayment(data, ctx) {
  refineRequiredPaymentAmount(data, ctx);
  if (data.skip_payment) return;
  const paymentDate = data.date || todayLocalString();
  const termStart = data.start_date || paymentDate;
  refinePaymentDateAgainstTerm(ctx, paymentDate, termStart, 'date', 'saas');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineRenewGymPayment(data, ctx) {
  const paymentDate = data.date || todayLocalString();
  refinePaymentDateAgainstTerm(ctx, paymentDate, null, 'date', 'saas');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 */
function refineChangeGymPlanPayment(data, ctx) {
  if (!data.date) return;
  if (data.start_date) {
    refinePaymentDateAgainstTerm(ctx, data.date, data.start_date, 'date', 'saas');
    return;
  }
  refinePaymentDateAgainstTerm(ctx, data.date, null, 'date', 'saas');
}

/**
 * @param {object} data
 * @param {import('zod').RefinementCtx} ctx
 * @param {string} [dateKey]
 */
function refinePaymentDateNotFuture(data, ctx, dateKey = 'date') {
  if (!data[dateKey]) return;
  refinePaymentDateAgainstTerm(ctx, data[dateKey], null, dateKey);
}

module.exports = {
  refineEnrollMemberPayment,
  refineRenewMemberPayment,
  refineChangeMemberPlanPayment,
  refineAdminEnrollGymPayment,
  refineRenewGymPayment,
  refineChangeGymPlanPayment,
  refinePaymentDateNotFuture,
};
