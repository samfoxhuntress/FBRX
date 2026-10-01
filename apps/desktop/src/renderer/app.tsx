import { useEffect, useState } from 'react';
import type { SystemStatus } from '@fbrx/shared';
import { Button, Shell, Spinner, Status, useToast, type NavItem } from '@fbrx/ui';
import { bridge, onEvent } from './client';
import { useCore } from './hooks';
import { playChime, useAppearance } from './theme';
import { DashboardPage } from './pages/dashboard';
import { AgentPage } from './pages/agent';
import { ApprovalsPage } from './pages/approvals';
import { ToolsPage } from './pages/tools';
import { ConnectionsPage } from './pages/connections';
import { VaultPage } from './pages/vault';
import { GovernancePage } from './pages/governance';
import { RuntimePage } from './pages/runtime';
import { BackupPage } from './pages/backup';
import { FleetPage } from './pages/fleet';
import { SettingsPage } from './pages/settings';
import { Onboarding } from './pages/onboarding';
import { TasksPage } from './pages/tasks';
import { NotesPage } from './pages/notes';
import { ProjectsPage } from './pages/projects';
import { SnippetsPage } from './pages/snippets';
import { FilesPage } from './pages/files';
import { ProcessesPage } from './pages/processes';
import { TerminalPage } from './pages/terminal';
import { ToolboxPage } from './pages/toolbox';
import { LibraryPage } from './pages/library';
import { AlertsPage } from './pages/alerts';
import { StoragePage } from './pages/storage';
import { NetworkPage } from './pages/network';
import { SecurityPage } from './pages/security';
import { UpdatesPage } from './pages/updates';
import { BugsPage } from './pages/bugs';
import { LabPage } from './pages/lab';
import { MeshPage } from './pages/mesh';
import { AiCoordPage } from './pages/aicoord';
import { SpotlightView } from './pages/spotlight';

export type Route =
  | 'home'
  | 'agent'
  | 'alerts'
  | 'tasks'
  | 'notes'
  | 'projects'
  | 'snippets'
  | 'storage'
  | 'security'
  | 'updates'
  | 'bugs'
  | 'lab'
  | 'network'
  | 'files'
  | 'processes'
  | 'terminal'
  | 'toolbox'
  | 'library'
  | 'mesh'
  | 'aicoord'
  | 'connections'
  | 'tools'
  | 'runtime'
  | 'approvals'
  | 'vault'
  | 'governance'
  | 'backup'
  | 'fleet'
  | 'settings'
  | 'spotlight';

/** Navigates to a page; `to` may carry a sub-path such as `notes/note_123` or `settings/appearance`. */
export function navigate(to: string) {
  location.hash = `#/${to}`;
}

/** The part of the route after the page name (`notes/abc` → `abc`). */
export function routeArg(): string | null {
  return location.hash.replace(/^#\/?/, '').split('/').slice(1).join('/') || null;
}

function useRoute(): Route {
  const parse = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home') as Route;
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    const off = bridge.onNavigate?.((to) => navigate(to));
    return () => {
      window.removeEventListener('hashchange', on);
      off?.();
    };
  }, []);
  return r;
}

export const IS_WINDOWS = bridge.platform === 'win32';

function Splash({ sound }: { sound: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (sound) playChime();
    const t = setTimeout(() => setGone(true), 1800);
    return () => clearTimeout(t);
  }, [sound]);
  if (gone) return null;
  return (
    <div className="splash" aria-hidden>
      <div>
        <div className="splash-mark" />
        <div className="splash-word">FBRX OS</div>
        <div className="splash-sub">Fabrics Operating System</div>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { data: settings } = useCore('settings.get', undefined, ['settings.changed']);
  useAppearance(settings?.settings);
  if (route === 'spotlight') return settings ? <SpotlightView agentName={settings.settings.ai.agentName} /> : null;
  return <MainApp route={route} settings={settings} />;
}

