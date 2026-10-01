/** Admin console API client: session token, tenant scope, JSON + binary helpers, live WebSocket. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'fbrx.console.token';
const TENANT_KEY = 'fbrx.console.tenant';

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store: Storage, key: string, value: string | null) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export const session = {
  get token() {
    return safeGet(sessionStorage, TOKEN_KEY);
  },
  set token(v: string | null) {
    safeSet(sessionStorage, TOKEN_KEY, v);
  },
  get tenant() {
    return safeGet(localStorage, TENANT_KEY);
  },
  set tenant(v: string | null) {
    safeSet(localStorage, TENANT_KEY, v);
  },
};

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { raw?: Blob | ArrayBuffer; tenant?: string | null; contentType?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const tenant = opts.tenant !== undefined ? opts.tenant : session.tenant;
  if (tenant) headers['x-fbrx-tenant'] = tenant;
  let payload: BodyInit | undefined;
  if (opts.raw) {
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
    payload = opts.raw as BodyInit;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (res.status === 401 && !path.startsWith('/v1/auth/login') && !path.startsWith('/v1/setup')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

/** Downloads an authenticated file (snapshots etc.) via a blob URL. */
export async function download(path: string, fileName: string) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${session.token}`, ...(session.tenant ? { 'x-fbrx-tenant': session.tenant } : {}) } });
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
  saveBlob(await res.blob(), fileName);
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type LiveEvent =
  | { type: 'hello'; at: string }
  | { type: 'device.online' | 'device.offline'; deviceId: string; tenantId: string }
  | { type: 'device.updated'; deviceId: string; tenantId: string; summary: any }
  | { type: 'command.updated'; tenantId: string; command: any }
  | { type: 'device.event'; tenantId: string; event: any }
  | { type: 'audit'; tenantId: string | null; entry: any };

/** Live admin event stream with automatic reconnect. */
export function connectLive(onEvent: (e: LiveEvent) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  const open = () => {
    if (closed || !session.token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ token: session.token });
    if (session.tenant) q.set('tenantId', session.tenant);
    ws = new WebSocket(`${proto}://${location.host}/v1/admin/ws?${q}`);
    ws.onopen = () => {
      delay = 1000;
      onState(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) setTimeout(open, (delay = Math.min(delay * 2, 30_000)));
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
