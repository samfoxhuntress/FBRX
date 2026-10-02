import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemStatus } from '@fbrx/shared';
import { AdvancedTag, Button, Callout, FBRX_MARK, Icons, Shell, Spinner, Status, useToast, type NavItem } from '@fbrx/ui';
import { bridge, call, onEvent } from './client';
import { isLocked, useCore } from './hooks';
import { playStartupSound, useAppearance } from './theme';
import { AgentNameContext } from './widgets';
import { GooseOverlay, summonGoose, useKonami } from './fun';
import { useConsoleSessions } from './consoles';
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
  | 'spotlight'
  | 'goose'
  | 'goose-overlay';

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

/** Start-up animation: the logo's frame is stitched in like a thread, then the letters appear. */
function Splash() {
  // A window started in the tray (at sign-in) shows the animation when it is first opened.
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setGone(true), 2600);
      return () => clearTimeout(t);
    }
    const onChange = () => document.visibilityState === 'visible' && setVisible(true);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [visible]);
  if (gone || !visible) return null;
  const { frame } = FBRX_MARK;
  return (
    <div className="splash" aria-hidden>
      <div>
        <svg className="splash-logo" viewBox={`0 0 ${FBRX_MARK.size} ${FBRX_MARK.size}`} width={116} height={116}>
          <rect className="splash-frame" x={frame.x} y={frame.y} width={frame.side} height={frame.side} rx={frame.radius} strokeWidth={frame.stroke} />
          <path className="splash-letters" d={FBRX_MARK.letters} fillRule="evenodd" />
        </svg>
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
  if (route === 'goose-overlay') return <GooseOverlay />;
  return <MainApp route={route} settings={settings} />;
}

