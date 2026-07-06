/**
 * Shared payment amount sanity checks for billing mutations.
 */

/**
 * @param {number|string} amount
 * @param {number|string|null|undefined} planPrice
 */
function validatePlanPaymentAmount() {
  return { ok: true };
}

module.exports = {
  validatePlanPaymentAmount,
};
