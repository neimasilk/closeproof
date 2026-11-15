/**
 * Money helpers.
 *
 * Accounting amounts are kept as BigInt "minor units" (for example cents) so
 * that a tie-out is exact. Floating point numbers are never used: 0.1 + 0.2 is
 * not 0.3 in JavaScript, and a reconciliation that is "off by 0.0000001" is
 * still off.
 *
 * Amounts are stored in Forge storage as decimal strings of the minor-unit
 * integer (for example "123456" for 1,234.56) because JSON has no BigInt.
 */

export const DEFAULT_DECIMALS = 2;

/**
 * Parse a human-entered amount into BigInt minor units.
 * Accepts "1234.5", "1,234.50", "-12", "(45.00)" (accounting negative) and
 * surrounding spaces. Rejects anything with more decimals than allowed.
 *
 * @param {string|number|bigint} input
 * @param {number} decimals number of minor-unit digits (2 for USD/EUR, 0 for JPY/IDR)
 * @returns {bigint}
 */
export function parseAmount(input, decimals = DEFAULT_DECIMALS) {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Amount is not a finite number');
    input = String(input);
  }
  if (typeof input !== 'string') throw new Error('Amount must be text');

  let s = input.trim();
  let negative = false;
  // Accounting style: (1,234.00) means -1,234.00
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // Digits with optional thousands commas, optional fraction.
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`"${input}" is not a valid amount`);

  const whole = m[1].replace(/,/g, '');
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`"${input}" has more than ${decimals} decimal places`);
  }
  const minor = BigInt(whole + frac.padEnd(decimals, '0'));
  return negative ? -minor : minor;
}

/**
 * Format BigInt minor units for display, for example 123456n -> "1,234.56".
 * @param {bigint|string} minor
 * @param {number} decimals
 */
export function formatAmount(minor, decimals = DEFAULT_DECIMALS) {
  const v = toBig(minor);
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const frac = decimals > 0 ? digits.slice(-decimals) : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + grouped + (decimals > 0 ? '.' + frac : '');
}

/** Convert a stored minor-unit string (or BigInt) into BigInt. Empty means 0. */
export function toBig(value) {
  if (typeof value === 'bigint') return value;
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Stored amount "${value}" is not a minor-unit integer`);
}

/** Absolute value for BigInt. */
export function absBig(v) {
  return v < 0n ? -v : v;
}