function MainApp({ route, settings }: { route: Route; settings: ReturnType<typeof useCore<'settings.get'>>['data'] }) {
  const toast = useToast();
  const { data: status } = useCore('system.status', undefined, ['service.changed', 'vault.changed', 'fleet.changed', 'license.changed', 'approval.requested', 'approval.resolved', 'runtime.changed'], 15_000);
  const { data: alertCounts } = useCore('alerts.counts', undefined, ['alerts.changed'], 60_000);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [splash] = useState(() => !sessionStorage.getItem('fbrx.splashShown'));

  useEffect(() => {
    sessionStorage.setItem('fbrx.splashShown', '1');
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        bridge.showSpotlight?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => onEvent('notification', (n) => toast[n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : n.level === 'success' ? 'success' : 'info'](n.title, n.body)), [toast]);

  if (!settings || !status) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  const s = settings.settings;
  const showSplash = splash && s.appearance.splash;
  if (!s.general.onboardingComplete || forceOnboarding) {
    return <Onboarding status={status} onDone={() => setForceOnboarding(false)} />;
  }
  const advanced = s.appearance.advancedMode;
  const agentName = s.ai.agentName;

  const nav: NavItem[] = [
    { id: 'home', label: 'Dashboard', icon: 'dashboard' },
    { id: 'agent', label: agentName, icon: 'sparkles' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', count: alertCounts?.unread },
    { id: 'tasks', label: 'Tasks', icon: 'tasks', section: 'Workspace' },
    { id: 'notes', label: 'Notes', icon: 'note', section: 'Workspace' },
    { id: 'projects', label: 'Projects', icon: 'layers', section: 'Workspace' },
    { id: 'snippets', label: 'Snippets', icon: 'code', section: 'Workspace' },
    { id: 'storage', label: 'Storage', icon: 'drive', section: 'PC care' },
    { id: 'security', label: 'Security', icon: 'shield', section: 'PC care' },
    { id: 'updates', label: 'Updates', icon: 'download', section: 'PC care' },
    { id: 'bugs', label: 'Bug catcher', icon: 'bug', section: 'PC care' },
    ...(advanced ? [{ id: 'lab', label: 'Virtual lab', icon: 'box' as const, section: 'PC care' }] : []),
    { id: 'network', label: 'Network Center', icon: 'network', section: 'PC care' },
    { id: 'files', label: 'Files', icon: 'folder', section: 'Utilities' },
    { id: 'processes', label: 'Processes', icon: 'activity', section: 'Utilities' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', section: 'Utilities' },
    { id: 'toolbox', label: 'Toolbox', icon: 'toolbox', section: 'Utilities' },
    { id: 'library', label: 'Library', icon: 'book', section: 'Utilities' },
    { id: 'mesh', label: 'Mesh & phone', icon: 'phone', section: 'Connect' },
    { id: 'aicoord', label: 'AI coordination', icon: 'zap', section: 'Connect' },
    { id: 'connections', label: 'Connections', icon: 'link', section: 'Connect' },
    { id: 'tools', label: 'Tools & plugins', icon: 'wrench', section: 'Connect' },
    { id: 'runtime', label: 'AI models', icon: 'cpu', section: 'Connect' },
    { id: 'approvals', label: 'Approvals', icon: 'check', count: status.pendingApprovals, section: 'Protect' },
    { id: 'vault', label: 'Credentials', icon: 'key', section: 'Protect' },
    { id: 'governance', label: 'Governance', icon: 'shield', section: 'Protect' },
    { id: 'backup', label: 'Backup & restore', icon: 'archive', section: 'Protect' },
    { id: 'fleet', label: 'Organisation', icon: 'globe', section: 'System' },
    { id: 'settings', label: 'Settings', icon: 'settings', section: 'System' },
  ];

  const page = (() => {
    switch (route) {
      case 'agent':
        return <AgentPage agentName={agentName} />;
      case 'alerts':
        return <AlertsPage />;
      case 'tasks':
        return <TasksPage />;
      case 'notes':
        return <NotesPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'snippets':
        return <SnippetsPage />;
      case 'storage':
        return <StoragePage advanced={advanced} />;
      case 'security':
        return <SecurityPage advanced={advanced} />;
      case 'updates':
        return <UpdatesPage />;
      case 'bugs':
        return <BugsPage agentName={agentName} />;
      case 'lab':
        return <LabPage />;
      case 'network':
        return <NetworkPage advanced={advanced} />;
      case 'files':
        return <FilesPage />;
      case 'processes':
        return <ProcessesPage />;
      case 'terminal':
        return <TerminalPage />;
      case 'toolbox':
        return <ToolboxPage />;
      case 'library':
        return <LibraryPage agentName={agentName} />;
      case 'mesh':
        return <MeshPage />;
      case 'aicoord':
        return <AiCoordPage agentName={agentName} />;
      case 'approvals':
        return <ApprovalsPage />;
      case 'tools':
        return <ToolsPage />;
      case 'connections':
        return <ConnectionsPage />;
      case 'vault':
        return <VaultPage />;
      case 'governance':
        return <GovernancePage />;
      case 'runtime':
        return <RuntimePage />;
      case 'backup':
        return <BackupPage />;
      case 'fleet':
        return <FleetPage />;
      case 'settings':
        return <SettingsPage onRerunSetup={() => setForceOnboarding(true)} />;
      default:
        return <DashboardPage status={status} agentName={agentName} />;
    }
  })();

  return (
    <>
      {showSplash && <Splash sound={s.appearance.splashSound} />}
      <Shell
        brandSub={status.deviceName}
        nav={nav}
        active={route}
        onNavigate={(id) => navigate(id)}
        topbar={<TopBar status={status} agentName={agentName} critical={alertCounts?.critical ?? 0} spotlightKey={s.spotlight.enabled ? s.spotlight.hotkey : null} />}
        footer={
          <span>
            v{status.version} · {status.license.edition}
            {status.devMode ? ' · dev' : ''}
            {advanced ? ' · advanced' : ''}
          </span>
        }
      >
        {page}
      </Shell>
    </>
  );
}

function TopBar({ status, agentName, critical, spotlightKey }: { status: SystemStatus; agentName: string; critical: number; spotlightKey: string | null }) {
  const failing = status.services.filter((s) => s.state === 'failed');
  return (
    <>
      {bridge.platform === 'darwin' && <span style={{ width: 60 }} />}
      {status.vault.state === 'locked' ? (
        <Status tone="warning">Vault locked</Status>
      ) : failing.length ? (
        <Status tone="critical">{failing.length} service(s) failing</Status>
      ) : (
        <Status tone="good">All systems running</Status>
      )}
      {critical > 0 && (
        <Button size="sm" variant="danger" icon="alert" onClick={() => navigate('alerts')}>
          {critical} critical alert{critical > 1 ? 's' : ''}
        </Button>
      )}
      <span className="fx-muted" style={{ fontSize: 12 }}>
        {status.fleet.state === 'unenrolled' ? 'Standalone' : `${status.fleet.tenantName ?? 'Organisation'} · ${status.fleet.state}`}
      </span>
      <span className="fx-spacer" />
      {status.activeRuns > 0 && <Status tone="busy">{agentName} working</Status>}
      {status.pendingApprovals > 0 && (
        <Button size="sm" variant="primary" icon="shield" onClick={() => navigate('approvals')}>
          {status.pendingApprovals} approval{status.pendingApprovals > 1 ? 's' : ''} waiting
        </Button>
      )}
      {spotlightKey && (
        <span className="fx-muted" style={{ fontSize: 12 }} title="Spotlight: search apps, files, settings and more from anywhere">
          <kbd className="kbd">{spotlightKey.replace('CommandOrControl', 'Ctrl')}</kbd> Spotlight
        </span>
      )}
      <Button size="sm" variant="ghost" icon="sparkles" onClick={() => navigate('agent')}>
        Ask {agentName}
      </Button>
    </>
  );
}