function MainApp({ route, settings }: { route: Route; settings: ReturnType<typeof useCore<'settings.get'>>['data'] }) {
  const toast = useToast();
  const { data: status } = useCore('system.status', undefined, ['service.changed', 'vault.changed', 'fleet.changed', 'license.changed', 'approval.requested', 'approval.resolved', 'runtime.changed'], 15_000);
  const { data: alertCounts } = useCore('alerts.counts', undefined, ['alerts.changed'], 60_000);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  // First start of this window: show the start-up animation and play the start-up sound once.
  const [firstStart] = useState(() => !sessionStorage.getItem('fbrx.splashShown'));
  const startupSound = settings?.settings.appearance.splashSound;
  const soundDone = useRef(false);
  useEffect(() => {
    if (!firstStart || soundDone.current || startupSound === undefined) return;
    soundDone.current = true;
    if (startupSound) playStartupSound();
  }, [firstStart, startupSound]);

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
  const fun = settings?.settings.appearance.easterEggs ?? false;
  useKonami(
    fun,
    useCallback(() => {
      summonGoose();
      toast.success('Cheat code accepted', '30 extra lives. Also, a goose.');
    }, [toast]),
  );
  // Seven quick clicks on the logo: the loom spins.
  const [weaving, setWeaving] = useState(false);
  const logoClicks = useRef<number[]>([]);
  const onBrandClick = () => {
    if (!fun) return;
    const now = Date.now();
    logoClicks.current = [...logoClicks.current.filter((t) => now - t < 2500), now];
    if (logoClicks.current.length >= 7) {
      logoClicks.current = [];
      setWeaving(true);
      setTimeout(() => setWeaving(false), 2400);
      toast.success('You found the loom', 'Achievement unlocked: Master Weaver.');
    }
  };
  // "goose" (from Spotlight or a link) releases the goose and goes back to where you were.
  useEffect(() => {
    if (route !== 'goose') return;
    summonGoose();
    window.history.back();
  }, [route]);

  if (!settings || !status) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  const s = settings.settings;
  const showSplash = firstStart && s.appearance.splash;
  if (!s.general.onboardingComplete || forceOnboarding) {
    return <Onboarding status={status} onDone={() => setForceOnboarding(false)} />;
  }
  const advanced = s.appearance.advancedMode;
  const agentName = s.ai.agentName;

  const nav: NavItem[] = [
    { id: 'home', label: 'Dashboard', icon: 'dashboard', section: 'Command' },
    { id: 'agent', label: agentName, icon: 'sparkles', section: 'Command' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', count: alertCounts?.unread, section: 'Command' },
    { id: 'tasks', label: 'Tasks', icon: 'tasks', section: 'Workspace' },
    { id: 'notes', label: 'Notes', icon: 'note', section: 'Workspace' },
    { id: 'projects', label: 'Projects', icon: 'layers', section: 'Workspace' },
    { id: 'snippets', label: 'Snippets', icon: 'code', section: 'Workspace' },
    { id: 'storage', label: 'Storage', icon: 'drive', section: 'PC care' },
    { id: 'security', label: 'Security', icon: 'shield', section: 'PC care' },
    { id: 'updates', label: 'Updates', icon: 'download', section: 'PC care' },
    { id: 'bugs', label: 'Bug catcher', icon: 'bug', section: 'PC care' },
    { id: 'network', label: 'Network Center', icon: 'network', section: 'PC care' },
    { id: 'files', label: 'Files', icon: 'folder', section: 'Utilities' },
    { id: 'processes', label: 'Processes', icon: 'activity', section: 'Utilities' },
    { id: 'toolbox', label: 'Toolbox', icon: 'toolbox', section: 'Utilities' },
    { id: 'library', label: 'Library', icon: 'book', section: 'Utilities' },
    { id: 'mesh', label: 'Mesh & phone', icon: 'phone', section: 'Connect' },
    { id: 'runtime', label: 'AI models', icon: 'cpu', section: 'Connect' },
    { id: 'aicoord', label: 'AI coordination', icon: 'zap', section: 'Connect' },
    { id: 'connections', label: 'Connections', icon: 'link', section: 'Connect' },
    { id: 'tools', label: 'Tools & plugins', icon: 'wrench', section: 'Connect' },
    { id: 'approvals', label: 'Approvals', icon: 'check', count: status.pendingApprovals, section: 'Protect' },
    { id: 'vault', label: 'Credentials', icon: 'key', section: 'Protect' },
    { id: 'governance', label: 'Governance', icon: 'shield', section: 'Protect' },
    { id: 'backup', label: 'Backup & restore', icon: 'archive', section: 'Protect' },
    // Technical tools: only in Advanced mode (Settings → General, or the Advanced switch in the top bar).
    ...(advanced
      ? [
          { id: 'terminal', label: 'Terminal', icon: 'terminal' as const, section: 'Advanced' },
          { id: 'lab', label: 'Virtual lab', icon: 'box' as const, section: 'Advanced' },
        ]
      : []),
    { id: 'fleet', label: 'Organization', icon: 'globe', section: 'System' },
    { id: 'settings', label: 'Settings', icon: 'settings', section: 'System' },
  ];
  const setAdvanced = (on: boolean) => void call('settings.update', { patch: { appearance: { advancedMode: on } } }).then(() => toast.info(on ? 'Advanced mode on' : 'Basic mode', on ? 'Expert tools are now in the sidebar under Advanced, marked with an Advanced tag.' : 'Expert tools are hidden.'));
  const advancedLocked = isLocked(settings.locked, 'appearance.advancedMode');

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
        return <BugsPage agentName={agentName} advanced={advanced} />;
      case 'lab':
        return advanced ? <LabPage /> : <AdvancedOnly title="Virtual lab" onEnable={() => setAdvanced(true)} locked={advancedLocked} />;
      case 'network':
        return <NetworkPage advanced={advanced} />;
      case 'files':
        return <FilesPage />;
      case 'processes':
        return <ProcessesPage />;
      case 'terminal':
        return advanced ? <TerminalPage easterEggs={s.appearance.easterEggs} /> : <AdvancedOnly title="Terminal" onEnable={() => setAdvanced(true)} locked={advancedLocked} />;
      case 'toolbox':
        return <ToolboxPage advanced={advanced} easterEggs={s.appearance.easterEggs} />;
      case 'library':
        return <LibraryPage agentName={agentName} advanced={advanced} />;
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
        return <DashboardPage status={status} agentName={agentName} easterEggs={s.appearance.easterEggs} />;
    }
  })();

  return (
    <AgentNameContext.Provider value={agentName}>
      {showSplash && <Splash />}
      <Shell
        brandSub={status.deviceName}
        onBrandClick={onBrandClick}
        brandClassName={weaving ? 'weaving' : undefined}
        nav={nav}
        active={route}
        onNavigate={(id) => navigate(id)}
        topbar={<TopBar route={route} status={status} agentName={agentName} critical={alertCounts?.critical ?? 0} spotlightKey={s.spotlight.enabled ? s.spotlight.hotkey : null} advanced={advanced} advancedLocked={advancedLocked} onAdvanced={setAdvanced} defaultProvider={s.ai.defaultProvider} defaultModel={s.ai.defaultModel} />}
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
    </AgentNameContext.Provider>
  );
}

