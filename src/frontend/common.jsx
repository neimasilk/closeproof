/**
 * Small UI pieces shared by the dashboard and the issue panel.
 */
import React from 'react';
import { Text, User, Lozenge, Inline, Stack, SectionMessage, List, ListItem } from '@forge/react';
import { invoke } from '@forge/bridge';

/** invoke() a resolver and unwrap {ok, data, error}. Throws Error(message). */
export async function call(name, payload) {
  const res = await invoke(name, payload);
  if (!res?.ok) throw new Error(res?.error ?? `Request ${name} failed`);
  return res.data;
}

/** A real Atlassian user, or a fictional demo person. */
export const Person = ({ id, demoPeople }) => {
  if (!id) return <Text>-</Text>;
  if (String(id).startsWith('demo:')) return <Text>{demoPeople?.[id] ?? id.slice(5)}</Text>;
  return <User accountId={id} />;
};

const STATUS = {
  draft: { label: 'Draft', appearance: 'default' },
  prepared: { label: 'Prepared', appearance: 'inprogress' },
  reviewed: { label: 'Reviewed', appearance: 'success' },
};

/** Status lozenge; a reviewed rec with exceptions is shown as "Reviewed, broken". */
export const StatusLozenge = ({ evaluation }) => {
  const s = STATUS[evaluation.status] ?? STATUS.draft;
  const broken = evaluation.exceptions.some((x) => x.severity === 'blocker');
  if (evaluation.status !== 'draft' && broken) {
    return <Lozenge appearance="removed">{s.label}, failing</Lozenge>;
  }
  return <Lozenge appearance={s.appearance}>{s.label}</Lozenge>;
};

const SEV = {
  blocker: { appearance: 'removed', label: 'Blocker' },
  warning: { appearance: 'moved', label: 'Warning' },
  info: { appearance: 'default', label: 'Info' },
};

/** One exception line: [C1] message */
export const ExceptionLine = ({ x }) => (
  <Inline space="space.100" alignBlock="center" shouldWrap>
    <Lozenge appearance={SEV[x.severity]?.appearance ?? 'default'}>{x.control}</Lozenge>
    <Text>{x.message}</Text>
  </Inline>
);

export const ExceptionList = ({ exceptions, includeInfo = false }) => {
  const shown = exceptions.filter((x) => includeInfo || x.severity !== 'info');
  if (!shown.length) return <Lozenge appearance="success">No exceptions</Lozenge>;
  return (
    <Stack space="space.050">
      {shown.map((x, i) => (
        <ExceptionLine key={i} x={x} />
      ))}
    </Stack>
  );
};

/** Error box that keeps line breaks from server messages. */
export const ErrorBox = ({ error }) => {
  if (!error) return null;
  const [first, ...rest] = String(error).split('\n');
  return (
    <SectionMessage appearance="error" title={first}>
      {rest.length ? (
        <List type="unordered">
          {rest.map((r, i) => (
            <ListItem key={i}>{r.replace(/^- /, '')}</ListItem>
          ))}
        </List>
      ) : (
        <Text> </Text>
      )}
    </SectionMessage>
  );
};

export const CONTROL_HELP = [
  ['C1', 'Tie-out', 'GL balance minus source balance minus reconciling items must be exactly zero.'],
  ['C2', 'Roll-forward', "Opening balance must equal last month's reviewed closing balance."],
  ['C3', 'Segregation of duties', 'Preparer and reviewer must be different people, in that order.'],
  ['C4', 'Evidence present', 'At least one supporting document is attached.'],
  ['C5', 'Evidence intact', 'Every evidence file is re-downloaded and its SHA-256 must still match.'],
  ['C6', 'No edits after sign-off', 'A change after signing needs a new sign-off.'],
  ['C7', 'Stale items', 'Reconciling items older than the limit at period end are flagged.'],
];
