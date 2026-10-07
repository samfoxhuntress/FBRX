import { useEffect, useState } from 'react';
import { JUMBO_MTU, MESH_TRAFFIC_CLASSES, MESH_TRAFFIC_CLASS_WORDS, type MeshTrafficClass } from '@fbrx/shared';
import type { GateConfig } from '@fbrx/gate';
import { Button, Callout, Card, Field, formatBytes, Grid, Input, KeyValue, Select, Status, Toggle } from '@fbrx/ui';
import { draftIssues, useGate } from '../gate-state';
import { useApp, useRoute } from '../state';
import { bitRate, GatePage, IssueList } from './gate-common';

/** Where each traffic class lands in the gate's four priority lanes (cake diffserv4; the HTB fallback has three). */
const LANE: Record<MeshTrafficClass, string> = { cs0: 'Best effort', af21: 'Best effort', af31: 'Best effort', af41: 'Video (second of four)', cs5: 'Voice (first of four)', ef: 'Voice (first of four)' };

/**
 * Traffic priority: the internet line shared fairly (no more slow calls while something uploads), and Prefer Mesh:
 * traffic between FBRX computers (their AI helping each other included) goes first, across the gate and its VLANs.
 */
export function GateTrafficPage() {
  const app = useApp();
  const g = useGate();
  const [, go] = useRoute();
  const admin = app.can('admin');
  return (
    <GatePage title="Traffic & Prefer Mesh" description="Share the internet line fairly, and put traffic between FBRX computers first: when their AI helps each other, it should not wait behind a backup or a download.">
      {(info) => <Traffic config={info.state.candidate} admin={admin} onNetworks={() => go('gate-networks')} marked={Object.entries(g.live?.counters ?? {}).filter(([k]) => k.startsWith('mesh:')).reduce((n, [, v]) => ({ packets: n.packets + v.packets, bytes: n.bytes + v.bytes }), { packets: 0, bytes: 0 })} />}
    </GatePage>
  );
}