function TopBar({
  route,
  status,
  agentName,
  critical,
  spotlightKey,
  advanced,
  advancedLocked,
  onAdvanced,
  defaultProvider,
  defaultModel,
}: {
  route: Route;
  status: SystemStatus;
  agentName: string;
  critical: number;
  spotlightKey: string | null;
  advanced: boolean;
  advancedLocked: boolean;
  onAdvanced: (on: boolean) => void;
  defaultProvider: string;
  defaultModel: string;
}) {
  const failing = status.services.filter((s) => s.state === 'failed');
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed'], 60_000);
  const consoles = useConsoleSessions();
  const openConsoles = (consoles.data ?? []).filter((c) => c.state === 'open').length;
  const p = providers.data?.find((x) => x.id === defaultProvider);
  const model = defaultModel || p?.defaultModel || null;
  return (
    <>
      {bridge.platform === 'darwin' && <span style={{ width: 60 }} />}
      <button className="topbar-search" onClick={() => bridge.showSpotlight?.()} title="Spotlight: search apps, files, settings and more from anywhere">
        <Icons.search size={15} />
        <span>Search apps, files, settings, or ask {agentName}…</span>
        {spotlightKey && <kbd className="kbd">{spotlightKey.replace('CommandOrControl', 'Ctrl')}</kbd>}
      </button>
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
      {status.fleet.state !== 'unenrolled' && (
        <span className="fx-muted" style={{ fontSize: 12 }}>
          {status.fleet.tenantName ?? 'Organization'} · {status.fleet.state}
        </span>
      )}
      <span className="fx-spacer" />
      {openConsoles > 0 && route !== 'terminal' && (
        <button className="model-pill console-pill" onClick={() => navigate('terminal/console')} title="Device consoles that are connected">
          <span className="dot ok" aria-hidden />
          {openConsoles} console{openConsoles > 1 ? 's' : ''}
        </button>
      )}
      {status.activeRuns > 0 && <Status tone="busy">{agentName} working</Status>}
      {status.pendingApprovals > 0 && (
        <Button size="sm" variant="primary" icon="shield" onClick={() => navigate('approvals')}>
          {status.pendingApprovals} approval{status.pendingApprovals > 1 ? 's' : ''} waiting
        </Button>
      )}
      <button
        className={`mode-pill${advanced ? ' on' : ''}`}
        role="switch"
        aria-checked={advanced}
        disabled={advancedLocked}
        onClick={() => onAdvanced(!advanced)}
        title={advancedLocked ? 'Set by your organization' : advanced ? 'Advanced mode: expert tools are shown. Click for Basic mode.' : 'Basic mode. Click to show expert tools (Advanced mode).'}
      >
        <span className="mode-pill-knob" aria-hidden />
        Advanced
      </button>
      <button className="model-pill" onClick={() => navigate('runtime')} title={p ? `${p.name}: ${p.available ? 'ready' : (p.message ?? 'not available')}. Click to choose a model.` : 'Choose a model'}>
        <span className={`dot ${p?.available ? 'ok' : 'bad'}`} aria-hidden />
        {model ? <span className="mono">{model}</span> : <span>{p?.name ?? 'Choose a model'}</span>}
      </button>
      {/* The one general "Ask" button in the app; pages only add buttons that ask about something specific. */}
      {route !== 'agent' && (
        <Button size="sm" variant="primary" icon="sparkles" onClick={() => navigate('agent')}>
          Ask {agentName}
        </Button>
      )}
    </>
  );
}

/** Shown for an Advanced-mode page while in Basic mode. */
function AdvancedOnly({ title, onEnable, locked }: { title: string; onEnable: () => void; locked: boolean }) {
  return (
    <div className="fx-page">
      <div className="fx-page-header">
        <div>
          <h1>
            {title} <AdvancedTag />
          </h1>
          <p>This is an expert tool, shown in Advanced mode.</p>
        </div>
      </div>
      <Callout tone="info" title="Turn on Advanced mode to use it" actions={<Button size="sm" variant="primary" disabled={locked} onClick={onEnable}>Turn on Advanced mode</Button>}>
        Advanced mode adds technical tools such as the Terminal, the virtual lab, disk partitions, Defender settings, network adapters and the developer tools in the Toolbox. Each is marked with an Advanced tag.
      </Callout>
    </div>
  );
}
