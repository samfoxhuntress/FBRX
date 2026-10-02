import type { CoreEventName, CoreEvents, CoreMethod, CoreMethods } from '@fbrx/shared';

type Result<M extends CoreMethod> = Awaited<ReturnType<CoreMethods[M]>>;

export interface DialogOptions {
  kind: 'file' | 'folder' | 'save';
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultPath?: string;
}

interface Bridge {
  kind: 'electron' | 'http';
  platform: string;
  call(method: string, params?: unknown): Promise<unknown>;
  on(cb: (event: string, payload: unknown) => void): () => void;
  onNavigate?(cb: (route: string) => void): () => void;
  dialog?(opts: DialogOptions): Promise<string | null>;
  reveal?(path: string): Promise<unknown>;
  openExternal?(url: string): Promise<unknown>;
  appInfo?(): Promise<{ version: string; platform: string; arch: string; dataDir: string; packaged: boolean } | null>;
  /** Spotlight window helpers (Electron only). */
  showSpotlight?(): void;
  spotlightHide?(): void;
  openMain?(route: string): void;
  copyText?(text: string): Promise<void>;
  /** The Silly Goose overlay window (Electron only). */
  goose?(action: 'summon' | 'leave' | 'interactive' | 'capture', on?: boolean): Promise<unknown> | void;
  /** Where the goose's beak is while it holds the pointer (moves the real pointer on Windows). */
  gooseDrag?(x: number, y: number): void;
  onGoose?(cb: (e: { type: 'cursor'; x: number; y: number } | { type: 'honk' } | { type: 'shoo' }) => void): () => void;
  /** Clipboard history, kept in memory by the desktop app (Electron only). */
  clip?(action: 'list' | 'read' | 'remove' | 'pin' | 'clear', id?: number, on?: boolean): Promise<unknown>;
  onClips?(cb: (entries: unknown) => void): () => void;
  /** Code lab: runs JavaScript in a hidden, network-blocked window (Electron only). */
  runCode?(code: string, inputs: string[]): Promise<unknown>;
  stopCode?(): Promise<unknown>;
}

export interface ClipEntry {
  id: number;
  text: string;
  at: string;
  pinned: boolean;
}
export interface CodeRunResult {
  lines: Array<{ level: 'log' | 'info' | 'warn' | 'error'; text: string }>;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
}

/** Reads the clipboard as text: through the desktop app, or the browser's clipboard API in development. */
export async function readClipboard(): Promise<string> {
  if (bridge.clip) return String((await bridge.clip('read')) ?? '');
  return navigator.clipboard.readText().catch(() => '');
}

/** Puts text on the clipboard. */
export async function writeClipboard(text: string): Promise<void> {
  if (bridge.copyText) await bridge.copyText(text);
  else await navigator.clipboard.writeText(text);
}

export async function clipHistory(action: 'list' | 'remove' | 'pin' | 'clear' = 'list', id?: number, on?: boolean): Promise<{ enabled: boolean; entries: ClipEntry[] } | null> {
  if (!bridge.clip) return null;
  return (await bridge.clip(action, id, on)) as { enabled: boolean; entries: ClipEntry[] } | null;
}

declare global {
  interface Window {
    fbrx?: Omit<Bridge, 'kind'>;
  }
}

/**
 * Development fallback: drive a headless core through its Local API (`?api=http://127.0.0.1:47821&token=…`).
 * Methods reserved for a person at the workstation are refused over this channel by design.
 */
function httpBridge(): Bridge {
  const q = new URLSearchParams(location.search);
  const base = q.get('api') ?? 'http://127.0.0.1:47821';
  const token = q.get('token') ?? '';
  return {
    kind: 'http',
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux',
    async call(method, params) {
      const res = await fetch(`${base}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params: params ?? {} }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      return body.result;
    },
    on(cb) {
      const es = new EventSource(`${base}/v1/events?token=${encodeURIComponent(token)}`);
      const names: CoreEventName[] = ['agent', 'approval.requested', 'approval.resolved', 'service.changed', 'vault.changed', 'audit.appended', 'runtime.changed', 'runtime.download', 'settings.changed', 'policy.changed', 'plugins.changed', 'connectors.changed', 'tools.changed', 'fleet.changed', 'license.changed', 'updates.changed', 'notification', 'workspace.changed', 'alerts.new', 'alerts.changed', 'mesh.changed', 'mesh.message', 'fun.trophy', 'ai.halted', 'migrate.event', 'ai.quick'];
      for (const n of names) es.addEventListener(n, (e) => cb(n, JSON.parse((e as MessageEvent).data)));
      return () => es.close();
    },
  };
}

export const bridge: Bridge = window.fbrx ? { kind: 'electron', ...window.fbrx } : httpBridge();

export function call<M extends CoreMethod>(method: M, ...args: Parameters<CoreMethods[M]>): Promise<Result<M>> {
  return bridge.call(method, args[0]) as Promise<Result<M>>;
}

type Listener = (name: CoreEventName, payload: unknown) => void;
const listeners = new Set<Listener>();
let detach: (() => void) | null = null;

export function onAnyEvent(fn: Listener): () => void {
  listeners.add(fn);
  if (!detach) detach = bridge.on((name, payload) => listeners.forEach((l) => l(name as CoreEventName, payload)));
  return () => {
    listeners.delete(fn);
  };
}

export function onEvent<E extends CoreEventName>(name: E, cb: (payload: CoreEvents[E]) => void): () => void {
  return onAnyEvent((n, p) => n === name && cb(p as CoreEvents[E]));
}

export async function pickFile(opts: DialogOptions): Promise<string | null> {
  if (bridge.dialog) return bridge.dialog(opts);
  return window.prompt(`${opts.title ?? 'Path'} (enter an absolute path)`) || null;
}

export function openExternal(url: string) {
  if (bridge.openExternal) void bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
