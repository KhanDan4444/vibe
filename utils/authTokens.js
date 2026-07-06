/**
 * @file authTokens.js
 * @description JWT payload helpers and password-change session invalidation.
 */

/** @param {{ password_changed_at?: Date | string | null }} user */
function passwordChangedStamp(user) {
  if (!user?.password_changed_at) return 0;
  return new Date(user.password_changed_at).getTime();
}

/** Build signed JWT claims from a database user row. */
function buildTokenPayload(user) {
  return {
    id: user.id,
    name: user.name ?? null,
    email: user.email,
    username: user.username ?? null,
    role: user.role,
    gym_id: user.gym_id,
    branch_id: user.branch_id ?? null,
    pwc: passwordChangedStamp(user),
  };
}

module.exports = { passwordChangedStamp, buildTokenPayload };
