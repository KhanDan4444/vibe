/**
 * @file phone.js
 * @description Ethiopian phone normalization for SMS (Afro Message expects +251…).
 */

/** @param {string|null|undefined} input */
function normalizeEthiopianPhone(input) {
  if (input == null || input === '') return null;

  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('251')) {
    // already country code
  } else if (digits.startsWith('0')) {
    digits = `251${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `251${digits}`;
  } else {
    return null;
  }

  if (digits.length !== 12) return null;
  return `+${digits}`;
}

function isValidEthiopianPhone(input) {
  return normalizeEthiopianPhone(input) != null;
}

module.exports = {
  normalizeEthiopianPhone,
  isValidEthiopianPhone,
};
