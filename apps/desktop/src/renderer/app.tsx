import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { SystemStatus } from '@fbrx/shared';
import { addressAs, displayVersion, funEnabled } from '@fbrx/shared';
import { AdvancedTag, Button, Callout, FBRX_MARK, Icons, Shell, Spinner, Status, useToast, type IconName, type NavGroup, type NavItem } from '@fbrx/ui';
import { bridge, call, onEvent } from './client';
import { isLocked, useConsoleSessions, useCore } from './hooks';
import { playStartupSound, useAppearance } from './theme';
import { AgentNameContext, EmergencyStop } from './widgets';
import { GooseOverlay, summonGoose, unlockTrophy, useKonami } from './fun';
import { TrophyBadge } from './trophies';
import { DashboardPage } from './pages/dashboard';
import { Onboarding } from './pages/onboarding';
import { VaultStartPrompt } from './vault-lock';
import { UpdatePill } from './release';
import { SpotlightView } from './pages/spotlight';

// Pages load when first opened, so the app starts with only what the first screen needs.
const AgentPage = lazy(() => import('./pages/agent').then((m) => ({ default: m.AgentPage })));
const ApprovalsPage = lazy(() => import('./pages/approvals').then((m) => ({ default: m.ApprovalsPage })));
const ToolsPage = lazy(() => import('./pages/tools').then((m) => ({ default: m.ToolsPage })));
const ConnectionsPage = lazy(() => import('./pages/connections').then((m) => ({ default: m.ConnectionsPage })));
const VaultPage = lazy(() => import('./pages/vault').then((m) => ({ default: m.VaultPage })));
const GovernancePage = lazy(() => import('./pages/governance').then((m) => ({ default: m.GovernancePage })));
const RuntimePage = lazy(() => import('./pages/runtime').then((m) => ({ default: m.RuntimePage })));
const BackupPage = lazy(() => import('./pages/backup').then((m) => ({ default: m.BackupPage })));
const FleetPage = lazy(() => import('./pages/fleet').then((m) => ({ default: m.FleetPage })));
const SettingsPage = lazy(() => import('./pages/settings').then((m) => ({ default: m.SettingsPage })));
const TasksPage = lazy(() => import('./pages/tasks').then((m) => ({ default: m.TasksPage })));
const NotesPage = lazy(() => import('./pages/notes').then((m) => ({ default: m.NotesPage })));
const ProjectsPage = lazy(() => import('./pages/projects').then((m) => ({ default: m.ProjectsPage })));
const SnippetsPage = lazy(() => import('./pages/snippets').then((m) => ({ default: m.SnippetsPage })));
const FilesPage = lazy(() => import('./pages/files').then((m) => ({ default: m.FilesPage })));
const ProcessesPage = lazy(() => import('./pages/processes').then((m) => ({ default: m.ProcessesPage })));
const TerminalPage = lazy(() => import('./pages/terminal').then((m) => ({ default: m.TerminalPage })));
const ToolboxPage = lazy(() => import('./pages/toolbox').then((m) => ({ default: m.ToolboxPage })));
const LibraryPage = lazy(() => import('./pages/library').then((m) => ({ default: m.LibraryPage })));
const AlertsPage = lazy(() => import('./pages/alerts').then((m) => ({ default: m.AlertsPage })));
const StoragePage = lazy(() => import('./pages/storage').then((m) => ({ default: m.StoragePage })));
const NetworkPage = lazy(() => import('./pages/network').then((m) => ({ default: m.NetworkPage })));
const SecurityPage = lazy(() => import('./pages/security').then((m) => ({ default: m.SecurityPage })));
const UpdatesPage = lazy(() => import('./pages/updates').then((m) => ({ default: m.UpdatesPage })));
const BugsPage = lazy(() => import('./pages/bugs').then((m) => ({ default: m.BugsPage })));
const LabPage = lazy(() => import('./pages/lab').then((m) => ({ default: m.LabPage })));
const MeshPage = lazy(() => import('./pages/mesh').then((m) => ({ default: m.MeshPage })));
const AiCoordPage = lazy(() => import('./pages/aicoord').then((m) => ({ default: m.AiCoordPage })));
const MigratePage = lazy(() => import('./pages/migrate').then((m) => ({ default: m.MigratePage })));
const ClipboardPage = lazy(() => import('./pages/clipboard').then((m) => ({ default: m.ClipboardPage })));

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
  | 'migrate'
  | 'clipboard'
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
  if (route === 'spotlight') return settings ? <SpotlightView agentName={settings.settings.ai.agentName} fun={funEnabled(settings.settings)} /> : null;
  if (route === 'goose-overlay') return <GooseOverlay />;
  return <MainApp route={route} settings={settings} />;
}