function Traffic({ config, admin, onNetworks, marked }: { config: GateConfig; admin: boolean; onNetworks: () => void; marked: { packets: number; bytes: number } }) {
  const g = useGate();
  const [qos, setQos] = useState(() => structuredClone(config.qos));
  const key = JSON.stringify(config.qos);
  useEffect(() => setQos(structuredClone(config.qos)), [key]);
  const pm = qos.preferMesh;
  const next = { ...structuredClone(config), qos };
  const issues = draftIssues(next, (p) => p.startsWith('qos') || p.startsWith('networks'));
  const dirty = JSON.stringify(qos) !== key;
  const meshNets = config.networks.filter((n) => pm.networks.includes(n.name));
  const suggested = config.networks.filter((n) => n.purpose === 'mesh' && !pm.networks.includes(n.name));
  const wanRate = g.rates[config.wan.interface];
  const setPm = (patch: Partial<GateConfig['qos']['preferMesh']>) => setQos({ ...qos, preferMesh: { ...pm, ...patch } });
  return (
    <>
      <Card title="Prefer Mesh" subtitle="Traffic between FBRX computers goes first">
        <div className="gt-pm">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Toggle checked={pm.enabled} onChange={(enabled) => setPm({ enabled })} label="Prefer Mesh" />
            <Grid cols={2}>
              <Field label="Priority" help={`Lands in the ${LANE[pm.trafficClass].toLowerCase()} lane when traffic priority is on.`}>
                <Select value={pm.trafficClass} onChange={(e) => setPm({ trafficClass: e.target.value as MeshTrafficClass })} options={MESH_TRAFFIC_CLASSES.map((c) => ({ value: c, label: MESH_TRAFFIC_CLASS_WORDS[c] }))} />
              </Field>
              <Field label="FBRX Mesh port (TCP)" help="47800 unless you changed it on your computers.">
                <Input type="number" min={1} max={65535} value={pm.port} onChange={(e) => setPm({ port: Number(e.target.value) })} />
              </Field>
            </Grid>
            <Field label="Everything from these networks goes first too" help="A mesh VLAN for your FBRX computers and servers: all their traffic is marked, not just FBRX Mesh's.">
              <div className="vt-chips">
                {config.networks.map((n) => (
                  <button key={n.name} type="button" className={`vt-chip${pm.networks.includes(n.name) ? ' on' : ''}`} onClick={() => setPm({ networks: pm.networks.includes(n.name) ? pm.networks.filter((x) => x !== n.name) : [...pm.networks, n.name] })}>
                    {n.name}
                    {n.purpose === 'mesh' && !n.name.startsWith('mesh') ? ' · mesh' : ''}
                  </button>
                ))}
                {!config.networks.some((n) => n.purpose === 'mesh') && (
                  <Button size="sm" icon="plus" onClick={onNetworks}>
                    Make a mesh VLAN
                  </Button>
                )}
              </div>
            </Field>
          </fieldset>
          <div className="gt-pm-side">
            <KeyValue
              items={[
                ['Marked so far', pm.enabled ? `${formatBytes(marked.bytes)} · ${marked.packets.toLocaleString()} packets` : 'Off'],
                ['Mark', pm.enabled ? `DSCP ${pm.trafficClass.toUpperCase()} on TCP ${pm.port}${meshNets.length ? ` and all of ${meshNets.map((n) => n.name).join(', ')}` : ''}` : '—'],
                [
                  'Jumbo frames',
                  meshNets.length
                    ? meshNets.map((n) => {
                        const i = config.interfaces.find((x) => x.name === n.interface);
                        return (
                          <div key={n.name}>
                            {n.name}: {i && i.mtu >= JUMBO_MTU ? <Status tone="good">MTU {i.mtu}</Status> : <Status tone="neutral">MTU {i?.mtu ?? '—'}</Status>}
                          </div>
                        );
                      })
                    : 'No mesh network yet',
                ],
              ]}
            />
          </div>
        </div>
        {suggested.length > 0 && (
          <Callout tone="info" actions={admin && <Button size="sm" onClick={() => setPm({ networks: [...pm.networks, ...suggested.map((n) => n.name)] })}>Add {suggested.map((n) => n.name).join(', ')}</Button>}>
            {suggested.map((n) => n.name).join(', ')} {suggested.length === 1 ? 'is a mesh network' : 'are mesh networks'}: add {suggested.length === 1 ? 'it' : 'them'} so all {suggested.length === 1 ? 'its' : 'their'} traffic goes first.
          </Callout>
        )}
      </Card>
      <Grid cols={2}>
        <Card title="Traffic priority (the internet line)">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Toggle checked={qos.enabled} onChange={(enabled) => setQos({ ...qos, enabled })} label="Share the line fairly and put priority traffic first" />
            <Grid cols={2}>
              <Field label="Upload (Mb/s)" help="A little under what your line really does (90%).">
                <Input type="number" min={0.1} step={0.1} value={qos.upload} onChange={(e) => setQos({ ...qos, upload: Number(e.target.value) })} />
              </Field>
              <Field label="Download (Mb/s)" help="0 leaves downloads alone.">
                <Input type="number" min={0} step={1} value={qos.download} onChange={(e) => setQos({ ...qos, download: Number(e.target.value) })} />
              </Field>
            </Grid>
            <KeyValue
              items={[
                ['In place now', g.live?.qos.detail ?? (g.info?.state.running?.qos.enabled ? 'Not in place (see the dashboard)' : 'Off')],
                ['Line now', wanRate ? `${bitRate(wanRate.rx)} down · ${bitRate(wanRate.tx)} up` : '—'],
              ]}
            />
          </fieldset>
        </Card>
        <Card title="How mesh traffic is carried">
          <ul className="vt-list">
            <li>
              <b>TCP, kept open.</b> FBRX computers keep one connection to each other (keep-alive) and send at once (no delay), so help between their AIs starts without a handshake each time.
            </li>
            <li>
              <b>Marked at both ends.</b> The gate marks mesh traffic it routes; computers mark what they send with Prefer Mesh in their settings (FBRX Endpoint: Mesh → Prefer Mesh; this server: Mesh & AI → Network).
            </li>
            <li>
              <b>A VLAN of their own.</b> A mesh network keeps them together on one fast lane, with jumbo frames ({JUMBO_MTU}) when every switch and computer on it takes them.
            </li>
            <li>
              <b>Your switches.</b> Let them trust DSCP on the mesh VLAN's ports (or give that VLAN a higher queue) so the priority holds inside your network too.
            </li>
          </ul>
        </Card>
      </Grid>
      <IssueList errors={issues.errors} warnings={issues.warnings} />
      {admin && dirty && (
        <div className="vt-savebar">
          <span>Traffic settings changed</span>
          <span className="fx-spacer" />
          <Button onClick={() => setQos(structuredClone(config.qos))}>Undo</Button>
          <Button variant="primary" disabled={!issues.shapeOk} onClick={() => void g.save(next, 'Traffic settings saved')}>
            Save
          </Button>
        </div>
      )}
    </>
  );
}
