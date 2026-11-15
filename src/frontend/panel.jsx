/**
 * Jira issue panel: one account reconciliation.
 * Balances and reconciling items, evidence from the issue's attachments
 * (hashed with SHA-256), and preparer / reviewer sign-off.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Code,
  DynamicTable,
  Heading,
  Inline,
  Label,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
} from '@forge/react';
import { call, Person, StatusLozenge, ExceptionList, ErrorBox } from './common';

const blankItem = () => ({ desc: '', amount: '', openedOn: '' });

/** Form state from a loaded reconciliation (amounts as display strings). */
function formFrom(rec) {
  return {
    name: rec.name ?? '',
    openingBalance: rec.display.openingBalance,
    glBalance: rec.display.glBalance,
    sourceBalance: rec.display.sourceBalance,
    items: rec.display.items.map((i) => ({ desc: i.desc, amount: i.amount, openedOn: i.openedOn ?? '' })),
  };
}

const Field = ({ label, id, value, onChange, placeholder, width = '180px' }) => (
  <Box xcss={{ width }}>
    <Label labelFor={id}>{label}</Label>
    <Textfield id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </Box>
);

const StartForm = ({ state, onStart, busy }) => {
  const [period, setPeriod] = useState(state.suggestedPeriod);
  const [account, setAccount] = useState('');
  const [name, setName] = useState(state.summary?.slice(0, 80) ?? '');
  return (
    <Stack space="space.150">
      <Text>Track this issue as an account reconciliation. CloseProof checks the tie-out, roll-forward, evidence and sign-offs.</Text>
      <Inline space="space.150" shouldWrap>
        <Field label="Period (YYYY-MM)" id="period" value={period} onChange={setPeriod} width="140px" />
        <Field label="Account code" id="account" value={account} onChange={setAccount} placeholder="1010" width="140px" />
        <Field label="Account name" id="name" value={name} onChange={setName} placeholder="Operating bank account" width="280px" />
      </Inline>
      <Box>
        <Button appearance="primary" isDisabled={busy || !account || !period} onClick={() => onStart({ period, account, name })}>
          Start reconciliation
        </Button>
      </Box>
    </Stack>
  );
};

