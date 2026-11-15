/**
 * Jira project page: "Month-end close" dashboard.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Link,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  Tooltip,
  Badge,
  Code,
} from '@forge/react';
import { call, Person, StatusLozenge, ExceptionList, ErrorBox, CONTROL_HELP } from './common';

const App = () => {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (p, verify = false) => {
    setError('');
    try {
      const d = await call('getDashboard', { period: p, verify });
      setData(d);
      setPeriod(d.period);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load(undefined);
  }, [load]);

  const run = async (label, fn) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!data && !error) return <Spinner label="Loading close" />;
  if (!data) return <ErrorBox error={error} />;

  const { summary, rows, certificate, demoPeople } = data;
  const periodOptions = data.periods.map((p) => ({ label: p, value: p }));

  const loadDemo = () =>
    run('demo', async () => {
      const r = await call('loadDemo', { period: data.suggestedDemoPeriod, replace: true });
      setNotice(`Demo close for ${r.period} created: ${r.created.length} reconciliations, each with a Jira issue and statement.`);
      await load(r.period, true);
    });

  const verify = () =>
    run('verify', async () => {
      await load(period, true);
      setNotice('Every evidence file was downloaded again and its SHA-256 compared with the hash taken when it was attached.');
    });

  const certify = () =>
    run('cert', async () => {
      const d = await call('issueCertificate', { period });
      setData({ ...data, ...d });
    });

  const head = {
    cells: [
      { key: 'acct', content: 'Account' },
      { key: 'status', content: 'Status' },
      { key: 'diff', content: 'Unexplained' },
      { key: 'exc', content: 'Exceptions' },
      { key: 'prep', content: 'Prepared by' },
      { key: 'rev', content: 'Reviewed by' },
      { key: 'issue', content: 'Issue' },
    ],
  };

  const tableRows = rows.map((r) => ({
    key: r.account,
    cells: [
      {
        key: 'acct',
        content: (
          <Stack space="space.0">
            <Strong>{r.account}</Strong>
            {r.demoStory ? (
              <Tooltip content={r.demoStory}>
                <Text>{r.name}</Text>
              </Tooltip>
            ) : (
              <Text>{r.name}</Text>
            )}
          </Stack>
        ),
      },
      { key: 'status', content: <StatusLozenge evaluation={r.evaluation} /> },
      {
        key: 'diff',
        content:
          r.evaluation.unexplained === '0' ? (
            <Lozenge appearance="success">0.00</Lozenge>
          ) : (
            <Lozenge appearance="removed">{r.display.unexplained}</Lozenge>
          ),
      },
      { key: 'exc', content: <ExceptionList exceptions={r.evaluation.exceptions} /> },
      { key: 'prep', content: <Person id={r.preparedBy} demoPeople={demoPeople} /> },
      { key: 'rev', content: <Person id={r.reviewedBy} demoPeople={demoPeople} /> },
      {
        key: 'issue',
        content: r.issueKey ? <Link href={`/browse/${r.issueKey}`}>{r.issueKey}</Link> : <Text>-</Text>,
      },
    ],
  }));

  return (
    <Stack space="space.300">
      <Inline spread="space-between" alignBlock="center" shouldWrap>
        <Stack space="space.050">
          <Text>
            Evidence-checked account reconciliations for project {data.projectKey}. Amounts in {data.config.currency}.
          </Text>
        </Stack>
        <Inline space="space.100" alignBlock="center">
          <Box xcss={{ width: '140px' }}>
            <Select
              inputId="period"
              options={periodOptions}
              value={periodOptions.find((o) => o.value === period)}
              onChange={(o) => run('period', () => load(o.value))}
            />
          </Box>
          <ButtonGroup>
            <Button onClick={verify} isDisabled={!!busy || !rows.length}>
              {busy === 'verify' ? 'Verifying...' : 'Verify evidence'}
            </Button>
            <Button onClick={loadDemo} isDisabled={!!busy}>
              {busy === 'demo' ? 'Creating demo...' : 'Load demo close'}
            </Button>
          </ButtonGroup>
        </Inline>
      </Inline>

      <ErrorBox error={error} />
      {notice ? (
        <SectionMessage appearance="information">
          <Text>{notice}</Text>
        </SectionMessage>
      ) : null}

      {!rows.length ? (
        <EmptyState
          header={`No reconciliations for ${period} yet`}
          description="Open any Jira issue in this project and use the Reconciliation panel to start one, or load a demo close with eight accounts and one planted problem per control."
          primaryAction={
            <Button appearance="primary" onClick={loadDemo} isDisabled={!!busy}>
              {busy === 'demo' ? 'Creating demo...' : 'Load demo close'}
            </Button>
          }
        />
      ) : (
        <Stack space="space.200">
          <Stack space="space.100">
            <Inline space="space.200" alignBlock="center" shouldWrap>
              <Text>
                <Strong>{summary.clean}</Strong> of <Strong>{summary.total}</Strong> reconciliations reviewed and clean
              </Text>
              <Inline space="space.050" alignBlock="center">
                <Badge appearance="removed">{summary.blockers}</Badge>
                <Text>blockers</Text>
              </Inline>
              <Inline space="space.050" alignBlock="center">
                <Badge appearance="warning">{summary.warnings}</Badge>
                <Text>warnings</Text>
              </Inline>
              <Text>{data.evidenceVerified ? 'Evidence re-verified just now.' : 'Evidence not re-verified in this view.'}</Text>
            </Inline>
            <ProgressBar value={summary.percentClean / 100} appearance={summary.readyToClose ? 'success' : 'default'} />
          </Stack>

          {certificate?.stillValid ? (
            <SectionMessage appearance="success" title={`${period} is closed`}>
              <Text>
                Close certificate issued {certificate.issuedAt.slice(0, 16).replace('T', ' ')} UTC over {certificate.count}{' '}
                reviewed reconciliations. SHA-256 <Code>{certificate.hash}</Code>
              </Text>
            </SectionMessage>
          ) : certificate ? (
            <SectionMessage appearance="error" title="Close certificate no longer valid">
              <Text>
                Reconciliations changed after the certificate was issued (hash <Code>{certificate.hash.slice(0, 16)}</Code>...). Fix the
                exceptions and issue a new certificate.
              </Text>
            </SectionMessage>
          ) : summary.readyToClose ? (
            <SectionMessage appearance="success" title="Ready to close">
              <Button appearance="primary" onClick={certify} isDisabled={!!busy}>
                {busy === 'cert' ? 'Issuing...' : `Issue close certificate for ${period}`}
              </Button>
            </SectionMessage>
          ) : null}

          <DynamicTable head={head} rows={tableRows} />
        </Stack>
      )}

      <Stack space="space.100">
        <Heading size="small">Controls</Heading>
        {CONTROL_HELP.map(([id, name, text]) => (
          <Inline key={id} space="space.100" alignBlock="center">
            <Lozenge>{id}</Lozenge>
            <Text>
              <Strong>{name}.</Strong> {text}
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
