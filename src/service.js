/**
 * CloseProof business operations. Resolvers (UI) and Rovo actions both call
 * these functions, so the same rules apply whichever surface is used.
 */
import * as store from './store.js';
import * as jira from './jira.js';
import {
  evaluate,
  canPrepare,
  canReview,
  summarize,
  certificateHash,
  BLOCKER,
  WARNING,
} from './lib/controls.js';
import { parseAmount, formatAmount } from './lib/money.js';
import { previousPeriod, assertPeriod, periodOf } from './lib/period.js';

const HISTORY_LIMIT = 50;
const now = () => new Date().toISOString();

function addHistory(rec, by, action, detail) {
  rec.history = [...(rec.history ?? []), { at: now(), by, action, detail }].slice(-HISTORY_LIMIT);
}

/** Current calendar period in UTC, e.g. "2026-11". */
export function currentPeriod() {
  return periodOf(now());
}

/**
 * Re-download every evidence file of a reconciliation and hash it again.
 * If an attachment is gone but a file with the same name is on the issue,
 * report it as "replaced" (someone swapped the statement).
 */
export async function checkEvidence(rec) {
  const status = {};
  let issueFiles;
  for (const e of rec.evidence ?? []) {
    // Evidence archived from an earlier close is not a live attachment.
    if (e.archived) continue;
    const h = await jira.hashAttachment(e.attachmentId);
    if (h.missing && rec.issueKey) {
      issueFiles = issueFiles ?? (await jira.listAttachments(rec.issueKey)).attachments;
      const same = issueFiles.find((a) => a.filename === e.filename);
      if (same) {
        const h2 = await jira.hashAttachment(same.id);
        status[String(e.attachmentId)] = { missing: false, replaced: true, sha256: h2.sha256 };
        continue;
      }
    }
    status[String(e.attachmentId)] = h;
  }
  return status;
}

/** Display-ready copy of a record plus its evaluation. */
function view(rec, ev, cfg) {
  const f = (v) => (v === undefined || v === null || v === '' ? '' : formatAmount(v, cfg.decimals));
  return {
    ...rec,
    display: {
      openingBalance: f(rec.openingBalance),
      glBalance: f(rec.glBalance),
      sourceBalance: f(rec.sourceBalance),
      difference: f(ev.difference),
      unexplained: f(ev.unexplained),
      items: (rec.items ?? []).map((i) => ({ ...i, amount: f(i.amount) })),
    },
    evaluation: ev,
  };
}

/**
 * Everything the close dashboard needs for one period.
 * verifyEvidence=true re-hashes all evidence files (slower, used before sign-offs
 * and for the "Verify evidence" button).
 */
export async function loadPeriod(projectKey, period, { verifyEvidence = false } = {}) {
  assertPeriod(period);
  const [cfg, recs, priorRecs, cert, periods] = await Promise.all([
    store.getConfig(projectKey),
    store.listRecs(projectKey, period),
    store.listRecs(projectKey, previousPeriod(period)),
    store.getCertificate(projectKey, period),
    store.listPeriods(projectKey),
  ]);
  const priorByAccount = new Map(priorRecs.map((r) => [r.account, r]));

  const evaluations = [];
  for (const rec of recs) {
    const evidenceStatus = verifyEvidence ? await checkEvidence(rec) : undefined;
    evaluations.push(evaluate(rec, { prior: priorByAccount.get(rec.account), config: cfg, evidenceStatus }));
  }
  const summary = summarize(recs, evaluations);

  let certificate = cert ?? null;
  if (certificate) {
    const current = certificateHash(period, recs.filter((r) => r.reviewedBy));
    certificate = { ...certificate, stillValid: current === certificate.hash && summary.readyToClose };
  }

  return {
    projectKey,
    period,
    periods: periods.includes(period) ? periods : [...periods, period].sort(),
    config: cfg,
    evidenceVerified: verifyEvidence,
    summary,
    certificate,
    rows: recs.map((r, i) => view(r, evaluations[i], cfg)),
  };
}

