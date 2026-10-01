import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreEventName, CoreMethod, CoreMethods } from '@fbrx/shared';
import { call, onAnyEvent } from './client';

type Params<M extends CoreMethod> = Parameters<CoreMethods[M]> extends [infer P] ? P : undefined;
type Result<M extends CoreMethod> = Awaited<ReturnType<CoreMethods[M]>>;

/** Calls a core method, keeps the result fresh on the given events (debounced) and on demand. */
export function useCore<M extends CoreMethod>(method: M, params?: Params<M>, events: CoreEventName[] = [], intervalMs?: number) {
  const [data, setData] = useState<Result<M> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(params ?? null);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const eventsKey = events.join(',');
  useEffect(() => {
    let cancelled = false;
    (call as (m: string, p?: unknown) => Promise<Result<M>>)(method, params)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key, tick]);
  useEffect(() => {
    if (!eventsKey) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const names = new Set(eventsKey.split(','));
    return onAnyEvent((n) => {
      if (!names.has(n)) return;
      if (t) clearTimeout(t);
      t = setTimeout(reload, 250);
    });
  }, [eventsKey, reload]);
  useEffect(() => {
    if (!intervalMs) return;
    const i = setInterval(reload, intervalMs);
    return () => clearInterval(i);
  }, [intervalMs, reload]);
  return { data, error, reload, setData };
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const i = setInterval(() => ref.current(), ms);
    return () => clearInterval(i);
  }, [ms]);
}

/** Whether a settings path is locked by the organisation. */
export function isLocked(locked: string[] | undefined, path: string) {
  return !!locked?.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`));
}
