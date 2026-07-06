/** Gym SaaS license states stored on `Gyms.subscription_status`. */
const GYM_SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  EXPIRED: 'expired',
};

function normalizeGymSubscriptionStatus(status) {
  return (status || '').trim().toLowerCase();
}

function isGymSubscriptionActive(status) {
  return normalizeGymSubscriptionStatus(status) === GYM_SUBSCRIPTION_STATUS.ACTIVE;
}

function isGymSubscriptionSuspended(status) {
  return normalizeGymSubscriptionStatus(status) === GYM_SUBSCRIPTION_STATUS.SUSPENDED;
}

function isGymSubscriptionExpired(status) {
  return normalizeGymSubscriptionStatus(status) === GYM_SUBSCRIPTION_STATUS.EXPIRED;
}

/** Suspended gyms may read data; expired gyms are fully locked out. */
function gymSubscriptionAllowsRead(status) {
  const normalized = normalizeGymSubscriptionStatus(status);
  return (
    normalized === GYM_SUBSCRIPTION_STATUS.ACTIVE ||
    normalized === GYM_SUBSCRIPTION_STATUS.SUSPENDED
  );
}

function describeGymSubscriptionAccess(status) {
  const normalized = normalizeGymSubscriptionStatus(status);
  return {
    status: normalized || GYM_SUBSCRIPTION_STATUS.ACTIVE,
    readOnly: normalized === GYM_SUBSCRIPTION_STATUS.SUSPENDED,
    accessDenied: normalized === GYM_SUBSCRIPTION_STATUS.EXPIRED,
  };
}

module.exports = {
  GYM_SUBSCRIPTION_STATUS,
  normalizeGymSubscriptionStatus,
  isGymSubscriptionActive,
  isGymSubscriptionSuspended,
  isGymSubscriptionExpired,
  gymSubscriptionAllowsRead,
  describeGymSubscriptionAccess,
};
