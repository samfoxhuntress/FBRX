import { useState } from 'react';
import { Button, Callout, Card, Empty, Grid, Page, Spinner, StatTile, Status, Tabs, useAction, useToast, Table } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { newReqId, useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';
import { useRelease } from '../release';
import { displayVersion } from '@fbrx/shared';
import { AskButton } from '../widgets';

type Tab = 'apps' | 'windows' | 'drivers' | 'history';

function Apps() {
  const apps = useCore('winupdates.apps');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const { run } = useAction();
  const toast = useToast();
  const upgrade = async (id: string, name: string) => {
    const reqId = newReqId();
    setRunning(id);
    setLog([]);
    const off = onEvent('winupdates.event', (e) => e.reqId === reqId && setLog((l) => [...l.slice(-200), e.line]));
    const r = await run(id, () => call('winupdates.upgradeApp', { id, reqId }));
    off();
    setRunning(null);
    if (r) (r.ok ? toast.success : toast.warning)(r.ok ? `${name} updated` : `${name} did not update`, r.ok ? undefined : r.output.slice(-200));
    apps.reload();
  };
  return (
    <>
      <Card
        title="App updates"
        subtitle="Updates available through winget (Windows Package Manager)"
        actions={
          <>
            {!!apps.data?.length && <AskButton label="Should I update these?" prompt="These app updates are available on my PC. Tell me which ones matter (security fixes, big improvements), anything to watch out for, and a sensible order to install them." context={apps.data} />}
            <Button size="sm" icon="refresh" onClick={() => apps.reload()}>
              Check again
            </Button>
            {(apps.data?.length ?? 0) > 1 && (
              <Button size="sm" variant="primary" loading={running === '--all'} disabled={!!running} onClick={() => void upgrade('--all', 'All apps')}>
                Update all
              </Button>
            )}
          </>
        }
        flush
      >
        {apps.error ? (
          <Callout tone="warning">{apps.error}</Callout>
        ) : !apps.data ? (
          <div style={{ padding: 18 }}>
            <Spinner /> <span className="fx-muted">Asking winget… (can take a minute)</span>
          </div>
        ) : (
          <Table
            columns={[
              { key: 'n', header: 'App', render: (a) => a.name },
              { key: 'c', header: 'Installed', render: (a) => <span className="mono">{a.current}</span> },
              { key: 'a', header: 'Available', render: (a) => <span className="mono">{a.available}</span> },
              { key: 's', header: 'Source', render: (a) => <span className="fx-muted">{a.source}</span> },
              { key: 'u', header: '', render: (a) => <Button size="sm" loading={running === a.id} disabled={!!running} onClick={() => void upgrade(a.id, a.name)}>Update</Button> },
            ]}
            rows={apps.data}
            rowKey={(a) => a.id}
            empty={<Empty title="Everything is up to date" />}
          />
        )}
      </Card>
      {log.length > 0 && (
        <Card title="winget output">
          <pre className="fx-code" style={{ maxHeight: 240, margin: 0 }}>
            {log.join('\n')}
          </pre>
        </Card>
      )}
    </>
  );
}

function WindowsUpdate() {
  const wu = useCore('winupdates.windows');
  const { run } = useAction();
  return (
    <Card
      title="Windows Update"
      subtitle="Updates Windows has found but not installed yet"
      actions={
        <>
          {!!wu.data?.length && <AskButton label="Explain these" prompt="Windows Update has found these updates on my PC. Explain what each one is in plain language and whether I should install it now." context={wu.data} />}
          <Button size="sm" onClick={() => void run('o', () => call('winupdates.open', { page: 'check' }))}>Open Windows Update</Button>
          <Button size="sm" variant="ghost" onClick={() => void run('o', () => call('winupdates.open', { page: 'optional' }))}>Optional updates</Button>
        </>
      }
      flush
    >
      {wu.error ? (
        <Callout tone="warning">{wu.error}</Callout>
      ) : !wu.data ? (
        <div style={{ padding: 18 }}>
          <Spinner /> <span className="fx-muted">Searching for updates… (can take a few minutes)</span>
        </div>
      ) : (
        <Table
          columns={[
            { key: 't', header: 'Update', render: (u) => u.title },
            { key: 'k', header: 'KB', render: (u) => <span className="mono">{u.kb}</span> },
            { key: 's', header: 'Severity', render: (u) => <Status tone={/critical/i.test(u.severity) ? 'critical' : /important/i.test(u.severity) ? 'warning' : 'neutral'}>{u.severity}</Status> },
            { key: 'z', header: 'Size', render: (u) => (u.sizeMB ? `${u.sizeMB} MB` : '—') },
            { key: 'd', header: '', render: (u) => (u.downloaded ? <Status tone="info">downloaded</Status> : null) },
          ]}
          rows={wu.data}
          rowKey={(u) => u.title}
          empty={<Empty title="Windows is up to date" />}
        />
      )}
    </Card>
  );
}

function Drivers() {
  const drivers = useCore('winupdates.drivers');
  const old = (drivers.data ?? []).filter((d) => d.date && d.date < new Date(Date.now() - 3 * 365 * 86400_000).toISOString().slice(0, 10));
  return (
    <>
      {old.length > 0 && <Callout tone="info">{old.length} driver(s) are more than three years old. Check the device maker's website or Windows optional updates for newer versions.</Callout>}
      <Card title="Drivers from other vendors" subtitle="Oldest first" actions={!!drivers.data?.length && <AskButton label="Review my drivers" prompt="Here are the drivers from other vendors on my PC, oldest first. Which ones are outdated or risky, and where should I get updates for them?" context={drivers.data.slice(0, 60)} />} flush>
        <Table
          columns={[
            { key: 'd', header: 'Device', render: (d) => d.device },
            { key: 'p', header: 'Vendor', render: (d) => d.provider },
            { key: 'v', header: 'Version', render: (d) => <span className="mono">{d.version}</span> },
            { key: 'c', header: 'Class', render: (d) => <span className="fx-muted">{d.className}</span> },
            { key: 't', header: 'Date', render: (d) => d.date || '—' },
          ]}
          rows={drivers.data ?? []}
          rowKey={(d) => `${d.device}${d.version}`}
          empty={drivers.error ? <Callout tone="warning">{drivers.error}</Callout> : <div style={{ padding: 18 }}><Spinner /></div>}
        />
      </Card>
    </>
  );
}

function History() {
  const hf = useCore('winupdates.hotfixes');
  const { run } = useAction();
  return (
    <Card title="Installed updates" actions={<Button size="sm" onClick={() => void run('h', () => call('winupdates.open', { page: 'history' }))}>Update history</Button>} flush>
      <Table
        columns={[
          { key: 'i', header: 'Update', render: (h) => <span className="mono">{h.id}</span> },
          { key: 'd', header: 'Type', render: (h) => h.description },
          { key: 't', header: 'Installed', render: (h) => h.installedOn ?? '—' },
        ]}
        rows={hf.data ?? []}
        rowKey={(h) => h.id}
        empty={hf.error ? <Callout tone="warning">{hf.error}</Callout> : <div style={{ padding: 18 }}><Spinner /></div>}
      />
    </Card>
  );
}

export function UpdatesPage() {
  const [tab, setTab] = useState<Tab>('apps');
  const fbrx = useRelease().data;
  const fbrxTile = (
    <StatTile
      label="FBRX OS"
      value={fbrx ? displayVersion(fbrx.currentVersion) : '…'}
      foot={
        fbrx?.state === 'available' && fbrx.latest ? (
          <Button size="sm" variant="primary" icon="download" onClick={() => navigate('settings/updates')}>
            {fbrx.latest.version} available
          </Button>
        ) : fbrx?.state === 'current' ? (
          'Up to date'
        ) : (
          <Button size="sm" onClick={() => navigate('settings/updates')}>
            Check for a new version
          </Button>
        )
      }
    />
  );
  if (!IS_WINDOWS) {
    return (
      <Page title="Updates" description="Keep your apps, drivers and Windows itself up to date.">
        <Grid cols={3}>{fbrxTile}</Grid>
        <Callout tone="info">App, driver and Windows updates are managed here on Windows.</Callout>
      </Page>
    );
  }
  return (
    <Page title="Updates" description="Keep your apps, drivers and Windows itself up to date in one place.">
      <Grid cols={3}>
        {fbrxTile}
      </Grid>
      <Tabs
        tabs={[
          { id: 'apps', label: 'Apps' },
          { id: 'windows', label: 'Windows' },
          { id: 'drivers', label: 'Drivers' },
          { id: 'history', label: 'Installed' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'apps' && <Apps />}
      {tab === 'windows' && <WindowsUpdate />}
      {tab === 'drivers' && <Drivers />}
      {tab === 'history' && <History />}
    </Page>
  );
}
