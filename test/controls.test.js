import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount } from '../src/lib/money.js';
import { previousPeriod, periodEnd, daysBetween } from '../src/lib/period.js';
import { canonicalJson } from '../src/lib/hash.js';
import {
  evaluate,
  canPrepare,
  canReview,
  contentHash,
  summarize,
  certificateHash,
  BLOCKER,
  WARNING,
  INFO,
} from '../src/lib/controls.js';

test('parseAmount handles accounting formats exactly', () => {
  assert.equal(parseAmount('1,234.56'), 123456n);
  assert.equal(parseAmount('(45.00)'), -4500n);
  assert.equal(parseAmount('-0.1'), -10n);
  assert.equal(parseAmount('12'), 1200n);
  assert.equal(parseAmount('12', 0), 12n);
  assert.throws(() => parseAmount('1.234'));
  assert.throws(() => parseAmount('1,23.00'));
  assert.throws(() => parseAmount('abc'));
});

test('formatAmount round-trips', () => {
  assert.equal(formatAmount(123456n), '1,234.56');
  assert.equal(formatAmount('-5'), '-0.05');
  assert.equal(formatAmount(0n), '0.00');
  assert.equal(formatAmount(1234567n, 0), '1,234,567');
});

test('period helpers', () => {
  assert.equal(previousPeriod('2026-01'), '2025-12');
  assert.equal(previousPeriod('2026-11'), '2026-10');
  assert.equal(periodEnd('2028-02'), '2028-02-29');
  assert.equal(periodEnd('2026-11'), '2026-11-30');
  assert.equal(daysBetween('2026-09-01', '2026-11-30'), 90);
});

test('canonicalJson ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

const base = () => ({
  account: '1010',
  name: 'Operating bank account',
  period: '2026-11',
  glBalance: '1250000',
  sourceBalance: '1230000',
  items: [{ desc: 'Deposit in transit', amount: '20000', openedOn: '2026-11-29' }],
  evidence: [{ attachmentId: '10001', filename: 'bank-nov.pdf', sha256: 'aa' }],
});
const prior = { account: '1010', period: '2026-10', glBalance: '900000', reviewedBy: 'u2' };

const controls = (ev, sev) => ev.exceptions.filter((x) => !sev || x.severity === sev).map((x) => x.control);

test('a clean reconciliation ties out', () => {
  const ev = evaluate({ ...base(), openingBalance: '900000' }, { prior });
  assert.equal(ev.unexplained, '0');
  assert.deepEqual(controls(ev, BLOCKER), []);
  assert.deepEqual(controls(ev, WARNING), []);
});

test('C1 unexplained difference, material vs immaterial', () => {
  const small = evaluate({ ...base(), sourceBalance: '1229999' }, { prior });
  assert.equal(small.unexplained, '1');
  assert.deepEqual(controls(small, WARNING), ['C1']);
  const big = evaluate({ ...base(), sourceBalance: '1000000' }, { prior });
  assert.deepEqual(controls(big, BLOCKER), ['C1']);
});

test('C2 roll-forward', () => {
  const none = evaluate(base(), {});
  assert.deepEqual(controls(none, INFO), ['C2']);
  const broken = evaluate({ ...base(), openingBalance: '899999' }, { prior });
  assert.deepEqual(controls(broken, BLOCKER), ['C2']);
  const unreviewed = evaluate(base(), { prior: { ...prior, reviewedBy: undefined } });
  assert.deepEqual(controls(unreviewed, WARNING), ['C2']);
});

test('C3 segregation of duties', () => {
  const same = evaluate({ ...base(), preparedBy: 'u1', reviewedBy: 'u1' }, { prior });
  assert.ok(controls(same, BLOCKER).includes('C3'));
  const order = evaluate(
    { ...base(), preparedBy: 'u1', preparedAt: '2026-12-02T10:00:00Z', reviewedBy: 'u2', reviewedAt: '2026-12-01T10:00:00Z' },
    { prior },
  );
  assert.ok(controls(order, BLOCKER).includes('C3'));
});

test('C4 and C5 evidence', () => {
  const noEvidence = evaluate({ ...base(), evidence: [] }, { prior });
  assert.deepEqual(controls(noEvidence, BLOCKER), ['C4']);
  const changed = evaluate(base(), { prior, evidenceStatus: { 10001: { missing: false, sha256: 'bb' } } });
  assert.deepEqual(controls(changed, BLOCKER), ['C5']);
  const deleted = evaluate(base(), { prior, evidenceStatus: { 10001: { missing: true } } });
  assert.deepEqual(controls(deleted, BLOCKER), ['C5']);
  const intact = evaluate(base(), { prior, evidenceStatus: { 10001: { missing: false, sha256: 'aa' } } });
  assert.deepEqual(controls(intact, BLOCKER), []);
});

test('C6 changed after sign-off', () => {
  const rec = base();
  const h = contentHash(rec);
  const prepared = { ...rec, preparedBy: 'u1', preparedHash: h };
  assert.deepEqual(controls(evaluate(prepared, { prior })), []);
  const edited = { ...prepared, glBalance: '1250001' };
  assert.ok(controls(evaluate(edited, { prior }), WARNING).includes('C6'));
  const reviewed = { ...prepared, reviewedBy: 'u2', reviewedHash: h };
  const editedAfterReview = { ...reviewed, sourceBalance: '1230001', items: [{ desc: 'x', amount: '19999' }] };
  assert.ok(controls(evaluate(editedAfterReview, { prior }), BLOCKER).includes('C6'));
});

test('C7 stale items are aged at period end', () => {
  const rec = { ...base(), items: [{ desc: 'Old check', amount: '20000', openedOn: '2026-08-15' }] };
  const ev = evaluate(rec, { prior });
  assert.deepEqual(controls(ev, WARNING), ['C7']);
});

test('canPrepare and canReview gates', () => {
  const rec = base();
  const ev = evaluate(rec, { prior });
  assert.equal(canPrepare(rec, ev).ok, true);
  const noEv = { ...rec, evidence: [] };
  assert.equal(canPrepare(noEv, evaluate(noEv, { prior })).ok, false);

  const prepared = { ...rec, preparedBy: 'u1', preparedHash: contentHash(rec) };
  const pev = evaluate(prepared, { prior });
  assert.equal(canReview(prepared, pev, 'u1').ok, false, 'preparer cannot review');
  assert.equal(canReview(prepared, pev, 'u2').ok, true);
  assert.equal(canReview(rec, ev, 'u2').ok, false, 'must be prepared first');
});

test('summary and certificate', () => {
  const content = { ...base(), openingBalance: '900000' };
  const h = contentHash(content);
  const done = { ...content, preparedBy: 'u1', preparedHash: h, reviewedBy: 'u2', reviewedHash: h };
  const open = { ...base(), account: '1200', evidence: [] };
  const recs = [done, open];
  const evs = recs.map((r) => evaluate(r, { prior: r.account === '1010' ? prior : undefined }));
  const s = summarize(recs, evs);
  assert.equal(s.total, 2);
  assert.equal(s.clean, 1);
  assert.equal(s.readyToClose, false);
  const c1 = certificateHash('2026-11', [done]);
  const c2 = certificateHash('2026-11', [{ ...done }]);
  assert.equal(c1, c2);
  assert.notEqual(c1, certificateHash('2026-11', [{ ...done, reviewedBy: 'u3' }]));
});
