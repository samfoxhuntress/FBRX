import { useEffect, useState } from 'react';
import { Button, Icons, Shell, Spinner, type NavItem } from '@fbrx/ui';
import { api, session, setUnauthorizedHandler } from './api';
import { AppStateProvider, useApp, useRoute, type Me } from './state';
import { LoginPage, SetupPage } from './pages/login';
import { OverviewPage } from './pages/overview';
import { VmsPage } from './pages/vms';
import { VmDetailPage } from './pages/vm-detail';
import { StoragePage } from './pages/storage';
import { NetworksPage } from './pages/networks';
import { HardwarePage } from './pages/hardware';
import { ServerPage } from './pages/server';
import { AccessPage } from './pages/access';

export function App() {
  const [phase, setPhase] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [me, setMe] = useState<Me | null>(null);

  const boot = async () => {
    setUnauthorizedHandler(() => {
      session.token = null;
      setMe(null);
      setPhase('login');
    });
    try {
      const st = await api<{ needed: boolean }>('GET', '/v1/setup');
      if (st.needed) return setPhase('setup');
      if (!session.token) return setPhase('login');
      setMe(await api<Me>('GET', '/v1/auth/me'));
      setPhase('ready');
    } catch {
      setPhase('login');
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  if (phase === 'loading')
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );
  if (phase === 'setup') return <SetupPage onDone={() => void boot()} />;
  if (phase === 'login' || !me) return <LoginPage onLogin={() => void boot()} />;
  return (
    <AppStateProvider me={me} onLogout={() => setPhase('login')}>
      <Console />
    </AppStateProvider>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'system');
  const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
  return (
    <Button
      variant="ghost"
      icon={theme === 'dark' ? 'moon' : 'sun'}
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Theme: ${theme}`}
      onClick={() => {
        if (next === 'system') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('fbrx.theme', next);
        } catch {
          /* ignore */
        }
        setTheme(next);
      }}
    />
  );
}

function Console() {
  const app = useApp();
  const [route, go] = useRoute();
  const nav: NavItem[] = [
    { id: 'overview', label: 'Overview', icon: 'dashboard', section: 'Virtual' },
    { id: 'vms', label: 'Virtual machines', icon: 'layers', section: 'Virtual' },
    { id: 'storage', label: 'Storage & ISOs', icon: 'drive', section: 'Virtual' },
    { id: 'networks', label: 'Networks', icon: 'network', section: 'Virtual' },
    { id: 'hardware', label: 'Hardware map', icon: 'cpu', section: 'Server' },
    { id: 'server', label: 'Server & BIOS', icon: 'server', section: 'Server' },
    ...(app.can('admin') ? [{ id: 'access', label: 'Users & audit', icon: 'users', section: 'Access' } as NavItem] : []),
  ];
  const active = route.page === 'vm' ? 'vms' : route.page;
  const page = (() => {
    switch (route.page) {
      case 'vms':
        return <VmsPage />;
      case 'vm':
        return <VmDetailPage id={route.id!} tab={route.tab} />;
      case 'storage':
        return <StoragePage />;
      case 'networks':
        return <NetworksPage />;
      case 'hardware':
        return <HardwarePage />;
      case 'server':
        return <ServerPage tab={route.id} />;
      case 'access':
        return <AccessPage />;
      default:
        return <OverviewPage />;
    }
  })();
  return (
    <Shell
      brandName="FBRX Virtual"
      brandSub="FBRX Server · powered by FBRX OS"
      nav={nav}
      active={active}
      onNavigate={(id) => go(id)}
      footer={
        <span>
          FBRX Virtual {app.me.version} · {app.me.driver === 'simulated' ? 'simulated' : 'KVM / libvirt'}
        </span>
      }
      topbar={
        <>
          {app.me.driver === 'simulated' && <span className="fx-badge" title="No hypervisor on this computer: the virtual machines are pretend">Simulated</span>}
          <span className="fx-spacer" />
          <ThemeToggle />
          <Button variant="ghost" onClick={() => go('access')} disabled={!app.can('admin')} title="Your account">
            <Icons.users size={16} />
            {app.me.user.name}
            <span className="fx-badge">{app.me.user.role}</span>
          </Button>
          <Button variant="ghost" icon="logout" onClick={() => void app.logout()} aria-label="Sign out" title="Sign out" />
        </>
      }
    >
      {page}
    </Shell>
  );
}