const App = () => {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = useCallback((s) => {
    setState(s);
    setForm(s.rec ? formFrom(s.rec) : null);
  }, []);

  useEffect(() => {
    call('getIssueRec')
      .then(apply)
      .catch((e) => setError(e.message));
  }, [apply]);

  const run = async (name, payload) => {
    setBusy(true);
    setError('');
    try {
      apply(await call(name, payload));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state && !error) return <Spinner label="Loading reconciliation" />;
  if (!state) return <ErrorBox error={error} />;

  if (!state.rec) {
    return (
      <Stack space="space.200">
        <ErrorBox error={error} />
        <StartForm state={state} busy={busy} onStart={(input) => run('saveIssueRec', { input })} />
      </Stack>
    );
  }

  const { rec, demoPeople, me } = state;
  const ev = rec.evaluation;
  const evidenceIds = new Set(rec.evidence.map((e) => e.attachmentId));
  const candidates = state.attachments.filter((a) => !evidenceIds.has(a.id));
  const setItem = (idx, key, value) =>
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)) });

  return (
    <Stack space="space.250">
      <Inline spread="space-between" alignBlock="center" shouldWrap>
        <Stack space="space.0">
          <Heading size="small">
            {rec.account} {rec.name}
          </Heading>
          <Text>Period {rec.period}</Text>
        </Stack>
        <StatusLozenge evaluation={ev} />
      </Inline>

      <ErrorBox error={error} />
      {rec.demoStory ? (
        <SectionMessage appearance="discovery" title="Demo scenario">
          <Text>{rec.demoStory}</Text>
        </SectionMessage>
      ) : null}

      <Stack space="space.100">
        <Heading size="xsmall">Exceptions</Heading>
        <ExceptionList exceptions={ev.exceptions} includeInfo />
      </Stack>

      <Stack space="space.150">
        <Heading size="xsmall">Balances</Heading>
        <Inline space="space.150" shouldWrap>
          <Field label="Opening (last month close)" id="opening" value={form.openingBalance} onChange={(v) => setForm({ ...form, openingBalance: v })} />
          <Field label="GL balance" id="gl" value={form.glBalance} onChange={(v) => setForm({ ...form, glBalance: v })} />
          <Field label="Source balance (bank, sub-ledger)" id="src" value={form.sourceBalance} onChange={(v) => setForm({ ...form, sourceBalance: v })} />
        </Inline>
        <Text>Reconciling items (positive when the GL is higher than the source)</Text>
        {form.items.map((it, idx) => (
          <Inline key={idx} space="space.100" alignBlock="end" shouldWrap>
            <Field label="Description" id={`d${idx}`} value={it.desc} onChange={(v) => setItem(idx, 'desc', v)} width="260px" />
            <Field label="Amount" id={`a${idx}`} value={it.amount} onChange={(v) => setItem(idx, 'amount', v)} width="140px" />
            <Field label="Opened on (YYYY-MM-DD)" id={`o${idx}`} value={it.openedOn} onChange={(v) => setItem(idx, 'openedOn', v)} width="170px" />
            <Button appearance="subtle" onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })}>
              Remove
            </Button>
          </Inline>
        ))}
        <Inline space="space.100">
          <Button onClick={() => setForm({ ...form, items: [...form.items, blankItem()] })}>Add reconciling item</Button>
          <Button appearance="primary" isDisabled={busy} onClick={() => run('saveIssueRec', { input: form })}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </Inline>
        <Text>
          GL {rec.display.glBalance} - source {rec.display.sourceBalance} - items = unexplained{' '}
          <Strong>{rec.display.unexplained}</Strong>
        </Text>
      </Stack>

      <Stack space="space.100">
        <Heading size="xsmall">Evidence</Heading>
        {rec.evidence.length ? (
          <DynamicTable
            head={{ cells: [{ key: 'f', content: 'File' }, { key: 'h', content: 'SHA-256 at attach' }, { key: 'x', content: '' }] }}
            rows={rec.evidence.map((e) => ({
              key: e.attachmentId,
              cells: [
                { key: 'f', content: <Text>{e.filename}</Text> },
                { key: 'h', content: <Code>{e.sha256.slice(0, 16)}...</Code> },
                {
                  key: 'x',
                  content: e.archived ? (
                    <Lozenge>archived</Lozenge>
                  ) : (
                    <Button appearance="subtle" isDisabled={busy} onClick={() => run('removeEvidence', { attachmentId: e.attachmentId })}>
                      Remove
                    </Button>
                  ),
                },
              ],
            }))}
          />
        ) : (
          <Text>No evidence yet. Attach the bank statement or sub-ledger report to this issue, then add it here.</Text>
        )}
        {candidates.length ? (
          <Inline space="space.100" shouldWrap>
            {candidates.map((a) => (
              <Button key={a.id} isDisabled={busy} onClick={() => run('attachEvidence', { attachmentId: a.id })}>
                Use {a.filename} as evidence
              </Button>
            ))}
          </Inline>
        ) : null}
      </Stack>

      <Stack space="space.100">
        <Heading size="xsmall">Sign-off</Heading>
        <Inline space="space.300" shouldWrap>
          <Stack space="space.050">
            <Text>Prepared by</Text>
            <Person id={rec.preparedBy} demoPeople={demoPeople} />
            {rec.preparedAt ? <Text>{rec.preparedAt.slice(0, 16).replace('T', ' ')} UTC</Text> : null}
          </Stack>
          <Stack space="space.050">
            <Text>Reviewed by</Text>
            <Person id={rec.reviewedBy} demoPeople={demoPeople} />
            {rec.reviewedAt ? <Text>{rec.reviewedAt.slice(0, 16).replace('T', ' ')} UTC</Text> : null}
          </Stack>
        </Inline>
        <ButtonGroup>
          <Button appearance="primary" isDisabled={busy || !!rec.reviewedBy} onClick={() => run('prepare')}>
            Sign as preparer
          </Button>
          <Button appearance="primary" isDisabled={busy || !rec.preparedBy || rec.preparedBy === me} onClick={() => run('review')}>
            Sign as reviewer
          </Button>
          <Button appearance="subtle" isDisabled={busy || (!rec.preparedBy && !rec.reviewedBy)} onClick={() => run('reopen')}>
            Reopen
          </Button>
        </ButtonGroup>
        {rec.preparedBy === me && !rec.reviewedBy ? (
          <Text>You prepared this reconciliation, so a different person has to review it (control C3).</Text>
        ) : null}
      </Stack>

      <Stack space="space.050">
        <Heading size="xsmall">History</Heading>
        {(rec.history ?? [])
          .slice(-8)
          .reverse()
          .map((h, i) => (
            <Inline key={i} space="space.100" alignBlock="center" shouldWrap>
              <Text>{h.at.slice(0, 16).replace('T', ' ')}</Text>
              <Person id={h.by} demoPeople={demoPeople} />
              <Text>
                {h.action}
                {h.detail ? `: ${h.detail}` : ''}
              </Text>
            </Inline>
          ))}
      </Stack>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
