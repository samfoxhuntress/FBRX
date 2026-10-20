import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { NotificationEvent, PresenterStatus, SystemStatus, Tier } from '@fbrx/shared';
import { TIER_NAMES, TIER_SHORT, addressAs, atLeast, displayVersion, funEnabled } from '@fbrx/shared';
import { Button, FBRX_MARK, FbrxMark, Icons, Shell, Spinner, Status, useToast, type IconName, type NavGroup, type NavItem } from '@fbrx/ui';
import { bridge, call, onEvent } from './client';
import { playChime } from './notify-sound';
import { useConsoleSessions, useCore } from './hooks';
import { playStartupSound, useAppearance } from './theme';
import { AgentNameContext, EmergencyStop } from './widgets';
import { LocalAccountLock } from './account';
import { GooseOverlay, summonGoose, unlockTrophy, useKonami } from './fun';
import { TrophyBadge } from './trophies';
import { DashboardPage } from './pages/dashboard';
import { Onboarding } from './pages/onboarding';
import { VaultStartPrompt } from './vault-lock';
import { UpdatePill } from './release';
import { SpotlightView } from './pages/spotlight';
import { ClipPicker } from './pages/clip-picker';
import { LearnerContext, StandardOnly, TierContext, UltraOnly, VerticalContext, useLicenseTier } from './edition';
import { Tour, type TourStep } from './tour';
import { PresenterPill, usePresenter } from './presenter';
import { ContextMenuHost } from './context-menu';
import { MacroAddHost } from './macro-add';
import { FolderRequestHost } from './pages/governance-folders';

// Pages load when first opened, so the app starts with only what the first screen needs.
const AgentPage = lazy(() => import('./pages/agent').then((m) => ({ default: m.AgentPage })));
const HelpdeskPage = lazy(() => import('./pages/helpdesk').then((m) => ({ default: m.HelpdeskPage })));
const MessagesPage = lazy(() => import('./pages/messages').then((m) => ({ default: m.MessagesPage })));
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
const CalendarPage = lazy(() => import('./pages/calendar').then((m) => ({ default: m.CalendarPage })));
const SnippetsPage = lazy(() => import('./pages/snippets').then((m) => ({ default: m.SnippetsPage })));
const FilesPage = lazy(() => import('./pages/files').then((m) => ({ default: m.FilesPage })));
const ProcessesPage = lazy(() => import('./pages/processes').then((m) => ({ default: m.ProcessesPage })));
const TerminalPage = lazy(() => import('./pages/terminal').then((m) => ({ default: m.TerminalPage })));
const ToolboxPage = lazy(() => import('./pages/toolbox').then((m) => ({ default: m.ToolboxPage })));
const EssentialsHome = lazy(() => import('./pages/essentials-home').then((m) => ({ default: m.EssentialsHome })));
const LibraryPage = lazy(() => import('./pages/library').then((m) => ({ default: m.LibraryPage })));
const AlertsPage = lazy(() => import('./pages/alerts').then((m) => ({ default: m.AlertsPage })));
const StoragePage = lazy(() => import('./pages/storage').then((m) => ({ default: m.StoragePage })));
const NetworkPage = lazy(() => import('./pages/network').then((m) => ({ default: m.NetworkPage })));
const SecurityPage = lazy(() => import('./pages/security').then((m) => ({ default: m.SecurityPage })));
const ShieldPage = lazy(() => import('./pages/shield').then((m) => ({ default: m.ShieldPage })));
const UpdatesPage = lazy(() => import('./pages/updates').then((m) => ({ default: m.UpdatesPage })));
const BugsPage = lazy(() => import('./pages/bugs').then((m) => ({ default: m.BugsPage })));
const LabPage = lazy(() => import('./pages/lab').then((m) => ({ default: m.LabPage })));
const ServerPage = lazy(() => import('./pages/server').then((m) => ({ default: m.ServerPage })));
const MeshPage = lazy(() => import('./pages/mesh').then((m) => ({ default: m.MeshPage })));
const AiCoordPage = lazy(() => import('./pages/aicoord').then((m) => ({ default: m.AiCoordPage })));
const MigratePage = lazy(() => import('./pages/migrate').then((m) => ({ default: m.MigratePage })));
const ClipboardPage = lazy(() => import('./pages/clipboard').then((m) => ({ default: m.ClipboardPage })));
const BrowserApp = lazy(() => import('./pages/browser').then((m) => ({ default: m.BrowserApp })));

