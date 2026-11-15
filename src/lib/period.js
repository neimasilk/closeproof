/**
 * Close periods are calendar months written as "YYYY-MM".
 */

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(p) {
  return typeof p === 'string' && PERIOD_RE.test(p);
}

export function assertPeriod(p) {
  if (!isPeriod(p)) throw new Error(`"${p}" is not a period (expected YYYY-MM)`);
  return p;
}

/** "2026-01" -> "2025-12" */
export function previousPeriod(p) {
  assertPeriod(p);
  let [y, m] = p.split('-').map(Number);
  m -= 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Last calendar day of the period as "YYYY-MM-DD" (UTC). */
export function periodEnd(p) {
  assertPeriod(p);
  const [y, m] = p.split('-').map(Number);
  // Day 0 of the next month is the last day of this month.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** Whole days from dateA to dateB (both "YYYY-MM-DD"), can be negative. */
export function daysBetween(dateA, dateB) {
  const a = Date.parse(dateA + 'T00:00:00Z');
  const b = Date.parse(dateB + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('Invalid date');
  return Math.round((b - a) / 86400000);
}

/** Period that contains the given ISO date, for example "2026-11-15" -> "2026-11". */
export function periodOf(isoDate) {
  return String(isoDate).slice(0, 7);
}
