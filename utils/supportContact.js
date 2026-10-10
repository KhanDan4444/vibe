/**
 * @file supportContact.js
 * @description Platform support contact for gym owners (env-configured).
 */

const { normalizeEthiopianPhone } = require('./phone');

/**
 * Format E.164 +2519XXXXXXXX → +251 9XX XXX XXX for display.
 * @param {string} e164
 */
function formatSupportPhoneDisplay(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('251')) {
    const n = digits.slice(3);
    return `+251 ${n.slice(0, 1)}${n.slice(1, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return e164;
}

/**
 * @returns {{
 *   phone: string|null,
 *   phone_display: string|null,
 *   telegram: string|null,
 *   telegram_url: string|null,
 *   configured: boolean
 * }}
 */
function getSupportContact() {
  const phone = normalizeEthiopianPhone(process.env.SUPPORT_PHONE || '');
  const rawTg = String(process.env.SUPPORT_TELEGRAM || '')
    .trim()
    .replace(/^@/, '');
  const telegram = /^[A-Za-z0-9_]{5,32}$/.test(rawTg) ? rawTg : null;

  return {
    phone,
    phone_display: phone ? formatSupportPhoneDisplay(phone) : null,
    telegram,
    telegram_url: telegram ? `https://t.me/${telegram}` : null,
    configured: Boolean(phone || telegram),
  };
}

module.exports = {
  getSupportContact,
  formatSupportPhoneDisplay,
};
