import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { VirtualRole, VirtualUser } from '@fbrx/shared';
import { api, session } from './api';

export interface Me {
  user: VirtualUser;
  version: string;
  driver: 'libvirt' | 'simulated' | 'none';
  /** FBRX Server roles on this server (virtual, ai, gate, minidome). */
  roles: string[];
}

const RANK: Record<VirtualRole, number> = { viewer: 0, operator: 1, admin: 2 };

interface AppState {
  me: Me;
  can: (role: VirtualRole) => boolean;
  /** Whether this server has an FBRX Server role. */
  has: (role: string) => boolean;
  logout: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const value: AppState = {
    me,
    can: (role) => RANK[me.user.role] >= RANK[role],
    has: (role) => (me.roles ?? ['virtual']).includes(role),
    logout: async () => {
      await api('POST', '/v1/auth/logout').catch(() => undefined);
      session.token = null;
      onLogout();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside the console');
  return v;
}

export interface Route {
  page: string;
  id?: string;
  tab?: string;
}

function parse(): Route {
  const [page = 'overview', id, tab] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { page: page || 'overview', id, tab };
}

/** Pages live in the address (#/vms/<id>/console) so back, forward and bookmarks work. */
export function useRoute(): [Route, (page: string, id?: string, tab?: string) => void] {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (page: string, id?: string, tab?: string) => {
    location.hash = `/${[page, id, tab].filter(Boolean).map((p) => encodeURIComponent(p!)).join('/')}`;
  };
  return [route, go];
}

/** Polls an API path while the page is visible. */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (!path) return;
    try {
      setData(await api<T>('GET', path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setData(null);
    if (!path) return;
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ms]);
  return { data, error, reload: load };
}
