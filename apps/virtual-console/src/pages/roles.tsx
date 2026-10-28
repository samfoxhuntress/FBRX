import { useEffect, useState } from 'react';
import { rolesProblem, type ServerRolesStatus } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, formatDate, Page, Select, Status, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

/**
 * What this server does: its roles, and changing them. FBRX Server's own installer (the copy it keeps) adds and removes
 * what each role needs, the same as sudo fbrx-server roles set; the console restarts at the end and shows how it went.
 */
export function RolesPage() {
  const app = useApp();
  const st = usePoll<ServerRolesStatus>('/v1/server/roles', 4000);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [wan, setWan] = useState('');
  const [lan, setLan] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const s = st.data;
  useEffect(() => {
    if (s && !wan && !lan) {
      setWan(s.ports.includes(s.gate.wan) ? s.gate.wan : (s.ports[0] ?? ''));
      setLan(s.ports.includes(s.gate.lan) ? s.gate.lan : (s.ports[1] ?? ''));
    }
  }, [s, wan, lan]);
  if (!s) return <Page title="Roles">{st.error ? <Callout tone="critical">{st.error}</Callout> : <Empty title="Loading…" />}</Page>;

  const roles = picked ?? s.roles;
  const changed = roles.slice().sort().join(',') !== s.roles.slice().sort().join(',');
  const problem = changed ? rolesProblem(roles) : null;
  const gateNew = roles.includes('gate') && !s.roles.includes('gate');
  const gateGone = s.roles.includes('gate') && !roles.includes('gate');
  const running = s.change?.state === 'running';
  const admin = app.can('admin');
  const toggle = (id: string, on: boolean) => setPicked(on ? [...roles, id] : roles.filter((r) => r !== id));

  const apply = async () => {
    const added = roles.filter((r) => !s.roles.includes(r));
    const removed = s.roles.filter((r) => !roles.includes(r));
    const name = (id: string) => s.catalog.find((c) => c.id === id)?.name ?? id;
    const ok = await confirm({
      title: 'Change this server’s roles?',
      body: [
        added.length ? `Adds ${added.map(name).join(', ')}.` : '',
        removed.length ? `Turns off ${removed.map(name).join(', ')} (its data stays on the server).` : '',
        gateGone ? 'Your network loses its router and firewall until you add FBRX Gate again.' : '',
        'The installer runs for a few minutes; this console restarts at the end and you may need to sign in again.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Change the roles',
      danger: gateGone,
    });
    if (!ok) return;
    await run('apply', () => api('POST', '/v1/server/roles', { roles, ...(gateNew ? { gateWan: wan, gateLan: lan } : {}), force: gateGone }).then(() => st.reload()), 'Changing the roles');
    setPicked(null);
  };

  return (
    <Page title="Roles" description="What this server does. Each role brings what it needs; turning one off keeps its data.">
      {!s.canChange && (
        <Callout tone="info" title="Roles change from the server's command line for now">
          {s.why}
          <div style={{ marginTop: 8 }}>
            <CopyText value={`sudo fbrx-server roles add time`} />
          </div>
        </Callout>
      )}
      {s.change && (
        <Card
          title={running ? 'Changing the roles…' : s.change.state === 'done' ? 'The last change of roles' : 'The last change of roles did not finish'}
          subtitle={`${s.change.roles.split(',').join(', ')}${s.change.startedAt ? ` · ${formatDate(s.change.startedAt)}` : ''}`}
          actions={<Status tone={running ? 'busy' : s.change.state === 'done' ? 'good' : 'critical'}>{running ? 'running' : s.change.state}</Status>}
        >
          {s.change.log ? <pre className="roles-log">{s.change.log.split('\n').slice(-30).join('\n')}</pre> : <p className="fx-muted">{running ? 'Starting…' : 'No output kept.'}</p>}
        </Card>
      )}
      <Card title="This server's roles" subtitle={admin ? 'Pick what this server should do, then change the roles.' : 'An administrator changes them.'}>
        <div className="roles-list">
          {s.catalog.map((r) => {
            const on = roles.includes(r.id);
            const was = s.roles.includes(r.id);
            return (
              <div key={r.id} className={`roles-item${on ? ' on' : ''}`}>
                <Toggle checked={on} disabled={!admin || !s.canChange || running} onChange={(v) => toggle(r.id, v)} label={<b>{r.name}</b>} />
                <div className="fx-muted">{r.what}</div>
                <div className="roles-tags">
                  <code>{r.id}</code>
                  {r.needs?.length ? <span className="fx-muted">with {r.needs.map((n) => s.catalog.find((c) => c.id === n)?.name ?? n).join(', ')}</span> : null}
                  {on !== was && <Status tone={on ? 'info' : 'warning'}>{on ? 'to add' : 'to turn off'}</Status>}
                </div>
              </div>
            );
          })}
        </div>
        {gateNew && (
          <div className="roles-ports">
            <Field label="The internet port (from your modem or provider)">
              <Select value={wan} onChange={(e) => setWan(e.target.value)} options={s.ports} />
            </Field>
            <Field label="Your network's port (it becomes your network's router)">
              <Select value={lan} onChange={(e) => setLan(e.target.value)} options={s.ports} />
            </Field>
          </div>
        )}
        {gateGone && <Callout tone="warning">Turning FBRX Gate off takes your network’s router and firewall away.</Callout>}
        {problem && <Callout tone="warning">{problem}</Callout>}
        {admin && s.canChange && (
          <div className="fx-actions" style={{ marginTop: 12 }}>
            <Button variant="primary" icon="layers" disabled={!changed || !!problem || running || (gateNew && (!wan || !lan || wan === lan))} loading={busy === 'apply'} onClick={() => void apply()}>
              Change the roles
            </Button>
            {changed && (
              <Button variant="ghost" onClick={() => setPicked(null)}>
                Keep them as they are
              </Button>
            )}
          </div>
        )}
      </Card>
      {dialog}
    </Page>
  );
}
