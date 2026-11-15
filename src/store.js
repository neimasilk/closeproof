/**
 * Storage layer (Forge Key-Value Store).
 *
 * Key layout (all keys are scoped by Jira project key):
 *   cfg:<projectKey>                          project settings
 *   periods:<projectKey>                      list of periods that have data
 *   rec:<projectKey>:<period>:<account>       one account reconciliation
 *   issue:<issueKey>                          pointer issue -> reconciliation
 *   close:<projectKey>:<period>               close certificate
 *
 * Nothing leaves Atlassian: KVS is hosted by Forge.
 */
import { kvs, WhereConditions } from '@forge/kvs';
import { DEFAULT_CONFIG } from './lib/controls.js';
import { assertPeriod } from './lib/period.js';

const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,40}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{0,19}$/;
const ISSUE_RE = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;

export function assertAccount(a) {
  if (!ACCOUNT_RE.test(String(a ?? ''))) {
    throw new Error('Account code must be 1-40 letters, digits, dot, dash or underscore');
  }
  return String(a);
}
export function assertProjectKey(k) {
  if (!PROJECT_RE.test(String(k ?? ''))) throw new Error(`"${k}" is not a Jira project key`);
  return String(k);
}
export function assertIssueKey(k) {
  if (!ISSUE_RE.test(String(k ?? ''))) throw new Error(`"${k}" is not a Jira issue key`);
  return String(k);
}

const recKey = (p, period, account) => `rec:${p}:${period}:${account}`;

export async function getConfig(projectKey) {
  const stored = await kvs.get(`cfg:${assertProjectKey(projectKey)}`);
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export async function setConfig(projectKey, config) {
  await kvs.set(`cfg:${assertProjectKey(projectKey)}`, config);
}

export async function listPeriods(projectKey) {
  return (await kvs.get(`periods:${assertProjectKey(projectKey)}`)) ?? [];
}

async function rememberPeriod(projectKey, period) {
  const periods = await listPeriods(projectKey);
  if (!periods.includes(period)) {
    periods.push(period);
    periods.sort();
    await kvs.set(`periods:${projectKey}`, periods);
  }
}

export async function getRec(projectKey, period, account) {
  return kvs.get(recKey(assertProjectKey(projectKey), assertPeriod(period), assertAccount(account)));
}

/** All reconciliations of a period, sorted by account code. */
export async function listRecs(projectKey, period) {
  assertProjectKey(projectKey);
  assertPeriod(period);
  const prefix = `rec:${projectKey}:${period}:`;
  const out = [];
  let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    for (const r of page.results) out.push(r.value);
    cursor = page.nextCursor;
  } while (cursor);
  return out.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

export async function putRec(rec) {
  const { projectKey, period, account } = rec;
  await kvs.set(recKey(assertProjectKey(projectKey), assertPeriod(period), assertAccount(account)), rec);
  if (rec.issueKey) {
    await kvs.set(`issue:${assertIssueKey(rec.issueKey)}`, { projectKey, period, account });
  }
  await rememberPeriod(projectKey, period);
}

export async function deleteRec(rec) {
  await kvs.delete(recKey(rec.projectKey, rec.period, rec.account));
  if (rec.issueKey) await kvs.delete(`issue:${rec.issueKey}`);
}

/** Find the reconciliation linked to a Jira issue, if any. */
export async function getRecByIssue(issueKey) {
  const ptr = await kvs.get(`issue:${assertIssueKey(issueKey)}`);
  if (!ptr) return undefined;
  return getRec(ptr.projectKey, ptr.period, ptr.account);
}

export async function getCertificate(projectKey, period) {
  return kvs.get(`close:${assertProjectKey(projectKey)}:${assertPeriod(period)}`);
}

export async function putCertificate(projectKey, period, cert) {
  await kvs.set(`close:${assertProjectKey(projectKey)}:${assertPeriod(period)}`, cert);
}

export async function deleteCertificate(projectKey, period) {
  await kvs.delete(`close:${assertProjectKey(projectKey)}:${assertPeriod(period)}`);
}
