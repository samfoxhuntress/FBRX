import { useState } from 'react';
import { isCidr, MESH_TRAFFIC_CLASSES, MESH_TRAFFIC_CLASS_WORDS, networkOf, type MeshPathTest, type MeshTrafficClass, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Field, Grid, Input, Select, Status, Toggle, useAction } from '@fbrx/ui';
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
  };
  return (
    <Card
      title="Prefer Mesh"
      subtitle="Give the traffic between your computers (Mesh Assist included) its own lane: a network for it, connections that stay open, and a priority mark your switches and FBRX Gate honor."
      actions={<Toggle checked={n.preferMesh} onChange={(v) => set({ preferMesh: v })} label={n.preferMesh ? 'On' : 'Off'} />}
    >
      {managed && <Callout tone="info">Your organization sets some of these.</Callout>}
      <Grid cols={2}>
        <div className="fx-grid">
          <Field label="Mesh networks, in order" help="Computers reach each other through these first, for example a VLAN for AI and servers. The usual network stays the fallback.">
            <div className="fx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {n.subnets.map((c) => (
                <span key={c} className="fx-badge mono">
                  {c}{' '}
                  <button className="pm-x" aria-label={`Remove ${c}`} onClick={() => set({ subnets: n.subnets.filter((x) => x !== c) })}>
                    ×
                  </button>
                </span>
              ))}
              {!n.subnets.length && <span className="fx-muted">None yet</span>}
            </div>
          </Field>
          <div className="fx-row" style={{ gap: 6 }}>
            <div style={{ flex: 1 }}>
              <Input className="mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="10.20.0.0/24" onKeyDown={(e) => e.key === 'Enter' && addSubnet(subnet)} />
            </div>
            <Button size="sm" disabled={!isCidr(subnet.trim())} onClick={() => addSubnet(subnet)}>
              Add
            </Button>
          </div>
          {suggestions.length > 0 && (
            <div className="fx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="fx-muted" style={{ fontSize: 12 }}>This computer is on:</span>
              {suggestions.map((c) => (
                <Button key={c} size="sm" variant="ghost" onClick={() => addSubnet(c)}>
                  + {c}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="fx-grid">
          <Field label="Priority mark (DSCP)" help="Switches and FBRX Gate put marked traffic in a faster queue. AF41 sits below voice calls, so it never drowns them out.">
            <Select value={n.trafficClass} onChange={(e) => set({ trafficClass: e.target.value as MeshTrafficClass })} options={MESH_TRAFFIC_CLASSES.map((c) => ({ value: c, label: MESH_TRAFFIC_CLASS_WORDS[c] }))} />
          </Field>
          <Toggle checked={n.jumbo} onChange={(v) => set({ jumbo: v })} label="The mesh networks use jumbo frames (MTU 9000): check them" />
          <div className="fx-muted" style={{ fontSize: 12 }}>
            Mesh connections are TCP and stay open between requests, with no delay before small packets go out, so a computer helping another answers without a new handshake each time.
          </div>
        </div>
      </Grid>

      {st && (
        <div style={{ marginTop: 14 }} className="fx-grid">
          {st.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          <div className="fx-label">This computer</div>
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
          <div className="fx-list-item">
            <Status tone={st.qos.applied ? 'good' : st.qos.applied === false ? 'warning' : 'neutral'}>{st.qos.applied ? 'marked' : st.qos.applied === false ? 'not marked' : 'unknown'}</Status>
            <span style={{ flex: 1 }}>
              Mesh traffic (TCP port {st.port}) marked {st.trafficClass.toUpperCase()} (DSCP {st.dscp}). <span className="fx-muted">{st.qos.detail}</span>
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
        <div className="fx-row" style={{ justifyContent: 'space-between' }}>
          <div className="fx-label">The way to each computer</div>
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
    </Card>
  );
}