/** One reconciliation with its evaluation (evidence re-hashed). */
export async function loadRec(projectKey, period, account, { verifyEvidence = true } = {}) {
  const [cfg, rec, prior] = await Promise.all([
    store.getConfig(projectKey),
    store.getRec(projectKey, period, account),
    store.getRec(projectKey, previousPeriod(period), account),
  ]);
  if (!rec) return null;
  const evidenceStatus = verifyEvidence ? await checkEvidence(rec) : undefined;
  const ev = evaluate(rec, { prior, config: cfg, evidenceStatus });
  return { rec: view(rec, ev, cfg), prior: prior ?? null, config: cfg, evidenceStatus: evidenceStatus ?? null };
}

/**
 * Create or update a reconciliation. Amounts arrive as typed by the user
 * ("1,234.56") and are stored as minor-unit integers. Sign-offs are kept:
 * if the content changed, control C6 flags it until someone signs again.
 */
export async function saveRec(projectKey, period, input, accountId) {
  const cfg = await store.getConfig(projectKey);
  const account = store.assertAccount(input.account);
  const existing = await store.getRec(projectKey, period, account);
  const amt = (v) => (v === undefined || v === null || String(v).trim() === '' ? '' : parseAmount(String(v), cfg.decimals).toString());

  const rec = existing ?? { projectKey, period, account, evidence: [], history: [] };
  rec.name = String(input.name ?? rec.name ?? '').slice(0, 120);
  if (input.issueKey !== undefined) rec.issueKey = input.issueKey ? store.assertIssueKey(input.issueKey) : undefined;
  if (input.openingBalance !== undefined) rec.openingBalance = amt(input.openingBalance);
  if (input.glBalance !== undefined) rec.glBalance = amt(input.glBalance) || '0';
  if (input.sourceBalance !== undefined) rec.sourceBalance = amt(input.sourceBalance) || '0';
  if (input.items !== undefined) {
    rec.items = (input.items ?? [])
      .filter((i) => String(i.desc ?? '').trim() || String(i.amount ?? '').trim())
      .map((i) => ({
        desc: String(i.desc ?? '').slice(0, 200),
        amount: amt(i.amount) || '0',
        openedOn: /^\d{4}-\d{2}-\d{2}$/.test(i.openedOn ?? '') ? i.openedOn : null,
      }));
  }
  addHistory(rec, accountId, existing ? 'edited' : 'created');
  await store.putRec(rec);
  return loadRec(projectKey, period, account, { verifyEvidence: false });
}

export async function attachEvidence(projectKey, period, account, attachmentId, accountId) {
  const rec = await store.getRec(projectKey, period, account);
  if (!rec) throw new Error('Reconciliation not found');
  if (!rec.issueKey) throw new Error('Link the reconciliation to a Jira issue first');
  const { attachments } = await jira.listAttachments(rec.issueKey);
  const a = attachments.find((x) => x.id === String(attachmentId));
  if (!a) throw new Error(`Attachment ${attachmentId} is not on ${rec.issueKey}`);
  if ((rec.evidence ?? []).some((e) => e.attachmentId === a.id)) throw new Error(`${a.filename} is already evidence`);
  const h = await jira.hashAttachment(a.id);
  if (h.missing) throw new Error(`${a.filename} could not be downloaded`);
  rec.evidence = [
    ...(rec.evidence ?? []),
    { attachmentId: a.id, filename: a.filename, sha256: h.sha256, size: h.size, addedBy: accountId, addedAt: now() },
  ];
  addHistory(rec, accountId, 'evidence added', `${a.filename} sha256 ${h.sha256.slice(0, 12)}…`);
  await store.putRec(rec);
  return loadRec(projectKey, period, account);
}

