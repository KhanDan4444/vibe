/** Canonical payment source values stored on Payments.source and SaaSPayments.source */

const PAYMENT_SOURCES = {
  ENROLL: 'enroll',
  COLLECT: 'collect',
  RENEW: 'renew',
  CHANGE_PLAN: 'change_plan',
};

const PAYMENT_SOURCE_VALUES = Object.values(PAYMENT_SOURCES);

module.exports = {
  PAYMENT_SOURCES,
  PAYMENT_SOURCE_VALUES,
};
