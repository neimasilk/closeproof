/**
 * CloseProof controls.
 *
 * Pure functions: given a reconciliation record (plus the prior period's
 * record for the same account and the result of re-hashing its evidence),
 * return the list of exceptions a controller would raise. Nothing here talks
 * to Jira or storage, which keeps the rules easy to test and explain.
 *
 * Control IDs (shown in the UI and used by the Rovo agent):
 *   C1 tie-out           GL - source - reconciling items must be exactly 0
 *   C2 roll-forward      opening balance = prior period's reviewed closing balance
 *   C3 segregation       preparer and reviewer must be different people, in order
 *   C4 evidence present  at least one supporting document
 *   C5 evidence intact   attachment still exists and its SHA-256 is unchanged
 *   C6 changed after sign-off
 *   C7 stale items       reconciling items older than N days at period end
 */
import { toBig, absBig, formatAmount } from './money.js';
import { canonicalJson, sha256Hex } from './hash.js';
import { periodEnd, daysBetween } from './period.js';

export const BLOCKER = 'blocker';
export const WARNING = 'warning';
export const INFO = 'info';

export const DEFAULT_CONFIG = Object.freeze({
  currency: 'USD',
  decimals: 2,
  materiality: '10000', // 100.00 in minor units
  staleDays: 60,
});

/** Only the accounting content of a record, used for sign-off hashes. */
export function contentOf(rec) {
  return {
    account: rec.account,
    name: rec.name,
    period: rec.period,
    issueKey: rec.issueKey ?? null,
    openingBalance: rec.openingBalance ?? '',
    glBalance: rec.glBalance ?? '0',
    sourceBalance: rec.sourceBalance ?? '0',
    items: (rec.items ?? []).map((i) => ({
      desc: i.desc,
      amount: i.amount,
      openedOn: i.openedOn ?? null,
    })),
    evidence: (rec.evidence ?? []).map((e) => ({
      attachmentId: String(e.attachmentId),
      filename: e.filename,
      sha256: e.sha256,
    })),
  };
}

export function contentHash(rec) {
  return sha256Hex(canonicalJson(contentOf(rec)));
}

/** GL - source - sum(reconciling items), as BigInt minor units. */
export function unexplainedDifference(rec) {
  const gl = toBig(rec.glBalance);
  const src = toBig(rec.sourceBalance);
  const items = (rec.items ?? []).reduce((acc, i) => acc + toBig(i.amount), 0n);
  return gl - src - items;
}

/** Sign-off state as stored, before any control is applied. */
export function statusOf(rec) {
  if (rec.reviewedBy) return 'reviewed';
  if (rec.preparedBy) return 'prepared';
  return 'draft';
}

/**
 * Evaluate one reconciliation.
 *
 * @param {object} rec the record
 * @param {object} ctx
 * @param {object} [ctx.prior] same account, previous period (or undefined)
 * @param {object} [ctx.config] project config (see DEFAULT_CONFIG)
 * @param {object} [ctx.evidenceStatus] attachmentId -> {missing:boolean, sha256:string};
 *        leave undefined when the attachments were not re-checked
 * @returns {{status:string, difference:string, unexplained:string, exceptions:Array}}
 */
