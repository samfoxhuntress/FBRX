import { VERTICAL_NAMES } from '@fbrx/shared';
import { useEffect, useState } from 'react';
import { Button, Icons, Select, Shell, Spinner, type NavItem } from '@fbrx/ui';
import { api, session, setUnauthorizedHandler } from './api';
import { AppStateProvider, useApp, useRoute, type Me } from './state';
import { LoginPage, SetupPage } from './pages/login';
import { OverviewPage } from './pages/overview';
import { DevicesPage } from './pages/devices';
import { DeviceDetailPage } from './pages/device-detail';
import { ConfigPage } from './pages/config';
import { EnrollmentPage } from './pages/enrollment';
import { SecretsPage } from './pages/secrets';
import { ReleasesPage } from './pages/releases';
import { PackagesPage } from './pages/packages';
import { SnapshotsPage } from './pages/snapshots';
import { LicensesPage } from './pages/licenses';
import { TenantsPage } from './pages/tenants';
import { UsersPage } from './pages/users';
import { WebhooksPage } from './pages/webhooks';
import { AuditPage } from './pages/audit';
import { EventsPage } from './pages/events';
import { AccountPage } from './pages/account';
import { HelpdeskPage } from './pages/helpdesk';

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
      const st = await api<{ needsSetup: boolean }>('GET', '/v1/setup/status');
      if (st.needsSetup) return setPhase('setup');
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
  if (phase === 'setup') return <SetupPage onDone={() => setPhase('login')} />;
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
  const superadmin = app.me.principal.role === 'superadmin';
  const nav: NavItem[] = [
    { id: 'overview', label: 'Overview', icon: 'dashboard', section: 'Fleet' },
    { id: 'devices', label: 'Devices', icon: 'laptop', section: 'Fleet' },
    { id: 'events', label: 'Alerts & events', icon: 'activity', section: 'Fleet' },
    ...(app.can('helpdesk.read') ? [{ id: 'helpdesk', label: 'Help desk', icon: 'lifebuoy', section: 'Fleet' } as NavItem] : []),
    ...(app.can('config.manage') ? [{ id: 'config', label: 'Profiles & groups', icon: 'settings', section: 'Configuration' } as NavItem] : []),
    ...(app.can('enrollment.manage') ? [{ id: 'enrollment', label: 'Deploy & enroll', icon: 'download', section: 'Configuration' } as NavItem] : []),
    ...(app.can('secrets.manage') ? [{ id: 'secrets', label: 'Credentials', icon: 'key', section: 'Configuration' } as NavItem] : []),
    { id: 'packages', label: 'Plugins', icon: 'pkg', section: 'Configuration' },
    ...(app.can('snapshots.manage') ? [{ id: 'snapshots', label: 'Backups', icon: 'archive', section: 'Configuration' } as NavItem] : []),
    { id: 'releases', label: 'Releases', icon: 'upload', section: 'Platform' },
    ...(app.can('licenses.read') ? [{ id: 'licenses', label: 'Licenses', icon: 'tag', section: 'Platform' } as NavItem] : []),
    ...(superadmin ? [{ id: 'tenants', label: 'Tenants', icon: 'globe', section: 'Platform' } as NavItem] : []),
    ...(app.can('users.manage') ? [{ id: 'users', label: 'Users & API keys', icon: 'users', section: 'Access' } as NavItem] : []),
    ...(app.can('webhooks.manage') ? [{ id: 'webhooks', label: 'Webhooks', icon: 'link', section: 'Access' } as NavItem] : []),
    ...(app.can('audit.read') ? [{ id: 'audit', label: 'Audit log', icon: 'history', section: 'Access' } as NavItem] : []),
  ];
  const activeNav = route.page === 'device' ? 'devices' : route.page;
  const needsTenant = !app.tenantId && !['overview', 'tenants', 'releases', 'account', 'audit', 'licenses', 'devices', 'events', 'helpdesk'].includes(route.page);

  const page = (() => {
    if (needsTenant) return <div className="fx-page"><h1>Select a tenant</h1><p className="fx-secondary">Choose an organization in the top bar to manage its configuration.</p></div>;
    switch (route.page) {
      case 'devices':
        return <DevicesPage />;
      case 'device':
        return <DeviceDetailPage id={route.id!} />;
      case 'events':
        return <EventsPage />;
      case 'helpdesk':
        return <HelpdeskPage />;
      case 'config':
        return <ConfigPage />;
      case 'enrollment':
        return <EnrollmentPage />;
      case 'secrets':
        return <SecretsPage />;
      case 'packages':
        return <PackagesPage />;
      case 'snapshots':
        return <SnapshotsPage />;
      case 'releases':
        return <ReleasesPage />;
      case 'licenses':
        return <LicensesPage />;
      case 'tenants':
        return <TenantsPage />;
      case 'users':
        return <UsersPage />;
      case 'webhooks':
        return <WebhooksPage />;
      case 'audit':
        return <AuditPage />;
      case 'account':
        return <AccountPage />;
      default:
        return <OverviewPage />;
    }
  })();

  return (
    <Shell
      brandName="FBRX Command"
      brandSub="Tenant controller"
      nav={nav}
      active={activeNav}
      onNavigate={(id) => go(id)}
      footer={
        <span>
          FBRX Command {app.me.version} ·{' '}
          <span style={{ color: app.live ? 'var(--good-text)' : 'var(--text-muted)' }}>{app.live ? '● live' : '○ reconnecting'}</span>
        </span>
      }
      topbar={
        <>
          {superadmin ? (
            <div style={{ width: 260 }}>
              <Select
                aria-label="Tenant"
                value={app.tenantId ?? ''}
                onChange={(e) => app.setTenant(e.target.value || null)}
                options={[{ value: '', label: 'All tenants (platform view)' }, ...app.me.tenants.map((t) => ({ value: t.id, label: `${t.name} · ${VERTICAL_NAMES[t.vertical] ?? 'Work'}` }))]}
              />
            </div>
          ) : (
            <strong>{app.me.tenants[0]?.name}</strong>
          )}
          <span className="fx-spacer" />
          <ThemeToggle />
          <Button variant="ghost" onClick={() => go('account')}>
            <Icons.users size={16} />
            {app.me.user.name}
            <span className="fx-badge">{app.me.principal.role}</span>
          </Button>
          <Button variant="ghost" icon="logout" onClick={() => void app.logout()} aria-label="Sign out" title="Sign out" />
        </>
      }
    >
      {page}
    </Shell>
  );
}
