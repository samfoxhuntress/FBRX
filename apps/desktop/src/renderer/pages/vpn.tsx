import { useState } from 'react';
import type { VpnCheck, VpnProfile, VpnStatus } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, formatBytes, Input, KeyValue, Modal, Page, Status, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { bridge, call } from '../client';
import { useCore } from '../hooks';
import { navigate } from '../app';

/**
 * FBRX VPN: this computer's tunnel to your FBRX Gate, so home (your FBRX Server and its AI, the network behind the
 * gate) is reachable from anywhere. The gate makes each device's settings; this page keeps them and connects.
 */
export function VpnPage() {
  const st = useCore('vpn.status', undefined, ['vpn.changed']);
  const [adding, setAdding] = useState(false);
  const s = st.data;
  return (
    <Page
      title="FBRX VPN"
      description="Reach home from anywhere: your FBRX Server, its AI and your network, through your FBRX Gate."
      actions={
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add your gate
        </Button>
      }
    >
      {!s ? (
        st.error ? <Callout tone="critical" title="FBRX VPN did not answer">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {!s.driver.ready && <Driver s={s} reload={st.reload} />}
          {s.state === 'error' && s.message && <Callout tone="critical" title="The tunnel did not start">{s.message}</Callout>}
          {s.profiles.length === 0 ? (
            <Card title="Connect to your FBRX Gate">
              <ol className="vpn-steps">
                <li>
                  In your FBRX Server’s console, open <b>Gate → DNS &amp; VPN</b> and choose <b>Add a device</b>. Name it after this computer and pick <b>Only home</b> (or <b>Everything</b>, safer on public Wi-Fi), then commit the change.
                </li>
                <li>Copy the settings it shows (or download the settings file): they are shown only once.</li>
                <li>
                  Here, choose <b>Add your gate</b> and paste them (or pick the file).
                </li>
              </ol>
              <p className="fx-muted" style={{ fontSize: 12.5 }}>
                Behind another router at home, forward UDP 51820 to the gate. The gate needs an address on the internet that does not change, or a name that follows it.
              </p>
            </Card>
          ) : (
            s.profiles.map((p) => <Profile key={p.id} p={p} s={s} reload={st.reload} />)
          )}
        </>
      )}
      {adding && <AddGate onClose={() => setAdding(false)} onAdded={() => (setAdding(false), st.reload())} />}
    </Page>
  );
}

function Driver({ s, reload }: { s: VpnStatus; reload: () => void }) {
  const { run, busy } = useAction();
  return (
    <Callout
      tone="warning"
      title="This computer cannot run the tunnel yet"
      actions={
        s.driver.canInstall && (
          <Button size="sm" variant="primary" loading={busy === 'install'} onClick={() => void run('install', () => call('vpn.install').then(reload), 'The VPN tools are installed')}>
            Install them
          </Button>
        )
      }
    >
      {s.driver.why}
    </Callout>
  );
}

function Profile({ p, s, reload }: { p: VpnProfile; s: VpnStatus; reload: () => void }) {
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [check, setCheck] = useState<VpnCheck | null>(null);
  const on = s.connected === p.id && s.state === 'on';
  const connecting = s.state === 'connecting' && busy === 'connect';
  const remove = async () => {
    if (await confirm({ title: `Remove ${p.name}?`, body: 'Its settings (and keys) are deleted from this computer. To connect again, add the device once more on the gate.', confirmLabel: 'Remove', danger: true })) {
      await run('remove', () => call('vpn.remove', { id: p.id }).then(reload));
    }
  };
  return (
    <Card
      title={p.name}
      subtitle={p.endpoint}
      actions={
        on ? (
          <Button loading={busy === 'disconnect'} onClick={() => void run('disconnect', () => call('vpn.disconnect').then(reload))}>
            Disconnect
          </Button>
        ) : (
          <Button variant="primary" icon="lock" disabled={!s.driver.ready} loading={connecting || busy === 'connect'} onClick={() => void run('connect', () => call('vpn.connect', { id: p.id }).then(reload), `Connected to ${p.name}`)}>
            Connect
          </Button>
        )
      }
    >
      <KeyValue
        items={[
          ['State', on ? <Status tone="good">Connected{s.since ? ` · ${timeAgo(s.since)}` : ''}</Status> : <Status tone="neutral">Not connected</Status>],
          ['This computer in the tunnel', <code key="a">{p.address}</code>],
          ['Goes through home', p.fullTunnel ? 'Everything (safer on public Wi-Fi)' : p.networks.join(', ')],
          ...(on && s.received !== null ? ([['Through the tunnel', `${formatBytes(s.received)} in, ${formatBytes(s.sent ?? 0)} out`]] as Array<[string, string]>) : []),
        ]}
      />
      {check && <CheckResult c={check} />}
      <div className="fx-actions">
        <Button size="sm" icon="activity" disabled={!on} loading={busy === 'check'} onClick={() => void run('check', () => call('vpn.check').then(setCheck))} title="Pings the gate and your FBRX computers behind it, and asks them over FBRX Mesh">
          Check home
        </Button>
        <Button size="sm" variant="ghost" icon="server" onClick={() => navigate('server')}>
          Your servers
        </Button>
        <Button size="sm" variant="ghost" icon="trash" loading={busy === 'remove'} onClick={() => void remove()}>
          Remove
        </Button>
      </div>
      {dialog}
    </Card>
  );
}

function CheckResult({ c }: { c: VpnCheck }) {
  const ms = (v: number | null) => (v === null ? '' : ` · ${Math.round(v)} ms`);
  return (
    <div className="vpn-check">
      {c.gate && (
        <div>
          <Status tone={c.gate.ok ? 'good' : 'critical'}>
            The gate ({c.gate.address}){c.gate.ok ? ms(c.gate.ms) : ': no answer'}
          </Status>
        </div>
      )}
      {c.computers.map((x) => (
        <div key={x.id}>
          <Status tone={x.ok || x.mesh ? 'good' : 'warning'}>
            {x.name} ({x.address}){x.ok ? ms(x.ms) : ': no answer to ping'}
            {x.mesh ? ' · FBRX Mesh answers' : ''}
            {x.roles.includes('ai') && x.mesh ? ' · its AI can help here' : ''}
          </Status>
        </div>
      ))}
      {!c.computers.length && <p className="fx-muted">None of your paired FBRX computers has an address behind this tunnel. Pair them at home first (Mesh &amp; phone).</p>}
    </div>
  );
}

function AddGate({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('Home');
  const [text, setText] = useState('');
  const { run, busy } = useAction();
  const fromFile = async () => {
    const path = await bridge.dialog?.({ kind: 'file', title: 'The settings file from your FBRX Gate', filters: [{ name: 'VPN settings', extensions: ['conf'] }] });
    if (path) await run('add', () => call('vpn.add', { name, path }).then(onAdded), 'Saved');
  };
  return (
    <Modal
      title="Add your gate"
      onClose={onClose}
      footer={
        <>
          {bridge.dialog && (
            <Button variant="ghost" icon="file" onClick={() => void fromFile()}>
              Pick the file…
            </Button>
          )}
          <Button variant="primary" disabled={text.trim().length < 20} loading={busy === 'add'} onClick={() => void run('add', () => call('vpn.add', { name, settings: text }).then(onAdded), 'Saved')}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="The settings from your gate" help="Gate → DNS & VPN → Add a device, in your FBRX Server’s console. They are kept encrypted with the Vault.">
          <TextArea code rows={11} value={text} onChange={(e) => setText(e.target.value)} placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.99.0.2/32\n…'} spellCheck={false} />
        </Field>
      </div>
    </Modal>
  );
}
