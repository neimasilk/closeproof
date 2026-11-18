/**
 * Resolvers called from the UI Kit frontends with invoke().
 *
 * Every resolver:
 *   1. takes the project / issue from the Forge context (never from the client),
 *   2. checks the user's Jira permissions,
 *   3. returns { ok: true, data } or { ok: false, error } so the UI can show
 *      the real message instead of a generic failure.
 */
import Resolver from '@forge/resolver';
import * as service from '../service.js';
import * as store from '../store.js';
import { requireProjectAccess, listAttachments } from '../jira.js';
import { seedDemo, resetPeriod, DEMO_PEOPLE } from '../demo.js';
import { previousPeriod, assertPeriod } from '../lib/period.js';
import { parseAmount } from '../lib/money.js';
import { parseBalances } from '../lib/csv.js';
import { logError } from '../lib/log.js';

const resolver = new Resolver();

function safe(fn) {
  return async (req) => {
    try {
      return { ok: true, data: await fn(req) };
    } catch (e) {
      logError('resolver', e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  };
}

const projectOf = (req) => store.assertProjectKey(req.context?.extension?.project?.key);
const issueOf = (req) => store.assertIssueKey(req.context?.extension?.issue?.key);
const me = (req) => req.context.accountId;

/** Default period: the latest one with data, else last calendar month. */
async function defaultPeriod(projectKey) {
  const periods = await store.listPeriods(projectKey);
  return periods.length ? periods[periods.length - 1] : previousPeriod(service.currentPeriod());
}

// ---------------------------------------------------------------- dashboard

resolver.define(
  'getDashboard',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey);
    const period = req.payload?.period ? assertPeriod(req.payload.period) : await defaultPeriod(projectKey);
    const data = await service.loadPeriod(projectKey, period, { verifyEvidence: Boolean(req.payload?.verify) });
    return { ...data, me: me(req), demoPeople: DEMO_PEOPLE, suggestedDemoPeriod: previousPeriod(service.currentPeriod()) };
  }),
);

resolver.define(
  'loadDemo',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    const period = req.payload?.period ? assertPeriod(req.payload.period) : previousPeriod(service.currentPeriod());
    return seedDemo(projectKey, period, me(req), { replace: Boolean(req.payload?.replace) });
  }),
);

resolver.define(
  'resetPeriod',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    return resetPeriod(projectKey, assertPeriod(req.payload?.period));
  }),
);

resolver.define(
  'issueCertificate',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    return service.issueCertificate(projectKey, assertPeriod(req.payload?.period), me(req));
  }),
);

resolver.define(
  'saveConfig',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    const current = await store.getConfig(projectKey);
    const next = { ...current };
    if (req.payload?.currency) {
      const currency = String(req.payload.currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code such as USD or EUR');
      next.currency = currency;
    }
    if (req.payload?.materiality !== undefined) {
      const materiality = parseAmount(String(req.payload.materiality), next.decimals);
      if (materiality < 0n) throw new Error('Materiality cannot be negative');
      next.materiality = materiality.toString();
    }
    if (req.payload?.staleDays !== undefined) next.staleDays = Math.max(1, Math.min(365, parseInt(req.payload.staleDays, 10) || 60));
    await store.setConfig(projectKey, next);
    return next;
  }),
);

resolver.define(
  'importBalances',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    const period = assertPeriod(req.payload?.period);
    const text = String(req.payload?.text ?? '');
    if (text.length > 100000) throw new Error('The pasted table is too large; import at most 50 accounts at a time');
    const cfg = await store.getConfig(projectKey);
    const parsed = parseBalances(text, cfg.decimals);
    const done = parsed.rows.length
      ? await service.importBalances(projectKey, period, parsed.rows, me(req))
      : { created: [], updated: [], errors: [] };
    const errors = [...parsed.errors, ...done.errors].sort((a, b) => a.line - b.line);
    return { period, created: done.created, updated: done.updated, errors };
  }),
);

// ---------------------------------------------------------------- issue panel

/** Reconciliation linked to this issue (if any), plus the issue's attachments. */
async function issueState(req) {
  const issueKey = issueOf(req);
  const issue = await listAttachments(issueKey);
  const linked = await store.getRecByIssue(issueKey);
  const loaded = linked ? await service.loadRec(linked.projectKey, linked.period, linked.account) : null;
  return {
    issueKey,
    projectKey: issue.projectKey,
    summary: issue.summary,
    attachments: issue.attachments,
    me: me(req),
    demoPeople: DEMO_PEOPLE,
    suggestedPeriod: previousPeriod(service.currentPeriod()),
    ...(loaded ?? { rec: null }),
  };
}

/** Resolve the reconciliation for the current issue or fail. */
async function linkedRec(req, write = false) {
  const issueKey = issueOf(req);
  const rec = await store.getRecByIssue(issueKey);
  if (!rec) throw new Error(`${issueKey} is not linked to a reconciliation yet`);
  await requireProjectAccess(rec.projectKey, { write });
  return rec;
}

resolver.define(
  'getIssueRec',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey);
    return issueState(req);
  }),
);

resolver.define(
  'saveIssueRec',
  safe(async (req) => {
    const projectKey = projectOf(req);
    await requireProjectAccess(projectKey, { write: true });
    const issueKey = issueOf(req);
    const input = req.payload?.input ?? {};
    const linked = await store.getRecByIssue(issueKey);
    // Period and account are fixed once the reconciliation exists.
    const period = linked ? linked.period : assertPeriod(input.period);
    const account = linked ? linked.account : store.assertAccount(input.account);
    if (!linked) {
      const clash = await store.getRec(projectKey, period, account);
      if (clash) throw new Error(`Account ${account} already has a reconciliation for ${period} (${clash.issueKey ?? 'no issue'})`);
    }
    await service.saveRec(projectKey, period, { ...input, account, issueKey }, me(req));
    return issueState(req);
  }),
);

const signOff = (op) =>
  safe(async (req) => {
    const rec = await linkedRec(req, true);
    await op(rec, req);
    return issueState(req);
  });

resolver.define(
  'attachEvidence',
  signOff((rec, req) => service.attachEvidence(rec.projectKey, rec.period, rec.account, req.payload?.attachmentId, me(req))),
);
resolver.define(
  'removeEvidence',
  signOff((rec, req) => service.removeEvidence(rec.projectKey, rec.period, rec.account, req.payload?.attachmentId, me(req))),
);
resolver.define('prepare', signOff((rec, req) => service.prepare(rec.projectKey, rec.period, rec.account, me(req))));
resolver.define('review', signOff((rec, req) => service.review(rec.projectKey, rec.period, rec.account, me(req))));
resolver.define('reopen', signOff((rec, req) => service.reopen(rec.projectKey, rec.period, rec.account, me(req))));

export const handler = resolver.getDefinitions();