export async function removeEvidence(projectKey, period, account, attachmentId, accountId) {
  const rec = await store.getRec(projectKey, period, account);
  if (!rec) throw new Error('Reconciliation not found');
  const e = (rec.evidence ?? []).find((x) => x.attachmentId === String(attachmentId));
  if (!e) throw new Error('Evidence not found');
  rec.evidence = rec.evidence.filter((x) => x !== e);
  addHistory(rec, accountId, 'evidence removed', e.filename);
  await store.putRec(rec);
  return loadRec(projectKey, period, account);
}

export async function prepare(projectKey, period, account, accountId) {
  const loaded = await loadRec(projectKey, period, account);
  if (!loaded) throw new Error('Reconciliation not found');
  const rec = await store.getRec(projectKey, period, account);
  const gate = canPrepare(rec, loaded.rec.evaluation);
  if (!gate.ok) throw new Error(`Cannot sign as preparer:\n- ${gate.reasons.join('\n- ')}`);
  Object.assign(rec, {
    preparedBy: accountId,
    preparedAt: now(),
    preparedHash: loaded.rec.evaluation.contentHash,
    reviewedBy: undefined,
    reviewedAt: undefined,
    reviewedHash: undefined,
  });
  addHistory(rec, accountId, 'prepared', `content ${rec.preparedHash.slice(0, 12)}…`);
  await store.putRec(rec);
  return loadRec(projectKey, period, account);
}

export async function review(projectKey, period, account, accountId) {
  const loaded = await loadRec(projectKey, period, account);
  if (!loaded) throw new Error('Reconciliation not found');
  const rec = await store.getRec(projectKey, period, account);
  const gate = canReview(rec, loaded.rec.evaluation, accountId);
  if (!gate.ok) throw new Error(`Cannot sign as reviewer:\n- ${gate.reasons.join('\n- ')}`);
  Object.assign(rec, { reviewedBy: accountId, reviewedAt: now(), reviewedHash: loaded.rec.evaluation.contentHash });
  addHistory(rec, accountId, 'reviewed', `content ${rec.reviewedHash.slice(0, 12)}…`);
  await store.putRec(rec);
  return loadRec(projectKey, period, account);
}

/** Withdraw sign-offs so the reconciliation can be reworked. */
export async function reopen(projectKey, period, account, accountId) {
  const rec = await store.getRec(projectKey, period, account);
  if (!rec) throw new Error('Reconciliation not found');
  for (const k of ['preparedBy', 'preparedAt', 'preparedHash', 'reviewedBy', 'reviewedAt', 'reviewedHash']) delete rec[k];
  addHistory(rec, accountId, 'reopened');
  await store.putRec(rec);
  return loadRec(projectKey, period, account);
}

/** Issue the close certificate when every reconciliation is reviewed and clean. */
export async function issueCertificate(projectKey, period, accountId) {
  const data = await loadPeriod(projectKey, period, { verifyEvidence: true });
  if (!data.summary.readyToClose) {
    const open = data.rows
      .filter((r) => r.evaluation.status !== 'reviewed' || r.evaluation.exceptions.some((x) => x.severity !== 'info'))
      .map((r) => r.account);
    throw new Error(`Not ready to close. Open reconciliations: ${open.join(', ') || 'none recorded'}`);
  }
  const recs = data.rows.map(({ display, evaluation, ...rec }) => rec);
  const cert = {
    period,
    hash: certificateHash(period, recs),
    count: recs.length,
    issuedBy: accountId,
    issuedAt: now(),
  };
  await store.putCertificate(projectKey, period, cert);
  return loadPeriod(projectKey, period);
}

/** Plain facts about open items, used by the Rovo agent and MCP tools. */
export function exceptionsOf(data, { includeInfo = false } = {}) {
  const out = [];
  for (const r of data.rows) {
    for (const x of r.evaluation.exceptions) {
      if (!includeInfo && x.severity === 'info') continue;
      out.push({ account: r.account, name: r.name, issueKey: r.issueKey ?? null, ...x });
    }
  }
  const rank = { [BLOCKER]: 0, [WARNING]: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.account.localeCompare(b.account));
}

