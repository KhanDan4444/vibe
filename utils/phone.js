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

/**
 * Parse admin SMS log phone filter: full numbers match E.164 exactly;
 * partial digit strings (4+) match as substring on recipient_phone.
 * @param {string|null|undefined} input
 * @returns {{ match: 'exact', value: string } | { match: 'partial', digits: string } | null}
 */
function parseSmsPhoneFilter(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;

  const normalized = normalizeEthiopianPhone(trimmed);
  if (normalized) return { match: 'exact', value: normalized };

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 4) return { match: 'partial', digits };

  return null;
}

module.exports = {
  normalizeEthiopianPhone,
  isValidEthiopianPhone,
  parseSmsPhoneFilter,
};
