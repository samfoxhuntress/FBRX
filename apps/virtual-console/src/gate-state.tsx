import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { checkConfig, type GateCommit, type GateConfig, type GateIssue, type GateLive, type GateState } from '@fbrx/gate';
import { Button, useToast } from '@fbrx/ui';
import { api, ApiError } from './api';
import { useApp, useRoute } from './state';

/** FBRX Gate as the console sees it: what runs, what is being edited, and the live picture. */
export interface GateInfo {
  mode: 'linux' | 'simulated';
  state: GateState;
  notes: string[];
}

/** Bytes per second in and out of a port, from the last two live samples. */
export interface Rate {
  rx: number;
  tx: number;
}

interface GateCtx {
  info: GateInfo | null;
  error: string | null;
  live: GateLive | null;
  rates: Record<string, Rate>;
  /** The internet port's rates over the last few minutes. */
  wanHistory: Array<{ t: number } & Rate>;
  reload: () => Promise<void>;
  /** Replaces what is being edited; nothing changes on the network until a commit. Returns false when refused. */
  save: (next: GateConfig, success?: string) => Promise<boolean>;
  /** Edits a copy of the candidate and saves it. */
  edit: (fn: (c: GateConfig) => void, success?: string) => Promise<boolean>;
  /** After an action that returns the new state (commit, confirm, roll back). */
  setState: (state: GateState, notes?: string[]) => void;
}

const Ctx = createContext<GateCtx | null>(null);

export function GateProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const toast = useToast();
  const enabled = app.has('gate');
  const [info, setInfo] = useState<GateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<GateLive | null>(null);
  const [rates, setRates] = useState<Record<string, Rate>>({});
  const [wanHistory, setWanHistory] = useState<Array<{ t: number } & Rate>>([]);
  const prev = useRef<GateLive | null>(null);
  const infoRef = useRef<GateInfo | null>(null);
  infoRef.current = info;

  const reload = async () => {
    try {
      setInfo(await api<GateInfo>('GET', '/v1/gate'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadLive = async () => {
    try {
      const l = await api<GateLive>('GET', '/v1/gate/live');
      const p = prev.current;
      if (p) {
        const dt = (Date.parse(l.at) - Date.parse(p.at)) / 1000;
        if (dt > 0) {
          const next: Record<string, Rate> = {};
          for (const i of l.interfaces) {
            const o = p.interfaces.find((x) => x.name === i.name);
            if (o) next[i.name] = { rx: Math.max(0, (i.rxBytes - o.rxBytes) / dt), tx: Math.max(0, (i.txBytes - o.txBytes) / dt) };
          }
          setRates(next);
          const wan = infoRef.current?.state.running?.wan.interface;
          if (wan && next[wan]) setWanHistory((h) => [...h.slice(-59), { t: Date.parse(l.at), ...next[wan] }]);
        }
      }
      prev.current = l;
      setLive(l);
    } catch {
      /* the live picture is best effort */
    }
  };

  useEffect(() => {
    if (!enabled) return;
    void reload();
    void loadLive();
    const a = setInterval(() => document.visibilityState === 'visible' && void reload(), 10000);
    const b = setInterval(() => document.visibilityState === 'visible' && void loadLive(), 3000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const save = async (next: GateConfig, success?: string) => {
    try {
      const r = await api<{ check: { ok: boolean; errors: GateIssue[] }; state: GateState }>('PUT', '/v1/gate/candidate', { config: next });
      setInfo((i) => (i ? { ...i, state: r.state } : i));
      if (success) toast.success(success, r.check.ok ? 'Not on the network yet: commit when you are ready.' : `Saved with ${r.check.errors.length} problem${r.check.errors.length === 1 ? '' : 's'} to fix before a commit.`);
      return true;
    } catch (e) {
      const issues = e instanceof ApiError ? e.issues : [];
      toast.error((e as Error).message, issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join(' · ') || undefined);
      return false;
    }
  };

  const value: GateCtx = {
    info,
    error,
    live,
    rates,
    wanHistory,
    reload,
    save,
    edit: async (fn, success) => {
      const cur = infoRef.current?.state.candidate;
      if (!cur) return false;
      const copy = structuredClone(cur);
      fn(copy);
      return save(copy, success);
    },
    setState: (state, notes) => setInfo((i) => (i ? { ...i, state, notes: notes ?? i.notes } : i)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGate(): GateCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useGate outside the console');
  return v;
}

/** Problems a draft would have, for showing next to the fields of what is being edited. */
export function draftIssues(draft: GateConfig, match: (path: string, message: string) => boolean): { errors: GateIssue[]; warnings: GateIssue[]; shapeOk: boolean } {
  const c = checkConfig(draft);
  return { errors: c.errors.filter((i) => match(i.path, i.message)), warnings: c.warnings.filter((i) => match(i.path, i.message)), shapeOk: !!c.config };
}

/** "networks.2.dhcp.start" or "networks.guest.dhcp" belongs to the item at that index or with that name. */
export const inItem = (list: string, index: number, name: string) => (path: string) => path === list || path.startsWith(`${list}.${index}.`) || path === `${list}.${index}` || path.startsWith(`${list}.${name}.`) || path === `${list}.${name}`;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Across every page: a commit on trial (it undoes itself unless someone keeps it), and edits not committed yet.
 */
export function GateBanner() {
  const app = useApp();
  const g = useGate();
  const [route, go] = useRoute();
  const toast = useToast();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = g.info?.state.confirm ?? null;
  useEffect(() => {
    if (!confirm) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [confirm]);
  if (!g.info) return null;
  const s = g.info.state;
  const act = async (key: string, path: string, done: string) => {
    setBusy(key);
    try {
      const r = await api<{ commit: GateCommit; state: GateState; notes?: string[] }>('POST', path, {});
      g.setState(r.state, r.notes);
      toast.success(done);
    } catch (e) {
      toast.error('Something went wrong', (e as Error).message);
      void g.reload();
    } finally {
      setBusy(null);
    }
  };
  if (confirm) {
    const left = Date.parse(confirm.deadline) - now;
    return (
      <div className="gt-banner trial" role="status">
        <span className="gt-banner-clock mono">{mmss(left)}</span>
        <span className="gt-banner-text">
          <b>Commit {confirm.commitId} is on trial.</b> It undoes itself when the time runs out, so a change that cuts you off puts itself back. Still reaching the gate? Keep it.
        </span>
        {app.can('admin') && (
          <>
            <Button variant="primary" icon="check" loading={busy === 'keep'} onClick={() => void act('keep', '/v1/gate/confirm', `Commit ${confirm.commitId} kept`)}>
              Keep it
            </Button>
            <Button icon="history" loading={busy === 'undo'} onClick={() => void act('undo', '/v1/gate/confirm/undo', `Commit ${confirm.commitId} rolled back`)}>
              Roll back now
            </Button>
          </>
        )}
      </div>
    );
  }
  if (s.changes.length && route.page !== 'gate-changes' && app.can('admin'))
    return (
      <div className="gt-banner" role="status">
        <span className="gt-banner-text">
          <b>
            {s.changes.length} change{s.changes.length === 1 ? '' : 's'} not on the network yet
          </b>
          {s.errors.length ? ` · ${s.errors.length} problem${s.errors.length === 1 ? '' : 's'} to fix first` : ''}
        </span>
        <Button variant="primary" icon="diff" onClick={() => go('gate-changes')}>
          Review & commit
        </Button>
      </div>
    );
  return null;
}
