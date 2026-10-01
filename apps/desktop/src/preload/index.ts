import { contextBridge, ipcRenderer } from 'electron';

/** The only bridge between the renderer and FBRX OS core. No Node APIs are exposed. */
const api = {
  async call(method: string, params?: unknown): Promise<unknown> {
    const r = await ipcRenderer.invoke('fbrx:call', method, params ?? {});
    if (!r?.ok) throw new Error(r?.error?.message ?? 'Request failed');
    return r.result;
  },
  on(cb: (event: string, payload: unknown) => void): () => void {
    const h = (_e: unknown, name: string, payload: unknown) => cb(name, payload);
    ipcRenderer.on('fbrx:event', h);
    return () => ipcRenderer.removeListener('fbrx:event', h);
  },
  onNavigate(cb: (route: string) => void): () => void {
    const h = (_e: unknown, route: string) => cb(route);
    ipcRenderer.on('fbrx:navigate', h);
    return () => ipcRenderer.removeListener('fbrx:navigate', h);
  },
  dialog: (opts: { kind: 'file' | 'folder' | 'save'; title?: string; filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string }) => ipcRenderer.invoke('fbrx:dialog', opts) as Promise<string | null>,
  reveal: (path: string) => ipcRenderer.invoke('fbrx:reveal', path),
  openExternal: (url: string) => ipcRenderer.invoke('fbrx:openExternal', url),
  appInfo: () => ipcRenderer.invoke('fbrx:app'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('fbrx', api);
export type FbrxBridge = typeof api;
