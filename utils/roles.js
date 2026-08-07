/**
 * Canonical user roles (must match schema.sql seed values).
 */
const ROLES = {
  PLATFORM_ADMIN: 'Platform Admin',
  GYM_OWNER: 'Gym Owner',
};

/** Creatable job roles for gym staff accounts (stored in Users.role). */
const STAFF_ROLES = Object.freeze(['Front Desk']);

const DEFAULT_STAFF_ROLE = 'Front Desk';

/** Legacy role strings still treated as gym staff (SQL + auth). */
const LEGACY_STAFF_ROLES = Object.freeze(['Help Desk', 'Gym Staff']);

/** All role values that identify gym staff — use in SQL ANY() filters. */
const ALL_STAFF_ROLES = Object.freeze([...STAFF_ROLES, ...LEGACY_STAFF_ROLES]);

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
  return ALL_STAFF_ROLES.includes(role);
}

/** Gym owner or staff — can use the gym portal. */
function hasGymPortalAccess(role) {
  return isGymOwner(role) || isGymStaff(role);
}

/** Map legacy staff roles to the current canonical name. */
function normalizeStaffRole(role) {
  if (!role || LEGACY_STAFF_ROLES.includes(role)) return DEFAULT_STAFF_ROLE;
  if (STAFF_ROLES.includes(role)) return role;
  return DEFAULT_STAFF_ROLE;
}

module.exports = {
  ROLES,
  STAFF_ROLES,
  DEFAULT_STAFF_ROLE,
  LEGACY_STAFF_ROLES,
  ALL_STAFF_ROLES,
  isPlatformAdmin,
  isGymOwner,
  isGymStaff,
  hasGymPortalAccess,
  normalizeStaffRole,
};
