/**
 * Rovo actions (also exposed as MCP tools through the rovo:mcp module).
 *
 * Each action returns plain, compact facts computed by the same control
 * engine as the UI. The agent narrates; it never decides whether a
 * reconciliation passes. Permissions: every action checks the caller's Jira
 * project permission with asUser() before reading anything.
 */
import * as service from './service.js';
import * as store from './store.js';
import { requireProjectAccess } from './jira.js';
import { DEMO_PEOPLE } from './demo.js';
import { previousPeriod, isPeriod } from './lib/period.js';

/** Inputs can come from the action inputs or from where Rovo was opened. */
function projectFrom(payload) {
  const fromInput = String(payload?.projectKey ?? '').trim().toUpperCase();
  const fromContext = payload?.context?.jira?.projectKey;
  const fromIssue = String(payload?.issueKey ?? payload?.context?.jira?.issueKey ?? '').split('-')[0];
  const key = fromInput || fromContext || fromIssue;
  if (!key) throw new Error('Tell me which Jira project holds the close (for example FIN).');
  return store.assertProjectKey(key);
}

async function periodFrom(payload, projectKey) {
  const p = String(payload?.period ?? '').trim();
  if (p) {
    if (!isPeriod(p)) throw new Error(`"${p}" is not a period. Use YYYY-MM, for example 2026-10.`);
    return p;
  }
  const periods = await store.listPeriods(projectKey);
  return periods.length ? periods[periods.length - 1] : previousPeriod(service.currentPeriod());
}

const who = (id) => (!id ? null : String(id).startsWith('demo:') ? DEMO_PEOPLE[id] ?? id : `accountId:${id}`);

/** Wrap an action so errors come back as a readable message for the agent. */
function action(fn) {
  return async (payload) => {
    try {
      return await fn(payload ?? {});
    } catch (e) {
      console.error(e);
      return { error: e?.message ?? String(e) };
    }
  };
}

function rowFacts(r) {
  return {
    account: r.account,
    name: r.name,
    issueKey: r.issueKey ?? null,
    status: r.evaluation.status,
    unexplained: r.display.unexplained,
    preparedBy: who(r.preparedBy),
    reviewedBy: who(r.reviewedBy),
    exceptions: r.evaluation.exceptions
      .filter((x) => x.severity !== 'info')
      .map((x) => `${x.control} ${x.severity}: ${x.message}`),
  };
}

export const getCloseStatus = action(async (payload) => {
  const projectKey = projectFrom(payload);
  await requireProjectAccess(projectKey);
  const period = await periodFrom(payload, projectKey);
  const data = await service.loadPeriod(projectKey, period);
  return {
    projectKey,
    period,
    currency: data.config.currency,
    summary: data.summary,
    certificate: data.certificate
      ? { hash: data.certificate.hash, issuedAt: data.certificate.issuedAt, stillValid: data.certificate.stillValid }
      : null,
    reconciliations: data.rows.map(rowFacts),
    note: 'Evidence files were not re-downloaded for this status. Use list-close-exceptions with verifyEvidence=true to check them.',
  };
});

export const listCloseExceptions = action(async (payload) => {
  const projectKey = projectFrom(payload);
  await requireProjectAccess(projectKey);
  const period = await periodFrom(payload, projectKey);
  const verify = payload.verifyEvidence === true || payload.verifyEvidence === 'true';
  const data = await service.loadPeriod(projectKey, period, { verifyEvidence: verify });
  return {
    projectKey,
    period,
    evidenceVerified: verify,
    readyToClose: data.summary.readyToClose,
    exceptions: service.exceptionsOf(data),
  };
});

export const explainReconciliation = action(async (payload) => {
  let rec;
  const issueKey = String(payload.issueKey ?? payload?.context?.jira?.issueKey ?? '').trim().toUpperCase();
  if (issueKey) {
    // Check access to the issue's project before saying anything about it,
    // so the answer never reveals data from a project the user cannot browse.
    await requireProjectAccess(store.assertProjectKey(issueKey.split('-')[0]));
    rec = await store.getRecByIssue(store.assertIssueKey(issueKey));
    if (!rec) return { error: `${issueKey} is not linked to a CloseProof reconciliation.` };
  } else {
    const projectKey = projectFrom(payload);
    await requireProjectAccess(projectKey);
    const period = await periodFrom(payload, projectKey);
    if (!payload.account) return { error: 'Give an issue key, or a project, period and account code.' };
    rec = await store.getRec(projectKey, period, String(payload.account));
    if (!rec) return { error: `No reconciliation for account ${payload.account} in ${projectKey} ${period}.` };
  }
  await requireProjectAccess(rec.projectKey);
  const loaded = await service.loadRec(rec.projectKey, rec.period, rec.account, { verifyEvidence: true });
  const r = loaded.rec;
  return {
    ...rowFacts(r),
    period: r.period,
    projectKey: r.projectKey,
    balances: {
      opening: r.display.openingBalance || null,
      gl: r.display.glBalance,
      source: r.display.sourceBalance,
      reconcilingItems: r.display.items,
      unexplained: r.display.unexplained,
    },
    priorPeriod: loaded.prior
      ? { period: loaded.prior.period, closingGl: loaded.prior.glBalance, reviewed: Boolean(loaded.prior.reviewedBy) }
      : null,
    evidence: (r.evidence ?? []).map((e) => ({ file: e.filename, sha256: e.sha256, archived: Boolean(e.archived) })),
    evidenceCheck: loaded.evidenceStatus,
    history: (r.history ?? []).slice(-10).map((h) => `${h.at} ${who(h.by)} ${h.action}${h.detail ? ': ' + h.detail : ''}`),
    demoScenario: r.demoStory ?? null,
  };
});

export const draftCloseMemo = action(async (payload) => {
  const projectKey = projectFrom(payload);
  await requireProjectAccess(projectKey);
  const period = await periodFrom(payload, projectKey);
  const data = await service.loadPeriod(projectKey, period, { verifyEvidence: true });
  const exceptions = service.exceptionsOf(data);
  return {
    instructions:
      'Write a short month-end close memo for the controller: overall status, what is blocking the close, ' +
      'who must act on which account, and what is clean. Quote control IDs (C1-C7). Do not invent numbers.',
    projectKey,
    period,
    currency: data.config.currency,
    summary: data.summary,
    certificate: data.certificate ?? null,
    blockers: exceptions.filter((x) => x.severity === 'blocker'),
    warnings: exceptions.filter((x) => x.severity === 'warning'),
    clean: data.rows
      .filter((r) => r.evaluation.status === 'reviewed' && !r.evaluation.exceptions.some((x) => x.severity !== 'info'))
      .map((r) => ({ account: r.account, name: r.name, preparedBy: who(r.preparedBy), reviewedBy: who(r.reviewedBy) })),
  };
});
