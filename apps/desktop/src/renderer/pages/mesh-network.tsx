import { useState } from 'react';
import { isCidr, MESH_TRAFFIC_CLASSES, MESH_TRAFFIC_CLASS_WORDS, networkOf, type MeshPathTest, type MeshTrafficClass, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Field, Grid, InfoTip, Input, More, Select, Status, Toggle, useAction } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

type NetSettings = Settings['mesh']['network'];

/**
 * Prefer Mesh on the Mesh & phone page: reach the other computers through a chosen mesh network first (an AI or
 * server VLAN, say), keep those connections open, mark the traffic so switches and FBRX Gate put it first, and check
 * jumbo frames where the network is set up for them.
 */
export function PreferMeshCard() {
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const status = useCore('mesh.network.status', undefined, ['settings.changed']);
  const { run, busy } = useAction();
  const [subnet, setSubnet] = useState('');
  const [adding, setAdding] = useState('');
  const [paths, setPaths] = useState<MeshPathTest[] | null>(null);
  const n = settings.data?.settings.mesh.network;
  const st = status.data;
  const managed = settings.data?.locked.some((k) => k.startsWith('mesh.network') || k === 'mesh') ?? false;
  if (!n) return null;
  const set = (patch: Partial<NetSettings>) => void run('set', () => call('settings.update', { patch: { mesh: { network: patch } } })).then(() => status.reload());
  const suggestions = (st?.local ?? []).map((a) => networkOf(a.cidr)).filter((c, i, all) => all.indexOf(c) === i && !n.subnets.includes(c));
  const addSubnet = (c: string) => {
    const v = c.trim();
    if (!isCidr(v) || n.subnets.includes(v)) return;
    set({ subnets: [...n.subnets, v] });
    setSubnet('');
    setAdding('');
  };
  const typing = adding === '__typed';
  return (
    <Card
      title={
        <span className="fx-field-head">
          Prefer Mesh
          <InfoTip>A fast lane for your FBRX computers: they reach each other through the network you pick first, keep their connections open, and mark their traffic so switches and FBRX Gate send it first. Mesh Assist answers sooner, even during a backup or a big download.</InfoTip>
        </span>
      }
      subtitle="Puts the traffic between your FBRX computers first, so their AI helping each other never waits behind a download or a backup."
      actions={<Toggle checked={n.preferMesh} onChange={(v) => set({ preferMesh: v })} label={n.preferMesh ? 'On' : 'Off'} />}
    >
      {managed && <Callout tone="info">Your organization sets some of these.</Callout>}
      <Field
        label="Networks your computers use to reach each other"
        info="If your computers and servers have their own network (a VLAN for AI and servers, say), add it: they try it first and fall back to the usual network. With none, they use the usual network."
      >
        <div className="fx-row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {n.subnets.map((c) => (
            <span key={c} className="fx-badge mono">
              {c}{' '}
              <button className="pm-x" aria-label={`Remove ${c}`} onClick={() => set({ subnets: n.subnets.filter((x) => x !== c) })}>
                ×
              </button>
            </span>
          ))}
          {!n.subnets.length && <span className="fx-muted">The usual network</span>}
          <Select
            className="pm-add"
            aria-label="Add a network"
            value={typing ? '__typed' : ''}
            onChange={(e) => (e.target.value === '__typed' ? setAdding('__typed') : e.target.value && addSubnet(e.target.value))}
            options={[{ value: '', label: '+ Add a network…', disabled: true }, ...suggestions.map((c) => ({ value: c, label: `${c} (this computer is on it)` })), { value: '__typed', label: 'Type one…' }]}
          />
        </div>
        {typing && (
          <div className="fx-row" style={{ gap: 6, marginTop: 6 }}>
            <div style={{ flex: 1 }}>
              <Input autoFocus className="mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="10.20.0.0/24" onKeyDown={(e) => e.key === 'Enter' && addSubnet(subnet)} />
            </div>
            <Button size="sm" variant="primary" disabled={!isCidr(subnet.trim())} onClick={() => addSubnet(subnet)}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding('')}>
              Cancel
            </Button>
          </div>
        )}
      </Field>

      {st && (
        <div style={{ marginTop: 14 }} className="fx-grid">
          {st.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          <div className="fx-list-item">
            <Status tone={st.qos.applied ? 'good' : st.qos.applied === false ? 'warning' : 'neutral'}>{st.qos.applied ? 'marked' : st.qos.applied === false ? 'not marked' : 'unknown'}</Status>
            <span style={{ flex: 1 }}>
              {st.qos.applied ? 'Mesh traffic leaves this computer marked for the fast lane.' : 'Mesh traffic is not marked yet on this computer.'} <span className="fx-muted">{st.qos.detail}</span>
            </span>
            {st.qos.method !== 'none' && st.qos.canApply && (
              <>
                <Button size="sm" variant="primary" loading={busy === 'qos'} onClick={() => void run('qos', () => call('mesh.network.applyQos', {}), 'Mesh traffic is marked').then(() => status.reload())}>
                  {st.qos.applied ? 'Mark again' : 'Mark mesh traffic'}
                </Button>
                {st.qos.applied && (
                  <Button size="sm" loading={busy === 'unqos'} onClick={() => void run('unqos', () => call('mesh.network.applyQos', { remove: true }), 'Marking removed').then(() => status.reload())}>
                    Stop marking
                  </Button>
                )}
              </>
            )}
          </div>
          {st.qos.script && !st.qos.canApply && (
            <div className="fx-grid" style={{ gap: 6 }}>
              <div className="fx-muted" style={{ fontSize: 12 }}>
                Marking traffic needs administrator rights. Run this as root ({st.qos.method === 'nftables' ? 'save it and run sudo nft -f <file>' : 'in an administrator PowerShell'}), or push it with your device management:
              </div>
              <CopyText value={st.qos.script} />
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="fx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="fx-field-head">
            <span className="fx-label">The way to each computer</span>
            <InfoTip>Test reaches every paired computer and shows whether it went through your mesh network (good) or the usual one, how long a round trip takes, and whether jumbo frames got through.</InfoTip>
          </span>
          <Button size="sm" icon="activity" loading={busy === 'test'} onClick={() => void run('test', () => call('mesh.network.test', {})).then((r) => r && setPaths(r))}>
            Test
          </Button>
        </div>
        {paths && paths.length === 0 && <div className="fx-muted">No paired computers to test.</div>}
        {paths?.map((p) => (
          <div key={p.peerId} className="fx-list-item">
            <Status tone={p.error ? 'critical' : p.preferred ? 'good' : 'warning'}>{p.error ? 'unreachable' : p.preferred ? 'mesh network' : 'usual network'}</Status>
            <strong>{p.peerName}</strong>
            <span className="fx-muted" style={{ flex: 1 }}>
              {p.address ?? '—'}
              {p.rttMs !== null ? ` · ${p.rttMs} ms round trip` : ''}
              {p.jumbo.tested ? ` · ${p.jumbo.detail}` : ''}
              {p.error ? ` · ${p.error}` : ''}
            </span>
          </div>
        ))}
      </div>

      <More label="More settings">
        <Grid cols={2}>
          <Field label="Priority mark" info="A label on each packet (DSCP) that switches and FBRX Gate use to pick a faster queue. AF41, the usual choice, sits just below voice calls so it never drowns them out.">
            <Select value={n.trafficClass} onChange={(e) => set({ trafficClass: e.target.value as MeshTrafficClass })} options={MESH_TRAFFIC_CLASSES.map((c) => ({ value: c, label: MESH_TRAFFIC_CLASS_WORDS[c] }))} />
          </Field>
          <div className="fx-grid" style={{ alignContent: 'end' }}>
            <Toggle checked={n.jumbo} onChange={(v) => set({ jumbo: v })} label="The mesh networks use jumbo frames" info="Turn on only if every switch and computer on the mesh network is set to MTU 9000. FBRX then checks that big packets really get through and warns you where they do not." />
          </div>
        </Grid>
        {st && (
          <div className="fx-grid" style={{ gap: 6 }}>
            <div className="fx-label">This computer’s networks</div>
            {st.local.map((a) => (
              <div key={`${a.iface}${a.address}`} className="fx-list-item">
                <Status tone={a.preferred ? 'good' : 'neutral'}>{a.preferred ? 'mesh network' : 'other network'}</Status>
                <strong className="mono">{a.address}</strong>
                <span className="fx-muted" style={{ flex: 1 }}>
                  {a.iface} · {a.cidr}
                  {a.mtu ? ` · MTU ${a.mtu}` : ''}
                </span>
              </div>
            ))}
            <div className="fx-muted" style={{ fontSize: 12 }}>
              Mesh traffic is TCP port {st.port}, marked {st.trafficClass.toUpperCase()} (DSCP {st.dscp}). Connections stay open between requests and small packets go out without delay, so help starts without a new handshake each time.
            </div>
          </div>
        )}
      </More>
    </Card>
  );
}
