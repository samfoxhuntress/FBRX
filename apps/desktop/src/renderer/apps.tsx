import { DIGGER_ICON_SVG, FBRX_APPS, TIER_SHORT, handoffFor, type AppId, type AppStatus } from '@fbrx/shared';
import { Button, Card, Icons, Status, useAction } from '@fbrx/ui';
import { call, openExternal } from './client';
import { useCore } from './hooks';
import { navigate } from './app';

/**
 * The FBRX app family, as the Endpoint shows it: Settings → FBRX apps, and the hand-off on a page another app has taken
 * (the Network Center's Digger tab). Open starts an installed app, Get goes to its download, and a lighter edition
 * says which one it needs.
 */

/** Where every app's release is, when release.json has not named one yet. */
const RELEASES = 'https://github.com/samfoxhuntress/FBRX/releases';

export function useApps() {
  return useCore('apps.list', undefined, ['license.changed', 'release.changed'], 30_000);
}

/** An app's icon: Digger's mole, FBRX's mark for the Endpoint, a lettered tile for the apps still to come. */
export function AppIcon({ id, size = 40 }: { id: AppId; size?: number }) {
  if (id === 'digger') return <span className="app-icon" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: DIGGER_ICON_SVG }} aria-hidden />;
  return (
    <span className={`app-icon tile ${id}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {id === 'os' ? 'FB' : FBRX_APPS[id].short[0]}
    </span>
  );
}

function AppAction({ app }: { app: AppStatus }) {
  const { run, busy } = useAction();
  if (app.self) return <Status tone="good">This app</Status>;
  if (!app.built) return <Status tone="neutral">Arrives in {app.since}</Status>;
  if (!app.unlocked)
    return (
      <Button size="sm" variant="ghost" icon="sparkles" onClick={() => navigate('settings/edition')}>
        Needs {TIER_SHORT[app.edition]}
      </Button>
    );
  if (app.installed)
    return (
      <Button size="sm" icon="external" loading={busy === app.id} onClick={() => void run(app.id, () => call('apps.open', { id: app.id }))}>
        Open {app.short}
      </Button>
    );
  return (
    <Button size="sm" variant="primary" icon="download" onClick={() => openExternal(app.download ?? RELEASES)}>
      Get {app.short}
    </Button>
  );
}

/** Settings → FBRX apps. */
export function FbrxAppsSettings() {
  const { data } = useApps();
  return (
    <Card title="FBRX apps" subtitle="One family of apps from FBRX: one license and one AI across all of them. Your edition unlocks each app; Fabrix, your vault and your saved connections are shared.">
      <div className="app-list">
        {(data ?? []).map((a) => (
          <div key={a.id} className={`app-row${a.built ? '' : ' planned'}`}>
            <AppIcon id={a.id} />
            <div className="app-row-text">
              <div className="app-row-name">
                {a.name}
                {a.installed && !a.self && a.version && <span className="fx-muted"> {a.version}</span>}
                {a.edition !== 'essentials' && a.id !== 'os' && <span className="app-row-edition">{TIER_SHORT[a.edition]}</span>}
              </div>
              <div className="app-row-what">{a.what}</div>
            </div>
            <div className="app-row-action">
              <AppAction app={a} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** What FBRX Digger adds, for its tab in the Endpoint's Network Center. */
const DIGGER_ADDS = [
  'Device scans: ping sweep, ARP, mDNS, UPnP and port fingerprints name every PC, phone, printer and camera; compare two scans to see what joined and what left',
  'Consoles: SSH and Telnet to routers, switches and servers, with host keys pinned',
  'Remote desktop and screen sharing (RDP and VNC) from a scan',
  'The Wi-Fi channel planner with every access point, DFS channels and the width to set',
  'Network environments: your network controller’s sites, devices and clients',
];

/** A page another app has taken: what that app does, and Open, Get or the edition it needs. */
export function AppHandoffCard({ page }: { page: string }) {
  const { data } = useApps();
  const { data: lic } = useCore('license.status', undefined, ['license.changed']);
  const installed = (data ?? []).filter((a) => a.installed && !a.self).map((a) => a.id);
  const h = handoffFor(page, { flavor: 'os', tier: lic?.tier ?? 'essentials', installed });
  const app = h && data?.find((a) => a.id === h.app.id);
  if (!h || !app) return null;
  return (
    <Card>
      <div className="app-handoff">
        <AppIcon id={app.id} size={72} />
        <div className="app-handoff-text">
          <h3>{app.name}</h3>
          <p className="fx-muted">
            {app.id === 'digger' ? 'The Network Center on its own, with every network tool. It runs beside FBRX Endpoint, asks Fabrix when you want a hand, and keeps working without it.' : app.what}
          </p>
          {app.id === 'digger' && (
            <ul className="app-handoff-list">
              {DIGGER_ADDS.map((x) => (
                <li key={x}>
                  <Icons.check size={14} /> {x}
                </li>
              ))}
            </ul>
          )}
          <p className="fx-muted" style={{ fontSize: 12.5 }}>
            {h.action === 'open' ? `${app.name} ${app.version ?? ''} is installed on this computer.` : h.action === 'get' ? `Included with your edition. ${app.name} installs beside FBRX Endpoint; this page keeps the everyday checks.` : `${app.name} comes with ${TIER_SHORT[app.edition]}. This page keeps the everyday checks: the full network check, Wi-Fi and speed.`}
          </p>
          <AppAction app={app} />
        </div>
      </div>
    </Card>
  );
}
