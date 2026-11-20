import { Button, Callout, Card, Empty, KeyValue, Status, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

/**
 * Settings → Remote desktop (Linux, Pro and up): the system's own xrdp, so any remote desktop (RDP) app can sign in to
 * this computer with its accounts, even with nobody at it. Setting it up goes through the system's administrator
 * prompt; FBRX installs xrdp (and a light desktop where there is none), starts it, and opens its port only to the local
 * networks where a firewall is on.
 */
export function RemoteDesktopSettings() {
  const st = useCore('pc.xrdpStatus', undefined, [], 30_000);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const s = st.data;
  if (!s) return <Card title="Remote desktop">{st.error ? <Callout tone="critical" title="Could not read it">{st.error}</Callout> : <Empty title="Loading…" />}</Card>;
  const set = (on: boolean) => void run(on ? 'on' : 'off', () => call('pc.setXrdp', { on }).then(st.reload), on ? 'Remote desktop is on' : 'Remote desktop is off');
  const where = s.addresses.length ? s.addresses.map((a) => (s.port === 3389 ? a : `${a}:${s.port}`)).join(', ') : 'this computer’s address';
  return (
    <Card title="Remote desktop" subtitle="Sign in to this computer from another one with any remote desktop (RDP) app, also when nobody is at it.">
      {!s.supported && <Callout tone="info">{s.why}</Callout>}
      {s.supported && (
        <>
          <KeyValue
            items={[
              ['State', s.running ? <Status tone="good">On, port {s.port}</Status> : s.installed ? <Status tone="neutral">Set up, turned off</Status> : <Status tone="neutral">Not set up</Status>],
              ['Connect to', s.running ? where : '—'],
              ['Desktop', s.desktops.length ? s.desktops.join(', ') : 'None yet: setting it up adds a light one (Xfce)'],
            ]}
          />
          {s.running && (
            <p className="fx-secondary">
              In the remote desktop app on the other computer, add {where} and sign in with an account on this computer (FBRX directory accounts work too). Signing in as the person already signed in here can show a black screen on some desktops: sign out here first, or use another account.
            </p>
          )}
          {s.why && <Callout tone="warning">{s.why}</Callout>}
          <div className="fx-actions">
            {!s.running ? (
              <Button
                variant="primary"
                icon="monitor"
                disabled={!s.canSetUp}
                loading={busy === 'on'}
                onClick={() =>
                  void confirm({
                    title: 'Set up remote desktop?',
                    body: `FBRX installs xrdp with ${s.manager}${s.desktops.length ? '' : ' (and a light desktop, Xfce, since this computer has none)'}, starts it, and where a firewall is on lets in only your local networks. The system asks for an administrator's password. It can take a few minutes.`,
                    confirmLabel: 'Set it up',
                  }).then((ok) => ok && set(true))
                }
              >
                {s.installed ? 'Turn on' : 'Set up remote desktop'}
              </Button>
            ) : (
              <Button variant="danger" icon="x" loading={busy === 'off'} onClick={() => set(false)}>
                Turn off
              </Button>
            )}
          </div>
          {dialog}
          <p className="fx-muted">Where FBRX runs as root on a server, an administrator can also set it up from FBRX Command. FBRX’s own Remote screen (Mesh and FBRX Command) is for seeing the screen of the person here, with their yes.</p>
        </>
      )}
    </Card>
  );
}
