import { useEffect, useState } from 'react';
import type { SystemStatus } from '@fbrx/shared';
import { Button, Shell, Spinner, Status, useToast, type NavItem } from '@fbrx/ui';
import { bridge, onEvent } from './client';
import { useCore } from './hooks';
import { HomePage } from './pages/home';
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

export type Route = 'home' | 'agent' | 'approvals' | 'tools' | 'connections' | 'vault' | 'governance' | 'runtime' | 'backup' | 'fleet' | 'settings';

export function navigate(to: Route) {
  location.hash = `#/${to}`;
}

function useRoute(): Route {
  const parse = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home') as Route;
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    const off = bridge.onNavigate?.((to) => navigate(to as Route));
    return () => {
      window.removeEventListener('hashchange', on);
      off?.();
    };
  }, []);
  return r;
}

function useTheme() {
  const { data } = useCore('settings.get', undefined, ['settings.changed']);
  const theme = data?.settings.general.theme ?? 'system';
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return data;
}

export function App() {
  const route = useRoute();
  const settings = useTheme();
  const toast = useToast();
  const { data: status } = useCore('system.status', undefined, ['service.changed', 'vault.changed', 'fleet.changed', 'license.changed', 'approval.requested', 'approval.resolved', 'runtime.changed'], 15_000);
  const [forceOnboarding, setForceOnboarding] = useState(false);

  useEffect(() => onEvent('notification', (n) => toast[n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : n.level === 'success' ? 'success' : 'info'](n.title, n.body)), [toast]);

  if (!settings || !status) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  if (!settings.settings.general.onboardingComplete || forceOnboarding) {
    return <Onboarding status={status} onDone={() => setForceOnboarding(false)} />;
  }

  const nav: NavItem[] = [
    { id: 'home', label: 'Command center', icon: 'dashboard', section: 'Workspace' },
    { id: 'agent', label: 'AI agent', icon: 'sparkles', section: 'Workspace' },
    { id: 'approvals', label: 'Approvals', icon: 'shield', count: status.pendingApprovals, section: 'Workspace' },
    { id: 'tools', label: 'Tools & plugins', icon: 'wrench', section: 'Extend' },
    { id: 'connections', label: 'Connections', icon: 'link', section: 'Extend' },
    { id: 'runtime', label: 'AI models', icon: 'cpu', section: 'Extend' },
    { id: 'vault', label: 'Vault', icon: 'key', section: 'Protect' },
    { id: 'governance', label: 'Governance', icon: 'shield', section: 'Protect' },
    { id: 'backup', label: 'Backup & restore', icon: 'archive', section: 'Protect' },
    { id: 'fleet', label: 'Organisation', icon: 'globe', section: 'System' },
    { id: 'settings', label: 'Settings', icon: 'settings', section: 'System' },
  ];

  const page = (() => {
    switch (route) {
      case 'agent':
        return <AgentPage />;
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
        return <HomePage status={status} />;
    }
  })();

  return (
    <Shell
      brandSub={status.deviceName}
      nav={nav}
      active={route}
      onNavigate={(id) => navigate(id as Route)}
      topbar={<TopBar status={status} />}
      footer={
        <span>
          v{status.version} · {status.license.edition}
          {status.devMode ? ' · dev' : ''}
        </span>
      }
    >
      {page}
    </Shell>
  );
}

function TopBar({ status }: { status: SystemStatus }) {
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
      <span className="fx-muted" style={{ fontSize: 12 }}>
        {status.fleet.state === 'unenrolled' ? 'Standalone' : `${status.fleet.tenantName ?? 'Organisation'} · ${status.fleet.state}`}
      </span>
      <span className="fx-spacer" />
      {status.activeRuns > 0 && <Status tone="busy">Agent working</Status>}
      {status.pendingApprovals > 0 && (
        <Button size="sm" variant="primary" icon="shield" onClick={() => navigate('approvals')}>
          {status.pendingApprovals} approval{status.pendingApprovals > 1 ? 's' : ''} waiting
        </Button>
      )}
      <Button size="sm" variant="ghost" icon="sparkles" onClick={() => navigate('agent')}>
        Ask FBRX
      </Button>
    </>
  );
}
