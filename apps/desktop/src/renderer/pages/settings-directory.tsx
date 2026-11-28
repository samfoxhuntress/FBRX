import { useState } from 'react';
import type { DirectoryMembership, DirectoryStep, ServerCheck } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Input, KeyValue, Select, Status, formatDate, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

const STEP_ICON: Partial<Record<DirectoryStep['kind'], string>> = { create: '+', disable: '−', unadmin: '−', leave: '−' };

/**
 * Settings → Directory: this computer in an FBRX directory (FBRX Server's directory role). It joins through a saved
 * server with a join code; changes the directory sends wait here until someone with administrator rights on this
 * computer applies them through the system's own administrator prompt.
 */
export function DirectorySettings() {
  const st = useCore('directory.status', undefined, [], 15_000);
  const d = st.data;
  if (!d) return <Card title="Directory">{st.error ? <Callout tone="critical" title="The directory does not answer">{st.error}</Callout> : <Empty title="Loading…" />}</Card>;
  return d.joined ? <Joined d={d} reload={st.reload} /> : <Join reload={st.reload} />;
}

function Join({ reload }: { reload: () => void }) {
  const saved = useCore('server.saved');
  const servers = (saved.data?.servers ?? []).filter((s) => s.scheme === 'https');
  const [serverId, setServerId] = useState('');
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [check, setCheck] = useState<{ id: string; name: string; result: ServerCheck } | null>(null);
  const [code, setCode] = useState('');
  const { run, busy } = useAction();
  const pick = serverId || servers[0]?.id || '';
  const picked = servers.find((s) => s.id === pick);
  const ready = !!picked && (!!picked.fingerprint || check?.id !== picked.id || check.result.ok);
  // Saves the server and looks at its certificate: a certificate no authority vouches for is compared by the person.
  const lookUp = () =>
    void run('look', async () => {
      // An address saved already is that server.
      const typed = address.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '');
      const s = servers.find((x) => typed === x.host || typed === `${x.host}:${x.port}`) ?? (await call('server.save', { address }));
      const result = await call('server.check', { id: s.id });
      setCheck({ id: s.id, name: s.name, result });
      setServerId(s.id);
      setAdding(false);
      saved.reload();
    });
  return (
    <Card
      title="Join a directory"
      subtitle="An FBRX Server with the directory role keeps the same accounts on every computer that joins: who has one, who is an administrator, and the password rules."
    >
      <div className="fx-form">
        {servers.length > 0 && !adding ? (
          <Field label="Server">
            <div className="fx-actions">
              <Select value={pick} onChange={(e) => setServerId(e.target.value)} options={servers.map((s) => ({ value: s.id, label: `${s.name} (${s.host})` }))} style={{ maxWidth: 360 }} />
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
                Another server
              </Button>
            </div>
          </Field>
        ) : (
          <Field label="The server's address" help="Its name or IP address, as you open its console (port 9443 unless you say otherwise).">
            <div className="fx-actions">
              <Input value={address} placeholder="fbrx-server or 192.168.1.20" onChange={(e) => setAddress(e.target.value)} style={{ width: 260 }} />
              <Button icon="search" loading={busy === 'look'} disabled={!address.trim()} onClick={lookUp}>
                Look it up
              </Button>
              {servers.length > 0 && (
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </Field>
        )}
        {check && check.id === pick && !check.result.ok && (
          check.result.certificate && !check.result.changed ? (
            <Callout
              tone="warning"
              title="Compare its certificate"
              actions={
                <Button size="sm" variant="primary" icon="check" loading={busy === 'trust'} onClick={() => void run('trust', async () => (await call('server.trust', { id: check.id, fingerprint: check.result.certificate!.fingerprint }), setCheck({ ...check, result: { ...check.result, ok: true } }), saved.reload()), 'Trusted')}>
                  They match: trust it
                </Button>
              }
            >
              The server's console shows its fingerprint with each join code. Make sure it is this one:
              <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{check.result.certificate.fingerprint}</div>
            </Callout>
          ) : (
            <Callout tone="critical" title={check.result.changed ? 'Its certificate changed' : 'It does not answer'}>
              {check.result.error ?? `${check.name} presents a different certificate than the one trusted before. If it was reinstalled, check the new one in Saved servers.`}
            </Callout>
          )
        )}
        {picked && (
          <>
            <Field label="Join code" help="From the server's console: Directory, New join code.">
              <Input value={code} maxLength={20} placeholder="ABCDE-FGHJK" onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 180 }} className="mono" />
            </Field>
            <div className="fx-actions">
              <Button variant="primary" icon="link" loading={busy === 'join'} disabled={!ready || code.replace(/[^A-Z0-9]/g, '').length < 10} onClick={() => void run('join', () => call('directory.join', { serverId: pick, code }).then(reload), 'Joined the directory')}>
                Join
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function Joined({ d, reload }: { d: DirectoryMembership; reload: () => void }) {
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const waiting = d.plan.length;
  return (
    <>
      <Card
        title={d.directory ?? 'Directory'}
        subtitle={`This computer is in the FBRX directory on ${d.serverName ?? 'an FBRX Server'}.`}
        actions={
          <Button size="sm" variant="ghost" icon="refresh" loading={busy === 'sync'} onClick={() => void run('sync', () => call('directory.sync').then(reload))}>
            Look for changes
          </Button>
        }
      >
        <KeyValue
          items={[
            ['Accounts', waiting ? <Status tone="warning">{waiting} change{waiting === 1 ? '' : 's'} waiting</Status> : d.error ? <Status tone="critical">{d.error}</Status> : <Status tone="good">As the directory says</Status>],
            ['Last looked', d.lastSyncAt ? <span title={formatDate(d.lastSyncAt)}>{timeAgo(d.lastSyncAt)}</span> : 'Not yet'],
            ['Last applied', d.lastAppliedAt ? <span title={formatDate(d.lastAppliedAt)}>{timeAgo(d.lastAppliedAt)}</span> : 'Never'],
          ]}
        />
        {waiting > 0 && d.error && <Callout tone="warning" title="Last time">{d.error}</Callout>}
      </Card>

      {waiting > 0 && (
        <Card title="Changes for this computer" subtitle="Applying them asks for an administrator's password here (the system's own prompt). Accounts are never deleted: one that leaves is disabled, with its files kept.">
          <ul className="dir-steps">
            {d.plan.map((s, i) => (
              <li key={i}>
                <span className="dir-step-mark">{STEP_ICON[s.kind] ?? '•'}</span> {s.words}
              </li>
            ))}
          </ul>
          <div className="fx-actions">
            <Button variant="primary" icon="shield" loading={busy === 'apply'} onClick={() => void run('apply', () => call('directory.apply').then(reload), 'Applied')}>
              Apply changes
            </Button>
          </div>
        </Card>
      )}

      {d.problems.length > 0 && (
        <Callout tone="warning" title="Notes from the last look">
          <ul className="dir-steps">
            {d.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}

      <Card title="Leave the directory">
        <p className="fx-secondary">The accounts on this computer stay as they are; the directory just stops changing them.</p>
        <div className="fx-actions">
          <Button
            variant="ghost"
            icon="logout"
            loading={busy === 'leave'}
            onClick={async () => {
              if (await confirm({ title: `Leave ${d.directory ?? 'the directory'}?`, body: 'The accounts stay. To join again, you need a new join code.', confirmLabel: 'Leave', danger: true })) void run('leave', () => call('directory.leave').then(reload), 'Left the directory');
            }}
          >
            Leave
          </Button>
        </div>
      </Card>
      {dialog}
    </>
  );
}
