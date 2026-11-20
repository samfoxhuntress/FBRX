import { useState, type ReactNode } from 'react';
import type { ServerCommandStatus } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Input, KeyValue, Page, Status, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';

/**
 * FBRX Command on this server (the command role): where people and computers reach it, the certificate they trust and,
 * until someone sets it up, its setup token. And this server in an FBRX Command: its FBRX core (the ai role) joins one
 * as any FBRX computer does, and takes its settings and policy from it.
 */
export function CommandPage() {
  const st = usePoll<ServerCommandStatus>('/v1/server/command', 5000);
  const s = st.data;
  return (
    <Page title="FBRX Command" description="Your organization’s computers, their settings and policy, licenses and updates, run from this server.">
      {!s ? (
        st.error ? <Callout tone="critical" title="The console could not look">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {s.enabled ? <OnThisServer s={s} /> : <NotHere />}
          <ThisServer s={s} reload={st.reload} />
        </>
      )}
    </Page>
  );
}

function NotHere() {
  const [, go] = useRoute();
  return (
    <Card title="FBRX Command is not on this server">
      <p className="fx-secondary">
        With the FBRX Command role, this server runs your organization’s FBRX Command: the computers that join it, their settings and policy, licenses, updates, backups and the help desk, with its own console that you open in a browser. It runs day and night, so computers stay in touch with it, and it updates with the server.
      </p>
      <div className="fx-actions">
        <Button variant="primary" icon="layers" onClick={() => go('roles')}>
          Add it in Roles
        </Button>
      </div>
    </Card>
  );
}

function OnThisServer({ s }: { s: ServerCommandStatus }) {
  const [, go] = useRoute();
  return (
    <>
      {!s.running && (
        <Callout tone="critical" title="FBRX Command is not answering">
          {s.error} On the server, <code>sudo fbrx-server doctor --fix</code> starts it again.
        </Callout>
      )}
      {s.gateOpen === false && (
        <Callout tone="warning" title="Your network cannot reach FBRX Command through the gate yet">
          Computers join FBRX Command and stay in touch with it on port {s.url ? new URL(s.url).port : '8787'}. Add a firewall rule: from your network to the gate, TCP, that port, accept.{' '}
          <Button size="sm" variant="ghost" icon="shield" onClick={() => go('gate-firewall')}>
            Firewall
          </Button>
        </Callout>
      )}
      <Card
        title="FBRX Command on this server"
        subtitle={s.running ? `FBRX Command ${s.version ?? ''}` : undefined}
        actions={
          s.url && (
            <Button variant="primary" icon="external" onClick={() => window.open(s.url!, '_blank', 'noopener')}>
              Open FBRX Command
            </Button>
          )
        }
      >
        <KeyValue
          items={[
            ['State', s.running ? <Status tone={s.needsSetup ? 'warning' : 'good'}>{s.needsSetup ? 'Running, waiting to be set up' : 'Running'}</Status> : <Status tone="critical">Not answering</Status>],
            ['Address', s.url ? <CopyText value={s.url} /> : 'Not set (run the installer again with the command role)'],
            ['Certificate', s.fingerprint ? <CopyText value={s.fingerprint} /> : 'Made at its first start'],
            ...(s.setupToken ? ([['Setup token', <CopyText key="t" value={s.setupToken} secret />]] as Array<[string, ReactNode]>) : []),
          ]}
        />
        <p className="fx-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          {s.needsSetup
            ? 'Open FBRX Command and set it up with the setup token: your organization, and the first administrator. '
            : 'Computers join it from Deploy & enroll in FBRX Command. '}
          FBRX Command has its own certificate: your browser warns about it the first time, and a computer joining by hand shows this fingerprint to compare. Give the server a fixed address in your router, so computers keep finding it.
        </p>
      </Card>
    </>
  );
}

function ThisServer({ s, reload }: { s: ServerCommandStatus; reload: () => void }) {
  const app = useApp();
  const [, go] = useRoute();
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const admin = app.can('admin');
  const leave = async () => {
    const ok = await confirm({ title: 'Leave FBRX Command?', body: 'This server stops taking its settings and policy from FBRX Command. It keeps what it has; FBRX Command shows it as gone.', confirmLabel: 'Leave', danger: true });
    if (ok) await run('leave', () => api('POST', '/v1/server/command/leave').then(reload), 'This server left FBRX Command');
  };
  if (!s.canJoin)
    return (
      <Card title="This server in FBRX Command">
        <p className="fx-secondary">This server joins an FBRX Command through its FBRX core, which comes with the AI role. Add the AI role to manage this server from FBRX Command.</p>
        <div className="fx-actions">
          <Button icon="layers" onClick={() => go('roles')}>
            Roles
          </Button>
        </div>
      </Card>
    );
  if (s.joined)
    return (
      <Card title="This server in FBRX Command">
        <KeyValue
          items={[
            ['Organization', s.joined.organization],
            ['FBRX Command', <code key="u">{s.joined.server}</code>],
            ['Connection', <Status key="s" tone={s.joined.state === 'online' ? 'good' : s.joined.state === 'connecting' ? 'busy' : 'warning'}>{s.joined.state}</Status>],
          ]}
        />
        <p className="fx-muted" style={{ fontSize: 12.5 }}>Its FBRX core takes its settings and policy from FBRX Command, and shows there as one of the organization’s computers.</p>
        {admin && (
          <div className="fx-actions">
            <Button variant="ghost" loading={busy === 'leave'} onClick={() => void leave()}>
              Leave FBRX Command
            </Button>
          </div>
        )}
        {dialog}
      </Card>
    );
  return (
    <Card title="This server in FBRX Command" subtitle="Its FBRX core joins as one of your organization’s computers, and takes its settings and policy from there.">
      {!admin ? (
        <p className="fx-secondary">This server has not joined an FBRX Command. An administrator can join it here.</p>
      ) : (
        <div className="fx-form">
          <Field label="Enrollment token" help="In FBRX Command: Deploy & enroll, then a token for your servers.">
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token" />
          </Field>
          {!s.enabled && (
            <>
              <Field label="FBRX Command’s address">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://command.example.lan:8787" />
              </Field>
              <Field label="Its certificate’s fingerprint" help="When FBRX Command uses its own certificate: Deploy & enroll shows it.">
                <Input value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} placeholder="AB:CD:…" />
              </Field>
            </>
          )}
          <div className="fx-actions">
            <Button
              variant="primary"
              icon="link"
              disabled={!token.trim() || (!s.enabled && !url.trim())}
              loading={busy === 'join'}
              onClick={() => void run('join', () => api('POST', '/v1/server/command/join', { token, ...(s.enabled ? {} : { url, fingerprint }) }).then(reload), 'This server joined FBRX Command')}
            >
              {s.enabled ? 'Join this server’s FBRX Command' : 'Join FBRX Command'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
