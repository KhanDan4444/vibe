/**
 * Canonical user roles (must match schema.sql seed values).
 */
const ROLES = {
  PLATFORM_ADMIN: 'Platform Admin',
  GYM_OWNER: 'Gym Owner',
};

/** Job roles for gym staff accounts (stored in Users.role). */
const STAFF_ROLES = Object.freeze(['Help Desk']);

const DEFAULT_STAFF_ROLE = 'Help Desk';

/** @param {string | undefined} role */
function isPlatformAdmin(role) {
  return role === ROLES.PLATFORM_ADMIN || role === 'Admin';
}

/** @param {string | undefined} role */
function isGymOwner(role) {
  return role === ROLES.GYM_OWNER;
}

/** @param {string | undefined} role */
function isGymStaff(role) {
  return STAFF_ROLES.includes(role) || role === 'Gym Staff';
}

/** Gym owner or staff — can use the gym portal. */
function hasGymPortalAccess(role) {
  return isGymOwner(role) || isGymStaff(role);
}

module.exports = {
  ROLES,
  STAFF_ROLES,
  DEFAULT_STAFF_ROLE,
  isPlatformAdmin,
  isGymOwner,
  isGymStaff,
  hasGymPortalAccess,
};
