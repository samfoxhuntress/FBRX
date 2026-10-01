import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, connectLive, session, type LiveEvent } from './api';

export interface Me {
  principal: { kind: string; role: string; tenantId: string | null };
  user: { id: string; email: string; name: string; role: string; tenantId: string | null; mfaEnabled: boolean };
  tenants: Array<{ id: string; name: string; slug: string; status: string }>;
  permissions: string[];
  version: string;
}

interface AppState {
  me: Me;
  tenantId: string | null;
  setTenant: (id: string | null) => void;
  can: (perm: string) => boolean;
  live: boolean;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ me: initial, children, onLogout }: { me: Me; children: ReactNode; onLogout: () => void }) {
  const [me, setMe] = useState(initial);
  const [tenantId, setTenantId] = useState<string | null>(() => {
    const saved = session.tenant;
    let chosen: string | null;
    if (initial.principal.role !== 'superadmin') chosen = initial.principal.tenantId;
    else if (saved && initial.tenants.some((t) => t.id === saved)) chosen = saved;
    else chosen = initial.tenants[0]?.id ?? null;
    // Set synchronously: child queries fire before this provider's effects run.
    session.tenant = chosen;
    return chosen;
  });
  const [live, setLive] = useState(false);
  const subs = useRef(new Set<(e: LiveEvent) => void>());

  useEffect(() => connectLive((e) => subs.current.forEach((fn) => fn(e)), setLive), [tenantId]);

  const value: AppState = {
    me,
    tenantId,
    setTenant: (id) => {
      session.tenant = id;
      setTenantId(id);
    },
    can: (p) => me.permissions.includes(p),
    live,
    subscribe: (fn) => {
      subs.current.add(fn);
      return () => subs.current.delete(fn);
    },
    refreshMe: async () => setMe(await api<Me>('GET', '/v1/auth/me')),
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
  if (!v) throw new Error('useApp outside provider');
  return v;
}

/** Fetches JSON and re-fetches when deps change, when `reload()` is called, or on matching live events. */
export function useQuery<T>(path: string | null, deps: unknown[] = [], liveMatch?: (e: LiveEvent) => boolean) {
  const { subscribe, tenantId } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>('GET', path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, tenantId, ...deps]);
  useEffect(() => {
    if (!liveMatch) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return subscribe((e) => {
      if (!liveMatch(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 400);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, reload]);
  return { data, error, loading, reload, setData };
}

/** Hash router: `#/devices/dev_x` → { page: 'devices', id: 'dev_x' } */
export function useRoute(): [{ page: string; id: string | null }, (to: string) => void] {
  const parse = () => {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { page: parts[0] ?? 'overview', id: parts[1] ? decodeURIComponent(parts[1]) : null };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (to: string) => (location.hash = `#/${to}`)];
}
