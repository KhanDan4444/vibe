/**
 * Signing key for member check-in QR tokens and station QR tokens.
 * Production must set MEMBER_PASS_SECRET. Dev may fall back to JWT_SECRET.
 */

function passSigningSecret() {
  const dedicated = String(process.env.MEMBER_PASS_SECRET || '').trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === 'production') return '';
  return String(process.env.JWT_SECRET || '').trim();
}

module.exports = { passSigningSecret };