export function evaluate(rec, ctx = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(ctx.config ?? {}) };
  const fmt = (v) => `${formatAmount(v, cfg.decimals)} ${cfg.currency}`;
  const exceptions = [];
  const add = (control, severity, message) => exceptions.push({ control, severity, message });

  // C1 tie-out
  const unexplained = unexplainedDifference(rec);
  if (unexplained !== 0n) {
    const material = absBig(unexplained) > toBig(cfg.materiality);
    add(
      'C1',
      material ? BLOCKER : WARNING,
      `Unexplained difference of ${fmt(unexplained)} (GL - source - reconciling items)` +
        (material ? ', above materiality' : ', below materiality'),
    );
  }

  // C2 roll-forward
  const prior = ctx.prior;
  if (!prior) {
    add('C2', INFO, 'No prior-period reconciliation on file for this account');
  } else {
    if (!prior.reviewedBy) {
      add('C2', WARNING, `Prior period ${prior.period} is not reviewed yet`);
    }
    if (rec.openingBalance !== undefined && rec.openingBalance !== '' && rec.openingBalance !== null) {
      const opening = toBig(rec.openingBalance);
      const priorClose = toBig(prior.glBalance);
      if (opening !== priorClose) {
        add(
          'C2',
          BLOCKER,
          `Opening balance ${fmt(opening)} does not roll forward from ${prior.period} closing ${fmt(priorClose)}`,
        );
      }
    }
  }

  // C3 segregation of duties
  if (rec.reviewedBy) {
    if (!rec.preparedBy) add('C3', BLOCKER, 'Reviewed without a preparer sign-off');
    else if (rec.reviewedBy === rec.preparedBy) add('C3', BLOCKER, 'The same person prepared and reviewed');
    else if (rec.preparedAt && rec.reviewedAt && rec.reviewedAt < rec.preparedAt) {
      add('C3', BLOCKER, 'Review is dated before preparation');
    }
  }

  // C4 evidence present
  const evidence = rec.evidence ?? [];
  if (evidence.length === 0) add('C4', BLOCKER, 'No supporting evidence attached');

  // C5 evidence intact (only when the caller re-hashed the attachments)
  if (ctx.evidenceStatus) {
    for (const e of evidence) {
      const s = ctx.evidenceStatus[String(e.attachmentId)];
      if (!s) continue;
      if (s.missing) add('C5', BLOCKER, `Evidence "${e.filename}" was deleted from the issue`);
      else if (s.replaced && s.sha256 !== e.sha256) {
        add('C5', BLOCKER, `Evidence "${e.filename}" was replaced by a different file after it was attached`);
      }
      else if (s.sha256 !== e.sha256) add('C5', BLOCKER, `Evidence "${e.filename}" changed after it was attached`);
    }
  }

  // C6 changed after sign-off
  const hash = contentHash(rec);
  if (rec.reviewedBy && rec.reviewedHash && rec.reviewedHash !== hash) {
    add('C6', BLOCKER, 'Changed after review; it needs to be reviewed again');
  } else if (rec.preparedBy && rec.preparedHash && rec.preparedHash !== hash) {
    add('C6', rec.reviewedBy ? BLOCKER : WARNING, 'Changed after preparation; it needs to be prepared again');
  }

  // C7 stale reconciling items, aged at period end
  if (rec.period) {
    const asOf = periodEnd(rec.period);
    for (const i of rec.items ?? []) {
      if (!i.openedOn) continue;
      const age = daysBetween(i.openedOn, asOf);
      if (age > cfg.staleDays) {
        add('C7', WARNING, `Reconciling item "${i.desc}" is ${age} days old (limit ${cfg.staleDays})`);
      }
    }
  }

  return {
    status: statusOf(rec),
    difference: (toBig(rec.glBalance) - toBig(rec.sourceBalance)).toString(),
    unexplained: unexplained.toString(),
    contentHash: hash,
    exceptions,
  };
}

const PREPARE_BLOCKING = new Set(['C1', 'C2', 'C4', 'C5']);

/** Can the current user sign as preparer? Returns {ok, reasons[]}. */
export function canPrepare(rec, evaluation) {
  const reasons = evaluation.exceptions
    .filter((x) => x.severity === BLOCKER && PREPARE_BLOCKING.has(x.control))
    .map((x) => `${x.control}: ${x.message}`);
  if (rec.reviewedBy) reasons.push('Already reviewed');
  return { ok: reasons.length === 0, reasons };
}

/** Can accountId sign as reviewer? Returns {ok, reasons[]}. */
export function canReview(rec, evaluation, accountId) {
  const reasons = [];
  if (!rec.preparedBy) reasons.push('Not prepared yet');
  if (rec.preparedBy && rec.preparedBy === accountId) {
    reasons.push('C3: You prepared this reconciliation, so someone else must review it');
  }
  if (rec.preparedHash && rec.preparedHash !== evaluation.contentHash) {
    reasons.push('C6: Changed after preparation; the preparer must sign again');
  }
  for (const x of evaluation.exceptions) {
    if (x.severity === BLOCKER && x.control !== 'C6' && x.control !== 'C3') {
      reasons.push(`${x.control}: ${x.message}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Roll-up for a whole period. evaluations is an array of evaluate() results. */
export function summarize(recs, evaluations) {
  const s = { total: recs.length, draft: 0, prepared: 0, reviewed: 0, clean: 0, blockers: 0, warnings: 0 };
  recs.forEach((rec, idx) => {
    const ev = evaluations[idx];
    s[ev.status] += 1;
    const b = ev.exceptions.filter((x) => x.severity === BLOCKER).length;
    const w = ev.exceptions.filter((x) => x.severity === WARNING).length;
    s.blockers += b;
    s.warnings += w;
    if (ev.status === 'reviewed' && b === 0 && w === 0) s.clean += 1;
  });
  s.readyToClose = s.total > 0 && s.clean === s.total;
  s.percentClean = s.total === 0 ? 0 : Math.round((100 * s.clean) / s.total);
  return s;
}

/**
 * Close certificate hash: one SHA-256 over every reviewed reconciliation in
 * the period (account, reviewed content hash, preparer, reviewer). Anyone can
 * recompute it from the stored records.
 */
export function certificateHash(period, recs) {
  const rows = recs
    .map((r) => ({
      account: r.account,
      reviewedHash: r.reviewedHash,
      preparedBy: r.preparedBy,
      reviewedBy: r.reviewedBy,
    }))
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return sha256Hex(canonicalJson({ period, reconciliations: rows }));
}
