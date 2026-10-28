import { useEffect, useState } from 'react';
import { api } from './api';

/** The server's FBRX core (the "ai" role), reached through FBRX Virtual: installed, and answering. */
export interface CoreState {
  installed: boolean;
  running: boolean;
  version: string | null;
  error: string | null;
}

/** Calls a method of the server's FBRX core (FBRX Virtual checks the role it needs). */
export const coreCall = async <T,>(method: string, params?: unknown): Promise<T> => (await api<{ result: T }>('POST', '/v1/core/call', { method, params })).result;

/** Polls a core method while the page is open. */
export function useCore<T>(method: string | null, ms: number, params?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params ?? null);
  const load = async () => {
    if (!method) return;
    try {
      setData(await coreCall<T>(method, params));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!method) return;
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, ms, key]);
  return { data, error, reload: load, set: setData };
}
