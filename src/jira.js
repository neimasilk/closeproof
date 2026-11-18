/**
 * Thin wrappers around the Jira Cloud REST API.
 *
 * Reads go through api.asUser() so Jira applies the signed-in user's own
 * permissions. The demo seeder also uses asUser(), so it can only create
 * issues where the user could create them by hand.
 */
import api, { route } from '@forge/api';
import { sha256Hex } from './lib/hash.js';

async function ok(res, what) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${what} failed (${res.status}) ${body.slice(0, 200)}`);
  }
  return res;
}

/**
 * Which of the given project permissions the current user has.
 * @returns {Promise<Record<string, boolean>>}
 */
export async function myProjectPermissions(projectKey, permissions) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions.join(',')}`);
  await ok(res, 'Permission check');
  const json = await res.json();
  const out = {};
  for (const p of permissions) out[p] = Boolean(json.permissions?.[p]?.havePermission);
  return out;
}

/** Throw unless the user may browse (and, for writes, edit issues in) the project. */
export async function requireProjectAccess(projectKey, { write = false } = {}) {
  const wanted = write ? ['BROWSE_PROJECTS', 'EDIT_ISSUES'] : ['BROWSE_PROJECTS'];
  const perms = await myProjectPermissions(projectKey, wanted);
  const missing = wanted.filter((p) => !perms[p]);
  if (missing.length) {
    throw new Error(`You need ${missing.join(' and ')} permission in project ${projectKey}`);
  }
}

/** Attachments on an issue: [{id, filename, size, created, mimeType}] */
export async function listAttachments(issueKey) {
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=attachment,summary,project`);
  await ok(res, `Reading ${issueKey}`);
  const json = await res.json();
  return {
    summary: json.fields?.summary ?? '',
    projectKey: json.fields?.project?.key,
    attachments: (json.fields?.attachment ?? []).map((a) => ({
      id: String(a.id),
      filename: a.filename,
      size: a.size,
      created: a.created,
      mimeType: a.mimeType,
    })),
  };
}

/** Download an attachment and return its SHA-256 (hex). */
export async function hashAttachment(attachmentId) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);
  if (res.status === 404) return { missing: true };
  await ok(res, `Downloading attachment ${attachmentId}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { missing: false, sha256: sha256Hex(buf), size: buf.length };
}

/** First standard (non sub-task) issue type, preferring "Task". */
export async function pickIssueType(projectKey) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=50`);
  await ok(res, 'Reading issue types');
  const json = await res.json();
  const types = (json.issueTypes ?? json.values ?? []).filter((t) => !t.subtask);
  if (!types.length) throw new Error(`Project ${projectKey} has no issue type the demo can use`);
  return (types.find((t) => t.name === 'Task') ?? types[0]).id;
}

/**
 * Create a plain issue and return its key.
 * Pass issueTypeId when creating many issues, to look the type up only once.
 */
export async function createIssue(projectKey, summary, description, issueTypeId) {
  issueTypeId = issueTypeId ?? (await pickIssueType(projectKey));
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
      },
    },
  };
  const res = await api.asUser().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  await ok(res, 'Creating issue');
  return (await res.json()).key;
}

/** Upload a text file as an attachment; returns {id, filename}. */
export async function uploadAttachment(issueKey, filename, text, mimeType = 'text/csv') {
  const form = new FormData();
  form.append('file', new Blob([text], { type: mimeType }), filename);
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
    body: form,
  });
  await ok(res, `Uploading ${filename}`);
  const [a] = await res.json();
  return { id: String(a.id), filename: a.filename };
}

/** Delete an attachment (used by the demo to simulate a replaced statement). */
export async function deleteAttachment(attachmentId) {
  const res = await api.asUser().requestJira(route`/rest/api/3/attachment/${attachmentId}`, { method: 'DELETE' });
  await ok(res, `Deleting attachment ${attachmentId}`);
}
