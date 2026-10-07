import type { ReactNode } from 'react';
import type { GateConfig, GateIssue, NetworkPurpose } from '@fbrx/gate';
import { Callout, Card, CopyText, Empty, Page } from '@fbrx/ui';
import { useGate, type GateInfo } from '../gate-state';
import { useApp } from '../state';

export const PURPOSE_WORDS: Record<NetworkPurpose, string> = { lan: 'Your network', guest: 'Guests', mesh: 'Mesh (FBRX computers)', servers: 'Servers', iot: 'Smart devices', management: 'Management', other: 'Other' };
export const ACCESS_WORDS: Record<GateConfig['networks'][number]['access'], string> = { full: 'Everything', internet: 'The internet only', isolated: 'Nothing outside' };

/** Zones in rules: a network's name, or one of these. */
export function zoneWords(zone: string, c?: GateConfig): string {
  if (zone === 'wan') return 'Internet';
  if (zone === 'vpn') return 'VPN devices';
  if (zone === 'gate') return 'The gate';
  if (zone === 'any') return 'Anywhere';
  const n = c?.networks.find((x) => x.name === zone);
  // "guest", "mesh2"; a name that does not say what it is gets its kind: "cams (Smart devices)".
  return n && !n.name.startsWith(n.purpose === 'management' ? 'mgmt' : n.purpose) ? `${n.name} (${PURPOSE_WORDS[n.purpose]})` : zone;
}

/** Bits per second, the way internet lines are sold. */
export function bitRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null) return '—';
  const b = bytesPerSecond * 8;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} Gb/s`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mb/s`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kb/s`;
  return `${Math.round(b)} b/s`;
}

/** A short id for a new rule or forward, not taken yet. */
export function newId(base: string, taken: string[]): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';
  let id = stem;
  for (let n = 2; taken.includes(id); n++) id = `${stem}-${n}`;
  return id;
}

/** Problems found in what is being edited, under a form. */
export function IssueList({ errors, warnings }: { errors: GateIssue[]; warnings?: GateIssue[] }) {
  if (!errors.length && !warnings?.length) return null;
  return (
    <div className="gt-issues">
      {errors.map((e, i) => (
        <div key={`e${i}`} className="gt-issue error">
          <b>{e.message}</b> <span className="mono fx-muted">{e.path}</span>
        </div>
      ))}
      {warnings?.map((w, i) => (
        <div key={`w${i}`} className="gt-issue warning">
          {w.message} <span className="mono fx-muted">{w.path}</span>
        </div>
      ))}
    </div>
  );
}

/** A gate page: waits for the gate, or says how to add the role. */
export function GatePage({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: (info: GateInfo) => ReactNode }) {
  const app = useApp();
  const g = useGate();
  if (!app.has('gate'))
    return (
      <Page title={title}>
        <Card title="This server is not a gate">
          <p className="fx-secondary">
            FBRX Gate is FBRX Server's <b>gate</b> role: routing, the firewall, VLANs, addresses and names for your devices, a VPN, and traffic priority (Prefer Mesh). Add it on the server, naming the port that goes to the internet and the one to your network:
          </p>
          <CopyText value="sudo ./install.sh --roles virtual,gate --gate-wan eno1 --gate-lan eno2" />
        </Card>
      </Page>
    );
  return (
    <Page title={title} description={description} actions={g.info && actions}>
      {g.error && !g.info ? (
        <Callout tone="critical" title="FBRX Gate does not answer">
          {g.error}
        </Callout>
      ) : !g.info ? (
        <Empty title="Loading…" />
      ) : (
        children(g.info)
      )}
    </Page>
  );
}

/** The VPN tunnel's addresses a device may use, and the gate's own. */
export const vpnGateAddress = (c: GateConfig) => c.vpn.address.split('/')[0];