export type Route =
  | 'home'
  | 'agent'
  | 'alerts'
  | 'helpdesk'
  | 'messages'
  | 'tasks'
  | 'notes'
  | 'projects'
  | 'calendar'
  | 'snippets'
  | 'storage'
  | 'security'
  | 'shield'
  | 'updates'
  | 'bugs'
  | 'lab'
  | 'server'
  | 'network'
  | 'files'
  | 'processes'
  | 'migrate'
  | 'clipboard'
  | 'browser'
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
  | 'clips'
  | 'goose'
  | 'goose-overlay';

/** This window shows one page on its own, beside the main window (opened with "Open in a new window"). */
export const POPOUT = new URLSearchParams(location.search).has('popout');
/** This window is the FBRX Browser (its own window, opened from the sidebar or tray). */
export const BROWSER_WINDOW = new URLSearchParams(location.search).has('browser');
const popoutPage = location.hash.replace(/^#\/?/, '').split('/')[0];
/** Pages set to open in their own window (Settings → General → Windows); kept up to date by the main window. */
let ownWindows: Record<string, boolean> = {};

/** Navigates to a page; `to` may carry a sub-path such as `notes/note_123` or `settings/appearance`. */
export function navigate(to: string) {
  const page = to.split('/')[0];
  // The browser lives in its own window: opening it from the main window focuses that window, not a page here.
  if (page === 'browser' && !BROWSER_WINDOW && bridge.openBrowser) return bridge.openBrowser(to.split('/').slice(1).join('/') || undefined);
  // A popped-out page keeps to itself: links to other pages open in the main window.
  if (POPOUT && page !== popoutPage && bridge.openMain) return bridge.openMain(to);
  const here = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (!POPOUT && ownWindows[page] && page !== here && bridge.popOut) return void bridge.popOut(to);
  location.hash = `#/${to}`;
}

/** The part of the route after the page name (`notes/abc` → `abc`). */
export function routeArg(): string | null {
  return location.hash.replace(/^#\/?/, '').split('/').slice(1).join('/') || null;
}

/** Opens the chat the agent is working in (the first one, when it works in several). */
async function openWorkingChat() {
  const [first] = await call('ai.runs');
  navigate(first ? `agent/chat/${encodeURIComponent(first.conversationId)}` : 'agent');
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
function Splash({ tier }: { tier: Tier | undefined }) {
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
        <div className="splash-word">FBRX Endpoint</div>
        <div className="splash-sub">{tier ? TIER_SHORT[tier] : 'Fabrics Operating System'}</div>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { data: settings } = useCore('settings.get', undefined, ['settings.changed']);
  const tier = useLicenseTier();
  useAppearance(settings?.settings, tier);
  if (route === 'spotlight') return settings ? <SpotlightView agentName={settings.settings.ai.agentName} fun={funEnabled(settings.settings, tier)} /> : null;
  // The FBRX Browser runs in its own window (opened from the sidebar or tray): just the browser, no FBRX shell.
  if (BROWSER_WINDOW)
    return (
      <>
        <SupportBanner />
        <LocalAccountLock />
        <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Spinner /></div>}>
          {settings ? <BrowserApp agentName={settings.settings.ai.agentName} /> : null}
        </Suspense>
      </>
    );
  if (route === 'clips') return <ClipPicker />;
  if (route === 'goose-overlay') return <GooseOverlay />;
  return <MainApp route={route} settings={settings} />;
}

function MainApp({ route, settings }: { route: Route; settings: ReturnType<typeof useCore<'settings.get'>>['data'] }) {
  const toast = useToast();
  const { data: status } = useCore('system.status', undefined, ['service.changed', 'vault.changed', 'fleet.changed', 'license.changed', 'approval.requested', 'approval.resolved', 'runtime.changed', 'ai.halted', 'agent.runs'], 15_000);
  const { data: trophies } = useCore('fun.trophies', undefined, ['fun.trophy']);
  const { data: alertCounts } = useCore('alerts.counts', undefined, ['alerts.changed'], 60_000);
  // The Help desk tab's number: new tickets in the queue on a receiver, tickets waiting on you everywhere else.
  const hd = useCore('helpdesk.status', undefined, ['fleet.changed']).data;
  const hdList = useCore('helpdesk.tickets', { scope: hd?.receiver ? 'queue' : 'mine', state: 'open' }, ['helpdesk.changed', 'fleet.changed'], 300_000).data;
  const helpdeskCount = hd?.available ? (hdList ?? []).filter((t) => (hd.receiver ? t.status === 'open' : t.status === 'waiting')).length : 0;
  // Messages waiting to be read, on your mesh and in your organization.
  const messagesOn = settings?.settings.messages.enabled ?? true;
  const unreadMessages = useCore('messages.unread', undefined, ['messages.changed', 'mesh.changed', 'fleet.changed', 'settings.changed'], 120_000).data?.unread ?? 0;
  // FBRX Shield's number: findings waiting for a decision.
  const shieldCount = useCore('protection.status', undefined, ['protection.changed', 'shield.detected'], 300_000).data?.shield.open ?? 0;
  const [forceOnboarding, setForceOnboarding] = useState(false);
  // The Essentials walkthrough: closed for this window once finished or skipped; it waits for the start-up animation.
  const [tourClosed, setTourClosed] = useState(false);
  const [tourReady, setTourReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTourReady(true), sessionStorage.getItem('fbrx.splashShown') ? 600 : 2900);
    // Settings → Edition → Take the tour again.
    const again = () => setTourClosed(false);
    window.addEventListener('fbrx:tour', again);
    return () => {
      clearTimeout(t);
      window.removeEventListener('fbrx:tour', again);
    };
  }, []);
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
  // First start of this window: show the start-up animation and play the start-up sound once (not in a popped-out page).
  const [firstStart] = useState(() => !POPOUT && !sessionStorage.getItem('fbrx.splashShown'));
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
  const presenter = usePresenter();
  const presenting = useRef(presenter);
  presenting.current = presenter;
  useEffect(() => {
    const show = (n: NotificationEvent) => {
      // A message: one click opens the conversation (and none while it is already on screen).
      if (n.open) {
        if (location.hash === `#/${n.open}`) return;
        toast.info(n.title, n.body, { label: 'Open', onClick: () => navigate(n.open!) });
        return;
      }
      toast[n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : n.level === 'success' ? 'success' : 'info'](n.title, n.body);
    };
    // The desktop app decides where each notification shows (Alerts → Notifications) and sends this window its toasts.
    if (bridge.onToast) return bridge.onToast(show);
    // In a browser, every notification the core sends is a toast here.
    return onEvent('notification', (n) => {
      // Presenting: no pop-ups with private text on the projector; the alert inbox still has them.
      const p = presenting.current;
      if (p?.active && p.hideNotifications) {
        if (n.level === 'error') toast.error('FBRX needs your attention', 'Open Alerts when you have finished presenting.');
        return;
      }
      show(n);
    });
  }, [toast]);
  // FBRX's notification sound, played here once when the desktop app asks.
  useEffect(() => bridge.onChime?.((c) => playChime(c.level, c.volume)), []);
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
  const tier: Tier = status?.license.tier ?? 'basic';
  const ultra = atLeast(tier, 'ultra');
  const blackhole = atLeast(tier, 'blackhole');
  const fun = funEnabled(settings?.settings, tier);
  useEffect(() => {
    if (status) document.title = status.edition?.productName ?? TIER_NAMES[tier];
  }, [status, tier]);
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
  const agentName = s.ai.agentName;
  const enrolled = status.fleet.state !== 'unenrolled';
  // FBRX OS Education or Home (a student's or child's computer): a short list of friendly pages.
  const learner = !!status.edition?.learner;
  const vertical = status.edition?.vertical ?? 'business';
  const helpdeskShown = vertical !== 'home' || ultra;

  const all: Array<NavItem & { need?: Tier }> = [
    { id: 'home', label: 'FBRX Glass', icon: 'dashboard', section: 'Command' },
    { id: 'agent', label: agentName, icon: 'sparkles', section: 'Command' },
    { id: 'alerts', label: 'Alerts', icon: 'bell', count: alertCounts?.unread, section: 'Command' },
    // Chat with your other devices and the organization's (or family's) computers, in every edition.
    ...(messagesOn ? [{ id: 'messages', label: 'Messages', icon: 'message' as IconName, count: unreadMessages || undefined, section: 'Command' }] : []),
    // Once the computer belongs to an organization: tickets to IT (and, on receivers, everyone's tickets). At home,
    // Messages does that job, so the help desk stays with Endpoint Ultra (a parent's receiving computer, say).
    ...(enrolled && helpdeskShown ? [{ id: 'helpdesk', label: learner ? 'Get help' : 'Help desk', icon: 'lifebuoy' as IconName, count: helpdeskCount || undefined, section: 'Command' }] : []),
    { id: 'calendar', label: 'Calendar', icon: 'calendar', section: 'Workspace' },
    { id: 'tasks', label: 'Tasks', icon: 'tasks', section: 'Workspace' },
    { id: 'notes', label: 'Notes', icon: 'note', section: 'Workspace' },
    { id: 'projects', label: 'Projects', icon: 'layers', section: 'Workspace' },
    { id: 'snippets', label: 'Snippets', icon: 'code', section: 'Workspace' },
    { id: 'storage', label: 'Storage', icon: 'drive', section: 'PC care' },
    { id: 'security', label: 'Security', icon: 'lock', section: 'PC care' },
    { id: 'updates', label: 'Updates', icon: 'download', section: 'PC care' },
    { id: 'bugs', label: 'Bug catcher', icon: 'bug', section: 'PC care', need: 'ultra' },
    { id: 'network', label: 'Network Center', icon: 'network', section: 'PC care' },
    { id: 'browser', label: 'Browser', icon: 'globe', section: 'Utilities' },
    { id: 'files', label: 'Files', icon: 'folder', section: 'Utilities' },
    { id: 'processes', label: 'Task Manager', icon: 'activity', section: 'Utilities', need: 'ultra' },
    { id: 'clipboard', label: 'Clipboard', icon: 'clipboard', section: 'Utilities' },
    { id: 'migrate', label: 'Copy & migrate', icon: 'copy', section: 'Utilities', need: 'ultra' },
    { id: 'toolbox', label: 'Toolbox', icon: 'toolbox', section: 'Utilities' },
    { id: 'library', label: 'Library', icon: 'book', section: 'Utilities' },
    { id: 'mesh', label: 'Mesh & phone', icon: 'phone', section: 'Connect', need: 'ultra' },
    { id: 'runtime', label: 'AI models', icon: 'cpu', section: 'Connect' },
    { id: 'aicoord', label: 'AI coordination', icon: 'zap', section: 'Connect', need: 'ultra' },
    { id: 'connections', label: 'Connections', icon: 'link', section: 'Connect', need: 'ultra' },
    { id: 'tools', label: 'Tools & plugins', icon: 'wrench', section: 'Connect', need: 'ultra' },
    { id: 'shield', label: 'FBRX Shield', icon: 'shield', count: shieldCount || undefined, section: 'Protect' },
    { id: 'approvals', label: 'Approvals', icon: 'check', count: status.pendingApprovals, section: 'Protect' },
    { id: 'vault', label: 'Credentials', icon: 'key', section: 'Protect' },
    { id: 'governance', label: 'Governance', icon: 'shield', section: 'Protect', need: 'ultra' },
    { id: 'backup', label: 'Backup & restore', icon: 'archive', section: 'Protect' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', section: 'Advanced', need: 'ultra' },
    { id: 'lab', label: 'Virtual lab', icon: 'box', section: 'Advanced', need: 'ultra' },
    { id: 'server', label: 'FBRX Server', icon: 'server', section: 'Advanced', need: 'blackhole' },
    // Every edition sees its organization, or how to join one (Black Hole only ever comes through FBRX Command).
    { id: 'fleet', label: 'Organization', icon: 'globe', section: 'System' },
    { id: 'settings', label: 'Settings', icon: 'settings', section: 'System' },
  ];
  // Endpoint Essentials: the everyday pages in one short list (no sections to open). Standard: the everyday tools and
  // the agent. Ultra adds the expert ones, Black Hole the FBRX Server page. Student computers keep only LEARNER_PAGES.
  const essentials = tier === 'essentials' && !learner;
  const byId = new Map(all.map((i) => [i.id, i]));
  const nav: NavItem[] = essentials
    ? ESSENTIALS_NAV.flatMap(([id, section, label]) => {
        const item = byId.get(id);
        if (!item || (id === 'fleet' && !enrolled)) return [];
        const { need: _n, ...rest } = item;
        return [{ ...rest, section, ...(label ? { label } : {}) }];
      })
    : all
        .filter((i) => (learner ? LEARNER_PAGES.has(i.id) : !i.need || atLeast(tier, i.need)))
        .map(({ need: _n, ...i }) => (learner && i.id === 'home' ? { ...i, label: 'Home' } : i));
  const groups: NavGroup[] | undefined = essentials
    ? undefined
    : SECTIONS.map(({ basicHint, learnerHint, ...g }) => ({ ...g, hint: learner && learnerHint ? learnerHint : !ultra && basicHint ? basicHint : g.hint, items: nav.filter((i) => i.section === g.section) })).filter((g) => g.items.length > 0);
  const ultraOnly = (title: string, what: string) => <UltraOnly title={title} what={what} />;

  // The Essentials walkthrough, once, on a new computer (after the start-up animation).
  const tourSteps: TourStep[] = [
    {
      title: 'Welcome to FBRX Essentials',
      body: (
        <>
          <p>Your own AI, running on this computer. Here is a quick look around: well under a minute.</p>
          <p className="fx-muted">Esc skips it. Settings → Edition shows it again.</p>
        </>
      ),
    },
    {
      target: 'agent',
      title: agentName,
      body: (
        <>
          <p>Ask anything in plain words: “help me write a thank-you note”, “why is my computer slow?”, “explain this error”.</p>
          <p>Chats start offline, and {agentName} asks before it uses the internet or changes anything. Your earlier chats are kept here too.</p>
        </>
      ),
    },
    {
      target: 'runtime',
      title: 'AI models',
      body: 'The AI runs on this computer, starting with a small, quick model. Pick a bigger one here when you want more, or connect another AI.',
    },
    {
      target: 'settings',
      title: 'Settings',
      body: (
        <>
          <p><b>Memory</b> (what {agentName} remembers about you, on this computer only), <b>Voice</b> (talk instead of typing) and the look.</p>
          <p className="fx-muted"><b>Edition</b>: switch to Standard whenever you want everyday tools too (storage, antivirus, notes…), and back any time.</p>
        </>
      ),
    },
    {
      title: 'You’re all set',
      body: s.spotlight.enabled ? (
        <p>
          One more thing: press <kbd>{s.spotlight.hotkey}</kbd> anywhere to ask {agentName} without opening this window.
        </p>
      ) : (
        <p>Say hello to {agentName}.</p>
      ),
    },
  ];
  const showTour = !POPOUT && essentials && !tourClosed && status.edition?.tourDone === false && tourReady;
  // Terminal and chat in their own windows (Ultra has the Terminal; the chat is in every edition).
  ownWindows = POPOUT ? {} : { terminal: ultra && s.windows.terminal, agent: s.windows.agent };

  const page = (() => {
    // Essentials Home: the split-flap board and a few notes from FBRX (no dashboard).
    if (essentials && route === 'home') return <EssentialsHome status={status} agentName={agentName} who={addressAs(s)} />;
    if (essentials && !ESSENTIALS_PAGES.has(route) && route !== 'goose' && !byId.get(route)?.need) {
      return <StandardOnly title={byId.get(route)?.label ?? 'That page'} what={STANDARD_WHAT[route] ?? 'More of the everyday tools.'} />;
    }
    if (learner && route !== 'home' && !LEARNER_PAGES.has(route)) {
      return <UltraOnly title="That page" what={vertical === 'home' ? 'This computer keeps things simple. Ask a parent if you need something that is not here.' : 'Student computers keep things simple. Ask your teacher or the IT team if you need something that is not here.'} learner />;
    }
    switch (route) {
      case 'agent':
        return <AgentPage agentName={agentName} />;
      case 'helpdesk':
        if (enrolled && !helpdeskShown) return ultraOnly('The help desk', 'At home, Messages is the way to reach the family’s other computers. The help desk (tickets) comes with Endpoint Ultra.');
        return enrolled ? <HelpdeskPage learner={learner} /> : ultraOnly('The help desk', 'Join your organization’s FBRX Command and a Help desk tab appears here for sending problems to IT.');
      case 'messages':
        return <MessagesPage />;
      case 'alerts':
        return <AlertsPage />;
      case 'calendar':
        return <CalendarPage agentName={agentName} learner={learner} />;
      case 'tasks':
        return <TasksPage />;
      case 'notes':
        return <NotesPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'snippets':
        return <SnippetsPage />;
      case 'storage':
        return <StoragePage advanced={ultra} />;
      case 'shield':
        return <ShieldPage agentName={agentName} ultra={ultra} />;
      case 'security':
        return <SecurityPage advanced={ultra} />;
      case 'updates':
        return <UpdatesPage />;
      case 'bugs':
        return ultra ? <BugsPage agentName={agentName} advanced={ultra} /> : ultraOnly('The bug catcher', 'Crash and error logs from Windows and your apps, explained by the agent. Meanwhile, ask the agent what went wrong, or send it to your organization from Help desk.');
      case 'server':
        return blackhole ? <ServerPage /> : <UltraOnly need="blackhole" title="FBRX Server" what="The FBRX Server installer ISO, the bundle for a Debian 13 server you already have, and the guides." />;
      case 'lab':
        return ultra ? <LabPage /> : ultraOnly('The virtual lab', 'Test machines in Hyper-V or Windows Sandbox, with capacity gauges and one-click starts.');
      case 'network':
        return <NetworkPage advanced={ultra} everything={blackhole} easterEggs={fun} />;
      case 'files':
        return <FilesPage />;
      case 'processes':
        return ultra ? <ProcessesPage /> : ultraOnly('Task Manager', 'Running programs, live performance graphs and the event viewer, with the agent to explain them.');
      case 'migrate':
        return ultra ? <MigratePage /> : ultraOnly('Copy & migrate', 'Copy whole folders or move to a new computer with Robocopy or rsync, verified and resumable.');
      case 'clipboard':
        return <ClipboardPage />;
      case 'browser':
        // In the desktop app this opens its own window (see navigate); this inline view is the development fallback.
        return <BrowserApp agentName={agentName} />;
      case 'terminal':
        return ultra ? <TerminalPage easterEggs={fun} /> : ultraOnly('The Terminal', 'PowerShell, the command prompt and device consoles, with a code lab, commands and snippets beside them.');
      case 'toolbox':
        return <ToolboxPage advanced={ultra} easterEggs={fun} />;
      case 'library':
        return <LibraryPage agentName={agentName} everything={blackhole} easterEggs={fun} />;
      case 'mesh':
        return ultra ? <MeshPage /> : ultraOnly('Mesh & phone', 'Link your computers and your phone over an encrypted mesh, and reach FBRX from anywhere.');
      case 'aicoord':
        return ultra ? <AiCoordPage agentName={agentName} /> : ultraOnly('AI coordination', 'Let other AI apps on this computer (such as Claude) use FBRX tools safely, through MCP.');
      case 'approvals':
        return <ApprovalsPage />;
      case 'tools':
        return ultra ? <ToolsPage /> : ultraOnly('Tools & plugins', 'Choose which tools the agent may use, and add plugins.');
      case 'connections':
        return ultra ? <ConnectionsPage /> : ultraOnly('Connections', 'Connect REST services, webhooks and MCP servers to the agent.');
      case 'vault':
        return <VaultPage />;
      case 'governance':
        return ultra ? <GovernancePage /> : ultraOnly('Governance', 'Policies, the audit log and guardian review for everything the agent does.');
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

  const hosts = (
    <>
      <SupportBanner />
      <LocalAccountLock />
      <ContextMenuHost agentName={agentName} ultra={ultra} essentials={essentials} />
      <MacroAddHost />
      {!POPOUT && <FolderRequestHost />}
    </>
  );
  if (POPOUT)
    return (
      <TierContext.Provider value={tier}>
      <LearnerContext.Provider value={learner}>
      <VerticalContext.Provider value={vertical}>
      <AgentNameContext.Provider value={agentName}>
        <PopoutFrame title={byId.get(route)?.label ?? (route === 'agent' ? agentName : 'FBRX')}>
          <Suspense
            fallback={
              <div style={{ display: 'grid', placeItems: 'center', height: '40vh' }}>
                <Spinner />
              </div>
            }
          >
            {page}
          </Suspense>
        </PopoutFrame>
        {hosts}
      </AgentNameContext.Provider>
      </VerticalContext.Provider>
      </LearnerContext.Provider>
      </TierContext.Provider>
    );

  return (
    <TierContext.Provider value={tier}>
    <LearnerContext.Provider value={learner}>
    <VerticalContext.Provider value={vertical}>
    <AgentNameContext.Provider value={agentName}>
      {showSplash && <Splash tier={tier} />}
      <Shell
        brandName={
          learner ? (
            <>
              FBRX OS <span className="tier-badge student">{vertical === 'home' ? 'Home' : 'Education'}</span>
            </>
          ) : (
            <>
              FBRX Endpoint <span className={`tier-badge ${tier}`}>{TIER_SHORT[tier]}</span>
            </>
          )
        }
        brandSub={status.deviceName}
        onBrandClick={onBrandClick}
        brandClassName={weaving ? 'weaving' : undefined}
        nav={nav}
        groups={groups}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        active={route}
        onNavigate={(id) => navigate(id)}
        topbar={<TopBar route={route} status={status} agentName={agentName} critical={alertCounts?.critical ?? 0} spotlightKey={s.spotlight.enabled ? s.spotlight.hotkey : null} defaultProvider={s.ai.defaultProvider} defaultModel={s.ai.defaultModel} presenter={presenter} learner={learner} />}
        footer={
          <span>
            <span title={TIER_NAMES[tier]}>{displayVersion(status.version)}</span>
            {status.devMode ? ' · dev' : ''}
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
      {hosts}
      {showTour && (
        <Tour
          steps={tourSteps}
          onDone={() => {
            setTourClosed(true);
            void call('edition.tourDone', { done: true });
          }}
        />
      )}
    </AgentNameContext.Provider>
    </VerticalContext.Provider>
    </LearnerContext.Provider>
    </TierContext.Provider>
  );
}

/**
 * While a support pass is active, a bar across the top of every FBRX window says so and offers to end it — so nobody
 * forgets the computer is running with full access. The pass ends on its own when it runs out.
 */
function SupportBanner() {
  const { data: support } = useCore('support.status', undefined, ['support.changed']);
  if (!support?.active) return null;
  const until = support.until ? new Date(support.until).toLocaleString() : null;
  return (
    <div className="support-banner" role="status">
      <Icons.wrench size={14} />
      <span>
        Support mode is on{support.note ? ` — ${support.note}` : ''}. This computer is running with full access for troubleshooting{until ? `, until ${until}` : ''}.
      </span>
      <button onClick={() => void call('support.end').catch(() => undefined)}>End support</button>
    </div>
  );
}

/**
 * A page in a window of its own: a slim bar with its name, "Side by side" (FBRX on the left, this on the right), "Keep
 * on top", and the way back to FBRX, over the page itself.
 */
function PopoutFrame({ title, children }: { title: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    document.body.classList.add('popout');
    document.title = `${title} · FBRX`;
  }, [title]);
  return (
    <div className="popout-frame">
      <div className="popout-bar">
        <span className="popout-title">
          <FbrxMark size={18} /> {title}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" icon="sidebar" title="FBRX on the left, this window on the right" onClick={() => void bridge.popOutWindow?.('tile')}>
          Side by side
        </Button>
        <Button
          size="sm"
          variant={pinned ? 'primary' : 'ghost'}
          icon="layers"
          aria-pressed={pinned}
          title="Keep this window above other windows"
          onClick={() => {
            setPinned(!pinned);
            void bridge.popOutWindow?.('pin', !pinned);
          }}
        >
          Keep on top
        </Button>
        <Button size="sm" variant="ghost" icon="external" title="Bring the main FBRX window forward" onClick={() => void bridge.popOutWindow?.('main')}>
          FBRX
        </Button>
      </div>
      <div className="fx-content popout-content">{children}</div>
    </div>
  );
}

function TopBar({
  route,
  status,
  agentName,
  critical,
  spotlightKey,
  defaultProvider,
  defaultModel,
  presenter,
  learner,
}: {
  route: Route;
  status: SystemStatus;
  agentName: string;
  critical: number;
  spotlightKey: string | null;
  defaultProvider: string;
  defaultModel: string;
  presenter: PresenterStatus | null;
  learner: boolean;
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
      <PresenterPill status={presenter} />
      <UpdatePill />
      {status.aiHalt && <EmergencyStop compact />}
      {openConsoles > 0 && route !== 'terminal' && (
        <button className="model-pill console-pill" onClick={() => navigate('terminal/console')} title="Device consoles that are connected">
          <span className="dot ok" aria-hidden />
          {openConsoles} console{openConsoles > 1 ? 's' : ''}
        </button>
      )}
      {status.activeRuns > 0 && (
        <button className="model-pill working-pill" onClick={() => void openWorkingChat()} title={`See what ${agentName} is doing`}>
          <span className="fx-spinner" aria-hidden />
          {agentName} working
        </button>
      )}
      {status.pendingApprovals > 0 && (
        <Button size="sm" variant="primary" icon="shield" onClick={() => navigate('approvals')}>
          {status.pendingApprovals} approval{status.pendingApprovals > 1 ? 's' : ''} waiting
        </Button>
      )}
      {!learner && (
        <button className="model-pill" onClick={() => navigate('runtime')} title={p ? `${p.name}: ${p.available ? 'ready' : (p.message ?? 'not available')}. Click to choose a model.` : 'Choose a model'}>
          <span className={`dot ${p?.available ? 'ok' : 'bad'}`} aria-hidden />
          {model ? <span className="mono">{model}</span> : <span>{p?.name ?? 'Choose a model'}</span>}
        </button>
      )}
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
/** What a student's or child's computer (FBRX OS Education or Home) shows. */
const LEARNER_PAGES = new Set(['home', 'agent', 'messages', 'helpdesk', 'calendar', 'tasks', 'notes', 'toolbox', 'library', 'settings']);

/**
 * Endpoint Essentials is the AI on its own: the chat (with its history), the AI models, and Settings (memory, voice,
 * Spotlight, the edition). An organization's computer also gets its help desk and the Organization page. Its pages in
 * order, the short list's headings, and plainer names where they help.
 */
const ESSENTIALS_NAV: Array<[Route, string, string?]> = [
  ['home', 'Your AI', 'Home'],
  ['agent', 'Your AI'],
  ['runtime', 'Your AI', 'AI models'],
  ['helpdesk', 'Help & settings', 'Get help'],
  ['fleet', 'Help & settings'],
  ['settings', 'Help & settings'],
];
const ESSENTIALS_PAGES = new Set<string>(ESSENTIALS_NAV.map(([id]) => id));

/** What a Standard page does, said on its place in Essentials. */
const STANDARD_WHAT: Partial<Record<Route, string>> = {
  home: 'FBRX Glass: your computer at a glance, how it is doing and anything that needs you.',
  alerts: 'What FBRX keeps an eye on (space running low, a threat stopped, an update waiting), in one place.',
  messages: 'Chat with your other devices and your organization’s computers.',
  calendar: 'Your calendar, with your Outlook or Google account if you connect one.',
  tasks: 'Your to-do list, with reminders.',
  notes: 'Quick notes, kept on this computer.',
  projects: 'Group notes, tasks and chats by project.',
  snippets: 'Text you type again and again, a shortcut away.',
  storage: 'See what fills your disk and clear out what you don’t need, safely.',
  security: 'Windows and macOS security settings, checked and explained.',
  updates: 'Keeps this computer’s apps and system up to date.',
  network: 'Your connection: speed, Wi‑Fi and the devices on your network.',
  files: 'Find, preview and tidy files, with the agent to help.',
  clipboard: 'Everything you copied, with handy transforms (Ctrl+Alt+Z).',
  toolbox: 'Quick tools: password generator, unit converter, QR codes and more.',
  library: 'Short guides for everyday things: Wi‑Fi, printers, backups, and more.',
  shield: 'FBRX Shield, the antivirus: checks new downloads and keeps threats out.',
  approvals: 'What the agent asked to do, waiting for your yes or no.',
  vault: 'Saved passwords and keys the agent and connections use, encrypted.',
  backup: 'Snapshots of FBRX and images of the whole computer, to move or restore it.',
};

const SECTIONS: Array<{ id: string; section: string; label: string; hint: string; basicHint?: string; learnerHint?: string; icon: IconName }> = [
  { id: 'bridge', section: 'Command', label: 'Bridge', hint: 'Glass, agent, messages, alerts', learnerHint: 'Home, helper, messages', icon: 'compass' },
  { id: 'studio', section: 'Workspace', label: 'Studio', hint: 'Calendar, tasks, notes', learnerHint: 'Calendar, notes and to-dos', icon: 'layers' },
  { id: 'pitstop', section: 'PC care', label: 'Pit Stop', hint: 'Storage, security, repairs', icon: 'wrench' },
  { id: 'workbench', section: 'Utilities', label: 'Workbench', hint: 'Files, tools, clipboard', learnerHint: 'Tools and stories', icon: 'toolbox' },
  { id: 'orbit', section: 'Connect', label: 'Orbit', hint: 'Phone, mesh, AI models', basicHint: 'AI models', icon: 'orbit' },
  { id: 'stronghold', section: 'Protect', label: 'Stronghold', hint: 'Antivirus, approvals, keys, backups', icon: 'castle' },
  { id: 'lab', section: 'Advanced', label: 'Lab', hint: 'Terminal, virtual lab, FBRX Server', icon: 'flask' },
  { id: 'control', section: 'System', label: 'Control', hint: 'Organization, settings', basicHint: 'Settings, license', learnerHint: 'Settings', icon: 'settings' },
];