function MainApp({ route, settings }: { route: Route; settings: ReturnType<typeof useCore<'settings.get'>>['data'] }) {
  const toast = useToast();
  const { data: status } = useCore('system.status', undefined, ['service.changed', 'vault.changed', 'fleet.changed', 'license.changed', 'approval.requested', 'approval.resolved', 'runtime.changed', 'ai.halted'], 15_000);
  const { data: trophies } = useCore('fun.trophies', undefined, ['fun.trophy']);
  const { data: alertCounts } = useCore('alerts.counts', undefined, ['alerts.changed'], 60_000);
  const [forceOnboarding, setForceOnboarding] = useState(false);
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return localStorage.getItem('fbrx.sidebar') === 'icons';
    } catch {
      return false;
    }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem('fbrx.sidebar', v ? 'icons' : 'full');
    } catch {
      /* remembered for this session only */
    }
  };
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
  // A badge for the trophy case, with a way to go and look at it.
  useEffect(
    () =>
      onEvent('fun.trophy', (t) =>
        toast.custom({
          title: t.golden ? 'Golden Goose unlocked!' : `Trophy unlocked: ${t.name}`,
          body: t.golden ? 'You found every easter egg. From now on the goose wears a golden egg with a #1 ribbon.' : 'It is in your Trophy case (Settings → Trophy case).',
          icon: <TrophyBadge id={t.id} found size={36} />,
          action: { label: 'See trophy case', onClick: () => navigate('settings/trophies') },
        }),
      ),
    [toast],
  );
  const fun = funEnabled(settings?.settings);
  useKonami(
    fun,
    useCallback(() => {
      summonGoose();
      unlockTrophy('konami');
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
      // The first time, the trophy toast says where the badge went; after that the loom just spins.
      if (trophies?.unlocked.loom) toast.info('The loom spins', 'Weave, weave, weave.');
      unlockTrophy('loom');
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
    { id: 'home', label: 'FBRX Glass', icon: 'dashboard', section: 'Command' },
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
    { id: 'processes', label: 'Task Manager', icon: 'activity', section: 'Utilities' },
    { id: 'clipboard', label: 'Clipboard', icon: 'clipboard', section: 'Utilities' },
    { id: 'migrate', label: 'Copy & migrate', icon: 'copy', section: 'Utilities' },
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
  const groups: NavGroup[] = SECTIONS.map((g) => ({ ...g, items: nav.filter((i) => i.section === g.section) })).filter((g) => g.items.length > 0);
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
        return <NetworkPage advanced={advanced} easterEggs={fun} />;
      case 'files':
        return <FilesPage />;
      case 'processes':
        return <ProcessesPage />;
      case 'migrate':
        return <MigratePage />;
      case 'clipboard':
        return <ClipboardPage />;
      case 'terminal':
        return advanced ? <TerminalPage easterEggs={fun} /> : <AdvancedOnly title="Terminal" onEnable={() => setAdvanced(true)} locked={advancedLocked} />;
      case 'toolbox':
        return <ToolboxPage advanced={advanced} easterEggs={fun} />;
      case 'library':
        return <LibraryPage agentName={agentName} advanced={advanced} easterEggs={fun} />;
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
        return <DashboardPage status={status} agentName={agentName} easterEggs={fun} who={addressAs(s)} />;
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
        groups={groups}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        active={route}
        onNavigate={(id) => navigate(id)}
        topbar={<TopBar route={route} status={status} agentName={agentName} critical={alertCounts?.critical ?? 0} spotlightKey={s.spotlight.enabled ? s.spotlight.hotkey : null} advanced={advanced} advancedLocked={advancedLocked} onAdvanced={setAdvanced} defaultProvider={s.ai.defaultProvider} defaultModel={s.ai.defaultModel} />}
        footer={
          <span>
            {displayVersion(status.version)} · {status.license.edition}
            {status.devMode ? ' · dev' : ''}
            {advanced ? ' · advanced' : ''}
            {fun && trophies && Object.keys(trophies.unlocked).length > 0 && (
              <>
                {' · '}
                <button className="footer-trophies" onClick={() => navigate('settings/trophies')} title="Your trophy case">
                  <Icons.trophy size={11} /> {Object.keys(trophies.unlocked).filter((k) => k !== 'golden').length}
                </button>
              </>
            )}
          </span>
        }
      >
        <Suspense
          fallback={
            <div style={{ display: 'grid', placeItems: 'center', height: '40vh' }}>
              <Spinner />
            </div>
          }
        >
          {page}
        </Suspense>
      </Shell>
      <VaultStartPrompt />
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
      <button className="topbar-search" onClick={() => bridge.showSpotlight?.()} title="Spotlight: search apps, files, settings and more from anywhere">
        <Icons.search size={15} />
        <span>Search apps, files, settings, or ask {agentName}…</span>
        {spotlightKey && <kbd className="kbd">{spotlightKey.replace('CommandOrControl', 'Ctrl')}</kbd>}
      </button>
      {status.vault.state === 'locked' ? (
        <button className="status-link" onClick={() => navigate('vault')} title="Open the vault to unlock">
          <Status tone={status.vault.lockReason === 'keychain' ? 'warning' : 'neutral'}>Credentials locked</Status>
        </button>
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
      <UpdatePill />
      {status.aiHalt && <EmergencyStop compact />}
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

/**
 * The sidebar's sections, each with an FBRX name, an icon and plain words for what is inside. Pick a section to open
 * it; collapsed to icons, its pages slide out beside it.
 */
const SECTIONS: Array<{ id: string; section: string; label: string; hint: string; icon: IconName }> = [
  { id: 'bridge', section: 'Command', label: 'Bridge', hint: 'Glass, agent, alerts', icon: 'compass' },
  { id: 'studio', section: 'Workspace', label: 'Studio', hint: 'Tasks, notes, projects', icon: 'layers' },
  { id: 'pitstop', section: 'PC care', label: 'Pit Stop', hint: 'Storage, security, repairs', icon: 'wrench' },
  { id: 'workbench', section: 'Utilities', label: 'Workbench', hint: 'Files, tools, clipboard', icon: 'toolbox' },
  { id: 'orbit', section: 'Connect', label: 'Orbit', hint: 'Phone, mesh, AI models', icon: 'orbit' },
  { id: 'shield', section: 'Protect', label: 'Shield', hint: 'Approvals, keys, backups', icon: 'shield' },
  { id: 'lab', section: 'Advanced', label: 'Lab', hint: 'Terminal, virtual lab', icon: 'flask' },
  { id: 'control', section: 'System', label: 'Control', hint: 'Organization, settings', icon: 'settings' },
];

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
