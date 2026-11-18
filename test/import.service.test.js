// Service-level test for the balance import, with Forge storage and Jira mocked.
// Run with: node --experimental-test-module-mocks --test test/import.service.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalances } from '../src/lib/csv.js';

const db = new Map();
const created = [];
let typeLookups = 0;

mock.module(new URL('../src/store.js', import.meta.url).href, {
  namedExports: {
    getRec: async (p, period, account) => structuredClone(db.get(`${p}:${period}:${account}`)),
    putRec: async (rec) => db.set(`${rec.projectKey}:${rec.period}:${rec.account}`, structuredClone(rec)),
    getConfig: async () => ({ currency: 'USD', decimals: 2, materiality: '10000', staleDays: 60 }),
  },
});
mock.module(new URL('../src/jira.js', import.meta.url).href, {
  namedExports: {
    pickIssueType: async () => {
      typeLookups += 1;
      return '10001';
    },
    createIssue: async (projectKey, summary, description, issueTypeId) => {
      assert.equal(issueTypeId, '10001');
      const key = `${projectKey}-${100 + created.length}`;
      created.push({ key, summary });
      return key;
    },
  },
});

const service = await import('../src/service.js');

test('import creates issues for new accounts and updates existing ones, keeping sign-offs', async () => {
  db.set('FIN:2026-10:1010', {
    projectKey: 'FIN', period: '2026-10', account: '1010', name: 'Operating bank', issueKey: 'FIN-1',
    glBalance: '100', sourceBalance: '100', items: [], evidence: [], history: [],
    reviewedBy: 'acc-2', preparedBy: 'acc-1',
  });
  const { rows, errors } = parseBalances(
    ['account\tname\tgl_balance\tsource_balance', '1010\t\t2.00\t', '1200\tReceivables\t3,127.50\t3,082.50', '2000\tPayables\t(10.00)\t', '2100\tAccruals\t5\t5', '2200\tTax\t1\t1', '2300\tOther\t1\t1', '2400\tMore\t1\t1'].join('\n'),
  );
  assert.deepEqual(errors, []);
  const r = await service.importBalances('FIN', '2026-10', rows, 'acc-9');

  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.updated, [{ account: '1010', issueKey: 'FIN-1' }]);
  assert.equal(r.created.length, 6);
  assert.equal(typeLookups, 1, 'issue type looked up once for the whole import');
  assert.match(created.find((c) => c.summary.includes('1200')).summary, /^Reconcile 1200 Receivables \(2026-10\)$/);

  const bank = db.get('FIN:2026-10:1010');
  assert.equal(bank.glBalance, '200');
  assert.equal(bank.sourceBalance, '100', 'empty source column leaves the stored value');
  assert.equal(bank.name, 'Operating bank', 'empty name keeps the stored name');
  assert.equal(bank.reviewedBy, 'acc-2', 'sign-off kept, so C6 will flag the change');
  assert.equal(bank.history.at(-1).detail, 'balance import');

  const ar = db.get('FIN:2026-10:1200');
  assert.equal(ar.glBalance, '312750');
  assert.equal(ar.sourceBalance, '308250');
  assert.ok(ar.issueKey.startsWith('FIN-'));
  assert.equal(db.get('FIN:2026-10:2000').glBalance, '-1000');
  assert.equal(db.get('FIN:2026-10:2000').sourceBalance, undefined);
});
