/**
 * "Load demo close": seeds a realistic month-end close so judges and new
 * users can see every control fire without typing data.
 *
 * It creates one Jira issue per account reconciliation in the chosen project,
 * attaches a small CSV "statement" to each, and stores two periods:
 *   - the prior month, fully reviewed (gives the roll-forward check a baseline)
 *   - the current month, with one planted problem per control.
 *
 * The demo preparer and reviewer are fictional people ("demo:" ids), so the
 * signed-in user can act as a second reviewer and see segregation of duties.
 */
import * as store from './store.js';
import * as jira from './jira.js';
import { contentHash } from './lib/controls.js';
import { previousPeriod, periodEnd } from './lib/period.js';
import { sha256Hex } from './lib/hash.js';

export const DEMO_PEOPLE = {
  'demo:priya': 'Priya Shah (Senior Accountant)',
  'demo:marco': 'Marco Rossi (Controller)',
};

/** Date N days before the end of a period, "YYYY-MM-DD". */
function daysBeforeEnd(period, n) {
  const d = new Date(periodEnd(period) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function statementCsv(title, period, rows) {
  return [`# ${title}`, `# Period ${period}`, 'date,description,amount', ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

/** Accounts in the demo. Amounts are minor units (cents) as strings. */
function scenario(period) {
  const prior = previousPeriod(period);
  return [
    {
      account: '1010', name: 'Operating bank account', priorGl: '18450000',
      gl: '21236540', source: '20876540', opening: '18450000',
      items: [{ desc: 'Deposit in transit (customer wire)', amount: '360000', openedOn: daysBeforeEnd(period, 1) }],
      sign: 'reviewed', story: 'Clean: ties out, rolls forward, evidence intact, two different signers.',
    },
    {
      account: '1020', name: 'Payroll bank account', priorGl: '4200000',
      gl: '3980037', source: '3980000', opening: '4200000', items: [],
      sign: 'prepared', story: 'Prepared, waiting for your review. Unexplained 0.37 below materiality (C1 warning).',
    },
    {
      account: '1030', name: 'Savings account', priorGl: '50000000',
      gl: '50061250', source: '50186250', opening: '50000000',
      items: [{ desc: 'Uncleared check #4471 to supplier', amount: '-125000', openedOn: daysBeforeEnd(period, 96) }],
      sign: 'prepared', story: 'Ties out, but a reconciling item is 96 days old (C7).',
    },
    {
      account: '1200', name: 'Accounts receivable', priorGl: '31275000',
      gl: '33410000', source: '32960000', opening: '31275000', items: [],
      sign: 'none', story: 'Sub-ledger is 4,500.00 short of the GL with no explanation (C1 blocker).',
    },
    {
      account: '1500', name: 'Prepaid expenses', priorGl: '2400000',
      gl: '2200000', source: '2200000', opening: '2400000', items: [],
      sign: 'reviewed', replaceEvidence: true,
      story: 'Reviewed, then the supporting schedule was swapped for a different file (C5).',
    },
    {
      account: '2000', name: 'Accounts payable', priorGl: '-19870000',
      gl: '-20512000', source: '-20512000', opening: '-19745000', items: [],
      sign: 'none', story: 'Opening balance does not roll forward from last month (C2): off by 1,250.00.',
    },
    {
      account: '2100', name: 'Accrued expenses', priorGl: '-6100000',
      gl: '-6455000', source: '-6455000', opening: '-6100000', items: [],
      sign: 'self-reviewed', story: 'Prepared and reviewed by the same person (C3).',
    },
    {
      account: '2200', name: 'Sales tax payable', priorGl: '-1830000',
      gl: '-1915500', source: '-1915500', opening: '-1830000', items: [],
      sign: 'none', noEvidence: true, story: 'No supporting evidence attached (C4).',
    },
  ].map((a) => ({ ...a, prior }));
}

/**
 * Seed the demo. Refuses to overwrite a period that already has data unless
 * replace=true (which only clears CloseProof records, never Jira issues).
 */
export async function seedDemo(projectKey, period, accountId, { replace = false } = {}) {
  const existing = await store.listRecs(projectKey, period);
  if (existing.length && !replace) {
    throw new Error(`Period ${period} already has ${existing.length} reconciliations. Use "Reset demo" first.`);
  }
  for (const r of existing) await store.deleteRec(r);
  await store.deleteCertificate(projectKey, period);

  const accounts = scenario(period);
  const prior = previousPeriod(period);
  // Timestamps: the prior month was signed 3 days after its month end; the
  // current month's sign-offs happened a few hours ago.
  const priorBase = Date.parse(periodEnd(prior) + 'T09:00:00Z') + 3 * 86400000;
  const nowBase = Date.now() - 6 * 3600000;
  const priorStamp = (min) => new Date(priorBase + min * 60000).toISOString();
  const stamp = (min) => new Date(nowBase + min * 60000).toISOString();

  // Prior period: every account reviewed by Priya (preparer) and Marco (reviewer).
  for (const a of accounts) {
    const rec = {
      projectKey, period: prior, account: a.account, name: a.name,
      glBalance: a.priorGl, sourceBalance: a.priorGl, openingBalance: '', items: [],
      // Archived evidence from last month's close (not a live Jira attachment).
      evidence: [{ attachmentId: `archived-${a.account}-${prior}`, filename: `${a.account}-${prior}-statement.pdf`, sha256: sha256Hex(`${a.account}${prior}`), archived: true }],
      history: [{ at: priorStamp(0), by: 'demo:priya', action: 'created', detail: 'demo data' }],
    };
    const h = contentHash(rec);
    Object.assign(rec, {
      preparedBy: 'demo:priya', preparedAt: priorStamp(60), preparedHash: h,
      reviewedBy: 'demo:marco', reviewedAt: priorStamp(240), reviewedHash: h,
    });
    await store.putRec(rec);
  }

  // Current period: one Jira issue per account, a CSV statement attached.
  const created = [];
  for (const a of accounts) {
    const issueKey = await jira.createIssue(
      projectKey,
      `Reconcile ${a.account} ${a.name} for ${period}`,
      `Month-end reconciliation for ${a.name} (${a.account}), period ${period}. Demo scenario: ${a.story}`,
    );
    const csv = statementCsv(`${a.name} statement`, period, [
      [periodEnd(period), 'Closing balance per source', (Number(a.source) / 100).toFixed(2)],
    ]);
    const evidence = [];
    if (!a.noEvidence) {
      const file = `${a.account}-${period}-statement.csv`;
      const up = await jira.uploadAttachment(issueKey, file, csv);
      evidence.push({ attachmentId: up.id, filename: up.filename, sha256: sha256Hex(Buffer.from(csv)), size: Buffer.byteLength(csv), addedBy: 'demo:priya', addedAt: stamp(5) });
    }
    const rec = {
      projectKey, period, account: a.account, name: a.name, issueKey,
      openingBalance: a.opening, glBalance: a.gl, sourceBalance: a.source,
      items: a.items, evidence, demoStory: a.story,
      history: [{ at: stamp(0), by: 'demo:priya', action: 'created', detail: 'demo data' }],
    };
    const h = contentHash(rec);
    if (a.sign === 'prepared' || a.sign === 'reviewed' || a.sign === 'self-reviewed') {
      Object.assign(rec, { preparedBy: 'demo:priya', preparedAt: stamp(60), preparedHash: h });
      rec.history.push({ at: stamp(60), by: 'demo:priya', action: 'prepared' });
    }
    if (a.sign === 'reviewed') {
      Object.assign(rec, { reviewedBy: 'demo:marco', reviewedAt: stamp(180), reviewedHash: h });
      rec.history.push({ at: stamp(180), by: 'demo:marco', action: 'reviewed' });
    }
    if (a.sign === 'self-reviewed') {
      Object.assign(rec, { reviewedBy: 'demo:priya', reviewedAt: stamp(90), reviewedHash: h });
      rec.history.push({ at: stamp(90), by: 'demo:priya', action: 'reviewed' });
    }
    await store.putRec(rec);

    // Swap the statement after review: delete it and upload a different file
    // with the same name. Control C5 will catch this on the next evidence check.
    if (a.replaceEvidence && evidence.length) {
      await jira.deleteAttachment(evidence[0].attachmentId);
      const altered = csv.replace(/,(\d+\.\d\d)$/m, (m, v) => `,${(Number(v) + 1500).toFixed(2)}`);
      await jira.uploadAttachment(issueKey, evidence[0].filename, altered);
    }
    created.push({ account: a.account, issueKey });
  }
  return { period, prior, created, by: accountId };
}

/** Clear CloseProof data for a period (Jira issues are left untouched). */
export async function resetPeriod(projectKey, period) {
  const recs = await store.listRecs(projectKey, period);
  for (const r of recs) await store.deleteRec(r);
  await store.deleteCertificate(projectKey, period);
  return { removed: recs.length };
}
